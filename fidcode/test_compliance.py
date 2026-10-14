from pathlib import Path

import compliance as cp

LOG = Path(__file__).with_name("sample_log.txt").read_text()


def results(text):
    return {(f.check.split()[0], f.account, f.result) for f in cp.run(text)}


def test_sample_log_findings():
    fails = {(c, a) for c, a, r in results(LOG) if r == "FAIL"}
    assert fails == {
        ("C0", "A70154"),  # KYC update missing source (rejected, then corrected)
        ("C0", "A20511"),  # order missing solicitation flag
        ("C1", "A20511"),  # KYC change with no suitability review
        ("C3", "A30877"),  # unsuitable result, no action
        ("C4", "A60120"),  # late hold notice, review too far out
        ("C5", "A50013"),  # redemption during open hold
        ("C6", "A50741"),  # complaint acknowledgement past 5 business days
        ("C7", "A80001"),  # rejected instruction never corrected
    }


def test_rejected_and_corrected_passes():
    assert ("C7", "A70154", "PASS") in results(LOG)


def test_adding_review_cures_failure():
    fixed = LOG + "2026-09-20T10:00 SUIT.R @A20511 #M2000 TRG:KYC RES:S ACTN:NONE DT:T0\n"
    assert ("C1", "A20511", "PASS") in results(fixed)
    assert ("C1", "A20511", "FAIL") not in results(fixed)


def test_review_not_due_yet_is_not_a_failure():
    log = "2026-10-14T09:00 KYC.U @A1 #M1 RT:L>M EF:T0 SRC:MTG\n"
    assert not any(f.check.startswith("C1") for f in cp.run(log))


def test_rejected_message_does_not_count():
    log = ("2026-10-01T09:00 TRF.I @A1 #M1 FROM:X ACT:NR KIND:C\n"
           "2026-10-01T09:01 ACK #M1 ST:REJ RC:DUP\n"
           "2026-12-01T09:00 KYC.U @A2 #M2 RT:L>M EF:T0 SRC:MTG\n")
    assert not any(f.check.startswith("C2") for f in cp.run(log))
