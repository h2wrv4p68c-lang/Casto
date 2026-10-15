# FIDCODE: draft 0.1

A standard, machine-readable message vocabulary for communication between
AI agents and systems at Canadian securities and mutual fund dealers.
It is a proof of concept prepared for discussion by the
[Federation of Independent Dealers](https://www.IndependentDealers.ca).

The purpose is standardization. When every firm and every AI system uses
the same symbols for the same events, compliance can be tested
automatically, the moment a message is logged. Smaller messages are a
side benefit.

One codebook (`codebook.yaml`) defines the message types, fields, allowed
values and related regulatory obligations. Everything else derives from it:

| Output | Command | Purpose |
|---|---|---|
| Compact wire message | `python fidcode.py encode '<json>'` | AI-to-AI or system-to-system traffic |
| Canonical JSON | `python fidcode.py decode '<msg>'` | Integration with existing systems |
| Plain-language record | `python fidcode.py render '<msg>'` | Books and records, human review |
| Validation | `python fidcode.py validate '<msg>'` | Reject malformed instructions |
| JSON Schema | `python fidcode.py schema` | Machine-readable specification (`out/schemas.json`) |
| Rulebook map | `python fidcode.py rulebook` | Message type to obligation (`out/rulebook.json`) |
| AI system prompt | `python fidcode.py prompt` | Teaches a model the codebook (`out/codebook-prompt.txt`) |

## Three layers, one codebook

| Layer | Example size (KYC update) | For |
|---|---|---|
| Plain language | 225 bytes | people, books and records |
| Compact text | 46 bytes | AI models, which read text tokens |
| Binary (`binary.py`) | 9 bytes (72 bits) | machine transport, storage, QR codes |

In the binary layer each field takes only the bits its value list needs,
so a risk-tolerance change costs 7 bits, less than one character. The
code space grows by doubling with every bit, and field codes are scoped
to their message type, so there is no practical ceiling on the number of
codes. One KYC update fits the smallest QR code (21 x 21); all 12 sample
messages fit one 57 x 57 QR code (`out/qr-kyc.svg`, `out/qr-all12.svg`).

## Ten-symbol Micro QR frame

`strip.py` defines a fixed frame of ten Micro QR symbols (M4, 17 x 17,
13 bytes each): a header (codebook version, firm, frame number, time),
eight payload symbols (96 bytes, about four to six messages), and a
96-bit seal that detects any alteration. Symbols carry their position,
so they can be scanned in any order. `out/strip.png` holds one client
meeting: KYC update, trusted contact, address change and suitability review.

The seal in the prototype uses a shared demo key; production use would
need per-firm keys or digital signatures.

## Example

```
KYC.U @A10293 RT:L>M TH:5-10>10+ EF:T0 SRC:MTG
```

renders as:

```
KYC update for account A10293.
- Risk tolerance: changed from low to medium
- Time horizon: changed from 5 to 10 years to over 10 years
- Effective date: 2026-10-14
- Information source: in-person meeting
- Related obligations (draft): NI 31-103 s.13.2, CIRO IDPC Rule 3200 series, CIRO MFD Rule 2.2.1
```

## Log export for regulators

`export.py` is the piece a dealer would run. It takes a CSV of events
exported from a back-office, CRM or AI system and writes a log package:

| File | Contents |
|---|---|
| `messages.log` | one timestamped FIDCODE message per line, the record itself |
| `messages.jsonl` | the same messages decoded, for regulators' systems |
| `rejected.csv` | rows that failed validation, each with the reason |
| `manifest.json` | firm, period, codebook version, counts, file hashes, hash chain |

```
python export.py sample_events.csv --firm 4417 --period 2026-10 --out out/
python export.py --verify out/FIRM4417_2026-10     # anyone can re-check a package
```

Any change to a delivered package, even one digit, fails verification.

## Automated compliance testing

`compliance.py` reads a timestamped log of FIDCODE messages and tests it
against obligations written as code. Each finding names the check, the
account, the rule reference and the log lines it relies on.

```
python compliance.py sample_log.txt          # report
python compliance.py sample_log.txt --json   # machine-readable findings
```

| Check | Tests that |
|---|---|
| C0 | every message is well-formed under the codebook |
| C1 | a KYC profile change is followed by a suitability review within 30 days |
| C2 | a transfer in is followed by a suitability review within 30 days |
| C3 | an unsuitable result records an action |
| C4 | a temporary hold has prompt client notice and a review within 30 days |
| C5 | no redemption or switch is placed while a hold is open |
| C6 | a complaint acknowledgement is due within 5 business days |
| C7 | a rejected instruction is corrected and re-sent |

The sample log contains 8 deliberate failures; the checker finds all
8 and passes the 7 compliant cases. Time limits are parameters
(`PARAMS` in `compliance.py`), so a firm or regulator can set them.
The checks are illustrative drafts, not legal interpretations.

## Message types (12)

KYC update, trusted contact person, purchase, redemption, fund switch,
transfer in, suitability review, temporary hold, complaint received,
address change, document request, acknowledgement.

## Results so far

See `RESULTS.md`. With an open tokenizer as a proxy, FIDCODE messages
use 41% fewer tokens than prose and 59% fewer than JSON. The codebook
prompt is about 1,100 tokens, less than a third of the equivalent JSON
Schema. `llm_eval.py` measures how accurately Claude reads and writes the
format; it needs API credentials and has not been run yet.

## Status and limits

- Rule references are drafts and have not been reviewed by counsel.
- Accounts, names and fund codes in `examples.yaml` are fictional.
- Token counts in `RESULTS.md` come from a proxy tokenizer until
  `benchmark.py` is run with Anthropic credentials.

## Running

```
pip install pyyaml pytest tiktoken segno      # anthropic for live counts and llm_eval.py
python -m pytest -q
python benchmark.py > RESULTS.md
python llm_eval.py                      # needs ANTHROPIC_API_KEY
```
