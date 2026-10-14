# FIDCODE: draft 0.1

A compact, machine-readable message vocabulary for communication between
AI agents and systems at Canadian securities and mutual fund dealers.
It is a proof of concept prepared for discussion by the
[Federation of Independent Dealers](https://www.IndependentDealers.ca).

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
pip install pyyaml pytest tiktoken      # anthropic for live counts and llm_eval.py
python -m pytest -q
python benchmark.py > RESULTS.md
python llm_eval.py                      # needs ANTHROPIC_API_KEY
```
