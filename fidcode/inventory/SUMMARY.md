# NI 31-103 Part 13: obligation inventory summary

**Status: first pass for review by counsel and compliance staff.** Every
classification in `ni31-103-part13.yaml` is a preliminary judgment made by
reading the rule text. None of it has been reviewed by a lawyer or a
compliance officer, and none of it is a legal interpretation.

## Source

- Text: BCSC unofficial consolidation of NI 31-103, "effective as of January 1, 2026",
  published by the BCSC on 2026-06-16
  (https://www.bcsc.bc.ca/-/media/PWS/New-Resources/Securities-Law/Instruments-and-Policies/Policy-3/31103-NI-June-16-2026.pdf).
  The consolidation is "for reference purposes only and is not an official statement of the law".
- Retrieved 2026-10-15. PDF sha256 `68b10d650931def80b710ef552ab29858df1feca358a8eba2a66700d2ea7e6fb`.
- Part 13 heading in the source: "Dealing with clients – individuals and firms", Divisions 1 to 8,
  sections 13.1 to 13.19 (25 sections, one lapsed).
- Every `id` in the YAML was checked by script against the Part 13 body text of the PDF
  (section heading present, subsection and paragraph labels present in order).

## Method

Each section was split to subsection or paragraph level where the text imposes a
separate obligation. Entries are tagged by `kind`. Only `operative` and
`conditional_exemption` entries are classified; scope, definition, interpretive
and repealed entries are listed for completeness. Conditional exemptions
(13.3(2.1), 13.3.1, 13.13(2), 13.16(5), 13.17(2)) are counted separately
because their conditions only bind when a firm relies on them.

Status meanings: **covered** = an existing codebook type and an existing
`compliance.py` check address it; **extendable** = testable from logs with new
types, fields or checks (for `mixed` entries, only the process step is testable);
**review_only** = a machine can confirm a record exists but a person must judge it;
**not_testable** = no useful message-log test.

All tables below are produced by `python3 inventory/summarize.py` from the YAML.

## Counts

### Entries by kind

| kind | entries |
|---|---|
| conditional_exemption | 6 |
| definition | 5 |
| interpretive | 3 |
| operative | 62 |
| repealed | 1 |
| scope | 14 |
| total | 91 |

### Operative provisions (n = 62)

| category | count | share |
|---|---|---|
| event | 17 | 27% |
| data | 10 | 16% |
| judgment | 13 | 21% |
| mixed | 22 | 35% |

| fidcode_status | count | share |
|---|---|---|
| covered | 3 | 5% |
| extendable | 42 | 68% |
| review_only | 12 | 19% |
| not_testable | 5 | 8% |

| category \ status | covered | extendable | review_only | not_testable |
|---|---|---|---|---|
| event | 1 | 16 | 0 | 0 |
| data | 0 | 10 | 0 | 0 |
| judgment | 0 | 0 | 8 | 5 |
| mixed | 2 | 16 | 4 | 0 |

### Conditional exemptions (conditions are testable obligations when relied on) (n = 6)

| category | count | share |
|---|---|---|
| event | 1 | 17% |
| data | 4 | 67% |
| judgment | 1 | 17% |
| mixed | 0 | 0% |

| fidcode_status | count | share |
|---|---|---|
| covered | 0 | 0% |
| extendable | 5 | 83% |
| review_only | 1 | 17% |
| not_testable | 0 | 0% |

| category \ status | covered | extendable | review_only | not_testable |
|---|---|---|---|---|
| event | 0 | 1 | 0 | 0 |
| data | 0 | 4 | 0 | 0 |
| judgment | 0 | 0 | 1 | 0 |
| mixed | 0 | 0 | 0 | 0 |

### All classified entries (n = 68)

| category | count | share |
|---|---|---|
| event | 18 | 26% |
| data | 14 | 21% |
| judgment | 14 | 21% |
| mixed | 22 | 32% |

| fidcode_status | count | share |
|---|---|---|
| covered | 3 | 4% |
| extendable | 47 | 69% |
| review_only | 13 | 19% |
| not_testable | 5 | 7% |

| category \ status | covered | extendable | review_only | not_testable |
|---|---|---|---|---|
| event | 1 | 17 | 0 | 0 |
| data | 0 | 14 | 0 | 0 |
| judgment | 0 | 0 | 9 | 5 |
| mixed | 2 | 16 | 4 | 0 |

### Proposed new message types (classified entries served)

| code | name | entries | provisions |
|---|---|---|---|
| ACCT.O | account opening | 14 | 13.2(2)(a), 13.2(2)(b), 13.2(2)(c), 13.2(3), 13.2(3.1), 13.2(4.1), 13.2.01(1), 13.3(1), 13.4(7), 13.5(2)(a), 13.8(c), 13.3.1(1), 13.3.1(2), 13.13(2) |
| DISC.D | written disclosure delivered (typed: COI, REF, REFCHG, LEV, RELISS) | 10 | 13.4(4), 13.4(5), 13.4(7), 13.5(2)(a), 13.6, 13.8(c), 13.10(1), 13.10(2), 13.13(1), 13.13(2) |
| COI.R | material conflict identified or reported | 8 | 13.4(1), 13.4(2), 13.4(4), 13.4(7), 13.4.1(1), 13.4.1(2), 13.4.1(3), 13.4.1(5) |
| REC.M | recommendation made | 7 | 13.2.1(3), 13.3(1), 13.4.1(5), 13.4.3(3), 13.4.3(4), 13.6, 13.13(1) |
| APR.F | sponsoring firm approval or consent (typed: COI, LEND, BORROW, TITLE) | 4 | 13.4.1(5), 13.12(1), 13.12(2), 13.18(2)(c) |
| LND.X | loan, credit, margin or borrowing between registrant and client | 4 | 13.2(2)(d), 13.5(2)(c), 13.12(1), 13.12(2) |
| PRD.A | product approval or removal (firm shelf) | 4 | 13.2.1(1)(a), 13.2.1(1)(b), 13.2.1(1)(c), 13.2.1(3) |
| REF.A | referral arrangement recorded or changed | 4 | 13.8(a), 13.9, 13.10(1), 13.10(2) |
| CMP.D | complaint decision notice sent | 3 | 13.15, 13.16(3), 13.16(4) |
| CNS.C | client written consent or request (typed: MGDPURCH, WAIVER) | 3 | 13.5(2)(a), 13.3.1(1), 13.3.1(2) |
| REF.X | client referral made or received | 3 | 13.8(a), 13.8(c), 13.9 |
| RSP.U | responsible person / connected issuer list update | 3 | 13.5(2)(a), 13.5(2)(b), 13.5(2)(c) |
| TTL.U | title or designation in use | 3 | 13.18(2)(a), 13.18(2)(b), 13.18(2)(c) |
| VC.C | temporary hold continued, client notified | 3 | 13.19(3)(a), 13.19(3)(c), 13.19(3)(d) |
| CMP.A | complaint acknowledgement sent | 2 | 13.16(2), 13.16(6) |
| CMP.E | client escalation to dispute resolution service | 2 | 13.16(4), 13.16(5) |
| KYC.R | periodic KYC information review | 2 | 13.2(4.1), 13.3(2)(d) |
| POI.U | position of influence declared | 2 | 13.4.3(3), 13.4.3(4) |
| PRD.C | significant change in a security | 2 | 13.2.1(1)(c), 13.3(2)(b) |
| REF.F | referral fee recorded | 2 | 13.8(b), 13.10(2) |
| REP.A | registered individual assigned to account | 2 | 13.3(2)(a), 13.4.3(3) |
| KYC.C | client confirmation of KYC information | 1 | 13.2(3.1) |
| SUIT.O | client instruction to proceed despite unsuitability | 1 | 13.3(2.1) |
| VC.X | temporary hold revoked | 1 | 13.19(3)(d) |

### Existing message types referenced

| code | entries |
|---|---|
| ORD.B | 9 |
| ORD.R | 6 |
| ORD.X | 6 |
| SUIT.R | 6 |
| VC.H | 6 |
| KYC.U | 5 |
| CMP.R | 4 |
| TCP.U | 2 |
| ADDR.U | 1 |
| TRF.I | 1 |

### Vague terms (classified entries using each)

| term | entries |
|---|---|
| reasonable steps | 19 |
| material | 8 |
| within a reasonable time | 7 |
| as soon as possible | 6 |
| best interest | 5 |
| knowingly | 4 |
| reasonable person | 3 |
| significant change | 3 |
| could result | 2 |
| reasonably believes | 2 |
| reasonably foreseeable | 2 |
| susceptible | 2 |
| appropriate qualifications | 1 |
| based partly | 1 |
| cause for concern | 1 |
| concurrently | 1 |
| could reasonably be expected to deceive or mislead | 1 |
| fair and effective | 1 |
| in a timely manner | 1 |
| in connection with | 1 |
| influence | 1 |
| knows | 1 |
| material terms | 1 |
| nature and extent | 1 |
| normal course | 1 |
| on a reasonable basis | 1 |
| plain language | 1 |
| prominent | 1 |
| promptly | 1 |
| puts the client's interest first | 1 |
| reasonable client would consider important | 1 |
| reasonable client would expect | 1 |
| reasonable inquiries | 1 |
| reasonable investor | 1 |
| reasonable range of alternative actions | 1 |
| reasonably frequent | 1 |
| relevant aspects | 1 |
| specific | 1 |
| substantially similar | 1 |
| sufficient information | 1 |
| sufficiently similar | 1 |
| to the extent possible | 1 |
| understand | 1 |
| vulnerable client | 1 |

Entries with an NI-level CIRO member exemption: 13 (13.2(3), 13.3(1), 13.3(2)(a), 13.3(2)(b), 13.3(2)(c), 13.3(2)(d), 13.12(1), 13.12(2), 13.13(1), 13.15, 13.3(2.1), 13.3.1(1), 13.3.1(2))
Classified entries covered or extendable: 50 of 68

Repealed or lapsed provisions: 13.11 ("[lapsed]" in the body, "[repealed]" in the
table of contents) and paragraph 13.13(2)(b) ("[repealed]").

## Field extensions to existing types

Beyond new types, the YAML records field additions on existing types. The main ones:
`KYC.U` AW (awareness date), KN (investment knowledge), FIN, PC; `ORD.*` SR
(suitability reference), REP (acting individual), COI, CPTY, LEV; `SUIT.R` TRG values
PRE and SEC; `VC.H` DOCREF; `TCP.U` a "client declined" value.

## Observations

- Only 3 of 62 operative provisions are covered today: 13.3(2)(c) via C1 and C3,
  and 13.19(3)(b) and 13.19(3)(c) via C4. All three are covered with caveats: C1
  uses a 30-day policy parameter, and C4 checks dates the firm enters on the hold
  message (notice date, next review date), not evidence that notice was sent or a
  review occurred.
- About two thirds of operative provisions (42 of 62) are extendable, but 16 of
  those are `mixed`: a log can show the step happened on time, not that it was
  done well. Counting only `event` and `data` entries, 27 of 62 operative
  provisions (44%) are fully testable from logs once the vocabulary is extended.
  17 of 62 (27%) need a person whatever the vocabulary (`review_only` plus
  `not_testable`).
- Four proposed types do most of the work: ACCT.O (14 entries), DISC.D (10),
  COI.R (8) and REC.M (7). The absence of an account-opening message and of a
  logged recommendation is the largest gap in the v0.1 codebook, since many
  Part 13 duties attach "before opening an account" or to a recommendation.
- The bright-line deadlines in Part 13 are few and all testable: the 12/36-month
  KYC review cycle (13.2(4.1)), the 180-day leverage look-back (13.13(2)(a)), the
  30-day referral change notice (13.10(2)), the 90- and 180-day OBSI windows
  (13.16(4)) and the 30-day hold revoke-or-notify cycle (13.19(3)(d)). Everything
  else is timed by words such as "within a reasonable time" (7 entries), "as soon
  as possible" (6), "promptly" and "in a timely manner", which need a regulator or
  firm parameter before a check can return PASS or FAIL.
- Several citations in the current codebook and checks do not match the source:
  `TCP.U` cites "s.13.2(2)(e)", which does not exist (trusted contact is 13.2.01);
  `TRF.I` and check C2 cite 13.3(2), whose triggers do not include transfers (a
  transfer is an action under 13.3(1)); C6 cites 13.15, but the acknowledgement
  duty is 13.16(2); and the 5-business-day parameter in C6 does not appear in the
  NI text, so its source should be confirmed.
- 13 classified entries (13.2(3), 13.3, 13.3.1, 13.12, 13.13, 13.15) do not apply
  under the NI to CIRO member firms, or their dealing representatives, that comply
  with the corresponding SRO rules (ss. 3.16, 9.3, 9.4). For most FIDCODE users
  the binding text for those duties is the CIRO rulebook, which should get its own
  inventory.
- Several duties depend on self-reporting (an individual's conflicts, borrowing
  from clients, positions of influence). Logs can test that reported cases were
  handled correctly; they cannot find unreported ones.
- Several checks need state the message log does not carry today: the firm's
  approved product list, account holdings (for security-change fan-out and
  concentration), the acting registered individual on each order, and account
  attributes such as managed, permitted client and client type.
