"""Run compliance checks against a log of FIDCODE messages.

Log format, one message per line (blank lines and # comments ignored):
    2026-10-14T10:02 KYC.U @A10293 #M1001 RT:L>M EF:T0 SRC:MTG

    python compliance.py sample_log.txt          # human-readable report
    python compliance.py sample_log.txt --json   # machine-readable findings

Every check names the obligation it tests and its parameters. The checks
and parameters are ILLUSTRATIVE DRAFTS for discussion, not legal
interpretations; time limits marked "policy" are firm-set, not regulatory.
"""
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from datetime import date, datetime, timedelta
from pathlib import Path

import fidcode as fc

PARAMS = {
    "suitability_after_kyc_days": 30,       # policy
    "suitability_after_transfer_days": 30,  # policy
    "hold_notice_days": 1,                  # policy reading of "as soon as possible"
    "hold_review_max_days": 30,
    "complaint_ack_business_days": 5,      # policy; s.13.16(2) says "as soon as possible"
}


@dataclass
class Msg:
    line: int
    ts: datetime
    wire: str
    type: str
    account: str | None
    ref: str | None
    fields: dict
    data: dict = field(default_factory=dict)


@dataclass
class Finding:
    check: str
    result: str  # PASS or FAIL
    rules: list
    account: str | None
    detail: str
    lines: list


def load_log(text):
    msgs, errors = [], []
    for i, raw in enumerate(text.splitlines(), 1):
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        ts_s, _, wire = s.partition(" ")
        try:
            ts = datetime.fromisoformat(ts_s)
        except ValueError:
            errors.append(Finding("C0 well-formed", "FAIL", [], None,
                                  f"bad timestamp {ts_s!r}", [i]))
            continue
        problems = fc.validate(wire)
        if problems:
            acct = re.search(r"\s@(\S+)", wire)
            ref = re.search(r"\s#(\S+)", wire)
            errors.append(Finding("C0 well-formed", "FAIL", [], acct and acct.group(1),
                                  "; ".join(problems), [i]))
            msgs.append(Msg(i, ts, wire, wire.split()[0], acct and acct.group(1),
                            ref and ref.group(1), {}, {"malformed": True}))
            continue
        t, acct, ref, flds = fc.parse(wire)
        msgs.append(Msg(i, ts, wire, t, acct, ref, flds, fc.decode(wire, ts.date())))
    return msgs, errors


def _d(s):
    return date.fromisoformat(s)


def _add_business_days(d, n):
    while n:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d



def _effective(msgs):
    """Messages that took effect: well-formed, and not rejected by an ACK."""
    rejected = {m.ref for m in msgs if m.type == "ACK" and m.fields.get("ST") == "REJ"}
    return [m for m in msgs if m.type != "ACK" and not m.data.get("malformed")
            and (m.ref is None or m.ref not in rejected)]


def _followed_by(msgs, start, pred, days):
    deadline = start.ts + timedelta(days=days)
    return next((m for m in msgs if m.ts >= start.ts and m.ts <= deadline and pred(m)), None)


# ------------------------------------------------------------------ checks

def check_suitability_after_kyc(msgs, as_of):
    out, n = [], PARAMS["suitability_after_kyc_days"]
    profile = {"RT", "RC", "TH", "IO"}
    for m in msgs:
        if m.type != "KYC.U" or not profile & m.fields.keys():
            continue
        hit = _followed_by(msgs, m, lambda x: x.type == "SUIT.R" and x.account == m.account
                           and x.fields["TRG"] == "KYC", n)
        due = m.ts + timedelta(days=n)
        if hit:
            out.append(Finding("C1 suitability review after KYC change", "PASS",
                               ["NI 31-103 s.13.3"], m.account,
                               f"reviewed on {hit.ts.date()}", [m.line, hit.line]))
        elif as_of > due:
            out.append(Finding("C1 suitability review after KYC change", "FAIL",
                               ["NI 31-103 s.13.3"], m.account,
                               f"no suitability review within {n} days of KYC change on {m.ts.date()}",
                               [m.line]))
    return out


def check_suitability_after_transfer(msgs, as_of):
    out, n = [], PARAMS["suitability_after_transfer_days"]
    for m in msgs:
        if m.type != "TRF.I":
            continue
        hit = _followed_by(msgs, m, lambda x: x.type == "SUIT.R" and x.account == m.account
                           and x.fields["TRG"] == "TRF", n)
        if hit:
            out.append(Finding("C2 suitability review after transfer in", "PASS",
                               ["NI 31-103 s.13.3(1)"], m.account,
                               f"reviewed on {hit.ts.date()}", [m.line, hit.line]))
        elif as_of > m.ts + timedelta(days=n):
            out.append(Finding("C2 suitability review after transfer in", "FAIL",
                               ["NI 31-103 s.13.3(1)"], m.account,
                               f"no suitability review within {n} days of transfer on {m.ts.date()}",
                               [m.line]))
    return out


