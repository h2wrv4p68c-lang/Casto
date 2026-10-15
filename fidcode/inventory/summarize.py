"""Compute the count tables for SUMMARY.md from ni31-103-part13.yaml.

    python inventory/summarize.py            # print markdown tables
"""
import sys
from collections import Counter
from pathlib import Path

import yaml

HERE = Path(__file__).parent
CATS = ["event", "data", "judgment", "mixed"]
STATUSES = ["covered", "extendable", "review_only", "not_testable"]
PROPOSED_NAMES = {
    "ACCT.O": "account opening",
    "KYC.C": "client confirmation of KYC information",
    "KYC.R": "periodic KYC information review",
    "PRD.A": "product approval or removal (firm shelf)",
    "PRD.C": "significant change in a security",
    "REP.A": "registered individual assigned to account",
    "SUIT.O": "client instruction to proceed despite unsuitability",
    "REC.M": "recommendation made",
    "COI.R": "material conflict identified or reported",
    "DISC.D": "written disclosure delivered (typed: COI, REF, REFCHG, LEV, RELISS)",
    "APR.F": "sponsoring firm approval or consent (typed: COI, LEND, BORROW, TITLE)",
    "CNS.C": "client written consent or request (typed: MGDPURCH, WAIVER)",
    "POI.U": "position of influence declared",
    "RSP.U": "responsible person / connected issuer list update",
    "REF.A": "referral arrangement recorded or changed",
    "REF.X": "client referral made or received",
    "REF.F": "referral fee recorded",
    "LND.X": "loan, credit, margin or borrowing between registrant and client",
    "CMP.A": "complaint acknowledgement sent",
    "CMP.D": "complaint decision notice sent",
    "CMP.E": "client escalation to dispute resolution service",
    "VC.X": "temporary hold revoked",
    "VC.C": "temporary hold continued, client notified",
    "TTL.U": "title or designation in use",
}


def table(rows, header):
    out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def main():
    doc = yaml.safe_load((HERE / "ni31-103-part13.yaml").read_text())
    provs = doc["provisions"]
    kinds = Counter(p["kind"] for p in provs)
    op = [p for p in provs if p["kind"] == "operative"]
    ce = [p for p in provs if p["kind"] == "conditional_exemption"]
    cls = op + ce

    unknown = {c for p in cls for c in p["message_types"]["proposed"]} - PROPOSED_NAMES.keys()
    if unknown:
        sys.exit(f"proposed codes without names: {sorted(unknown)}")

    print("### Entries by kind\n")
    print(table([(k, kinds[k]) for k in sorted(kinds)] + [("total", len(provs))], ["kind", "entries"]))

    for title, group in (("Operative provisions", op),
                         ("Conditional exemptions (conditions are testable obligations when relied on)", ce),
                         ("All classified entries", cls)):
        n = len(group)
        cat = Counter(p["category"] for p in group)
        st = Counter(p["fidcode_status"] for p in group)
        print(f"\n### {title} (n = {n})\n")
        print(table([(c, cat[c], f"{100 * cat[c] / n:.0f}%") for c in CATS], ["category", "count", "share"]))
        print()
        print(table([(s, st[s], f"{100 * st[s] / n:.0f}%") for s in STATUSES], ["fidcode_status", "count", "share"]))
        print()
        print(table([[c] + [sum(1 for p in group if p["category"] == c and p["fidcode_status"] == s)
                             for s in STATUSES] for c in CATS], ["category \\ status"] + STATUSES))

    print("\n### Proposed new message types (classified entries served)\n")
    served = Counter(c for p in cls for c in p["message_types"]["proposed"])
    ids = {c: [p["id"] for p in cls if c in p["message_types"]["proposed"]] for c in served}
    print(table([(c, PROPOSED_NAMES[c], served[c], ", ".join(ids[c]))
                 for c, _ in sorted(served.items(), key=lambda kv: (-kv[1], kv[0]))],
                ["code", "name", "entries", "provisions"]))

    print("\n### Existing message types referenced\n")
    used = Counter(c for p in cls for c in p["message_types"]["existing"])
    print(table(sorted(used.items(), key=lambda kv: (-kv[1], kv[0])), ["code", "entries"]))

    print("\n### Vague terms (classified entries using each)\n")
    vt = Counter(t for p in cls for t in p["vague_terms"])
    print(table(sorted(vt.items(), key=lambda kv: (-kv[1], kv[0])), ["term", "entries"]))

    sro = [p["id"] for p in cls if p.get("sro_member_exemption")]
    print(f"\nEntries with an NI-level CIRO member exemption: {len(sro)} ({', '.join(sro)})")
    machine = sum(1 for p in cls if p["fidcode_status"] in ("covered", "extendable"))
    print(f"Classified entries covered or extendable: {machine} of {len(cls)}")


if __name__ == "__main__":
    main()
