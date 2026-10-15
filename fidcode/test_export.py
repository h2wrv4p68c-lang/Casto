import csv
from pathlib import Path

import compliance
import export

SAMPLE = Path(__file__).with_name("sample_events.csv")


def test_export_and_verify(tmp_path):
    pkg, m = export.export(SAMPLE, 4417, "2026-10", tmp_path)
    assert (m["messages"], m["rejected"]) == (5, 2)
    assert export.verify(pkg) == []
    lines = (pkg / "messages.log").read_text().splitlines()
    assert lines[0] == "2026-10-01T09:20 KYC.U @A10293 #M3001 RT:L>M TH:5-10>10+ EF:T0 SRC:MTG"


def test_rejections_explain_the_problem(tmp_path):
    pkg, _ = export.export(SAMPLE, 4417, "2026-10", tmp_path)
    errs = {r["csv_line"]: r["error"] for r in csv.DictReader(open(pkg / "rejected.csv"))}
    assert "missing required field SRC" in errs["3"]
    assert errs["8"].startswith("solicitation: 'maybe'")


def test_tampering_detected(tmp_path):
    pkg, _ = export.export(SAMPLE, 4417, "2026-10", tmp_path)
    log = pkg / "messages.log"
    log.write_text(log.read_text().replace("AMT:25000", "AMT:2500"))
    problems = export.verify(pkg)
    assert any("hash mismatch" in p for p in problems)
    assert any("chain" in p for p in problems)


def test_output_feeds_compliance_checks(tmp_path):
    pkg, _ = export.export(SAMPLE, 4417, "2026-10", tmp_path)
    findings = compliance.run((pkg / "messages.log").read_text())
    assert findings and all(f.check.split()[0] != "C0" for f in findings)