def check_unsuitable_has_action(msgs, as_of):
    out = []
    for m in msgs:
        if m.type == "SUIT.R" and m.fields["RES"] == "U":
            ok = m.fields["ACTN"] != "NONE"
            out.append(Finding("C3 unsuitable result has an action", "PASS" if ok else "FAIL",
                               ["NI 31-103 s.13.3"], m.account,
                               f"action: {m.data['action taken']}", [m.line]))
    return out


def check_temporary_holds(msgs, as_of):
    out = []
    for m in msgs:
        if m.type != "VC.H":
            continue
        rules = ["NI 31-103 s.13.19"]
        notice_lag = (_d(m.data["client notified on"]) - m.ts.date()).days
        review_gap = (_d(m.data["next review date"]) - m.ts.date()).days
        problems = []
        if notice_lag > PARAMS["hold_notice_days"]:
            problems.append(f"client notified {notice_lag} days after hold")
        if review_gap > PARAMS["hold_review_max_days"]:
            problems.append(f"next review {review_gap} days out (max {PARAMS['hold_review_max_days']})")
        trusted = any(x.type == "TCP.U" and x.account == m.account and x.ts <= m.ts
                      and x.fields["CON"] == "Y" for x in msgs)
        out.append(Finding("C4 temporary hold handled", "FAIL" if problems else "PASS", rules,
                           m.account, "; ".join(problems) or
                           "notice and review dates within limits"
                           + ("" if trusted else " (note: no trusted contact on file)"),
                           [m.line]))
        held = m.fields["TXN"]
        for x in msgs:
            if x.account == m.account and x.ts > m.ts and x.type in ("ORD.R", "ORD.X") \
                    and x.ts.date() <= _d(m.data["next review date"]):
                out.append(Finding("C5 no trading around an open hold", "FAIL", rules, m.account,
                                   f"{x.type} placed while hold on {held} is open", [m.line, x.line]))
    return out


def check_complaint_ack(msgs, as_of):
    out, n = [], PARAMS["complaint_ack_business_days"]
    for m in msgs:
        if m.type != "CMP.R":
            continue
        limit = _add_business_days(_d(m.data["date received"]), n)
        due = _d(m.data["acknowledgement due"])
        ok = due <= limit
        out.append(Finding("C6 complaint acknowledgement deadline", "PASS" if ok else "FAIL",
                           ["NI 31-103 s.13.16(2)"], m.account,
                           f"acknowledgement due {due}; limit {limit} ({n} business days)",
                           [m.line]))
    return out


def check_rejections_resolved(msgs_all, as_of):
    """A rejected instruction should be re-sent in corrected form."""
    out = []
    by_ref = {m.ref: m for m in msgs_all if m.ref and m.type != "ACK"}
    for a in msgs_all:
        if a.type == "ACK" and a.fields.get("ST") == "REJ" and a.ref in by_ref:
            orig = by_ref[a.ref]
            fix = next((m for m in msgs_all if m.ts > a.ts and m.type == orig.type
                        and m.account == orig.account and not m.data.get("malformed")), None)
            out.append(Finding("C7 rejected instruction corrected", "PASS" if fix else "FAIL", [],
                               orig.account,
                               f"{orig.type} {a.ref} rejected ({a.data.get('reason', 'no reason')}"
                               + (f": {a.fields['F']}" if a.fields.get("F") else "") + ")"
                               + (f", corrected on line {fix.line}" if fix else ", never corrected"),
                               [orig.line, a.line] + ([fix.line] if fix else [])))
    return out


CHECKS = [check_suitability_after_kyc, check_suitability_after_transfer,
          check_unsuitable_has_action, check_temporary_holds, check_complaint_ack]


def run(text, as_of=None):
    msgs, findings = load_log(text)
    as_of = as_of or (max(m.ts for m in msgs) if msgs else datetime.now())
    live = _effective(msgs)
    for chk in CHECKS:
        findings += chk(live, as_of)
    findings += check_rejections_resolved(msgs, as_of)
    return findings


def main(argv):
    path = argv[1] if len(argv) > 1 else "sample_log.txt"
    findings = run(Path(path).read_text())
    if "--json" in argv:
        print(json.dumps({"parameters": PARAMS, "findings": [asdict(f) for f in findings]}, indent=2))
    else:
        fails = [f for f in findings if f.result == "FAIL"]
        print(f"{len(findings)} checks run, {len(findings) - len(fails)} passed, {len(fails)} failed\n")
        for f in sorted(findings, key=lambda f: (f.result != "FAIL", f.check)):
            rules = f" [{', '.join(f.rules)}]" if f.rules else ""
            print(f"{f.result}  {f.check}  {f.account or ''}{rules}\n      {f.detail} (log lines {f.lines})")
    return 1 if any(f.result == "FAIL" for f in findings) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
