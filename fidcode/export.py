"""Turn a dealer's event export into a regulator-ready FIDCODE log package.

Input: a CSV exported from a back-office, CRM or AI system, one event per
row. Required columns: timestamp, message_type, account (blank for ACK),
and optionally ref. Other columns are named after codebook fields
("risk tolerance", "effective date", ...). A change field uses two
columns: "<field> from" and "<field> to". Values may be codebook labels
("medium") or codes ("M"); dates are YYYY-MM-DD.

Output: a folder FIRM<id>_<period>/ containing
    messages.log     one timestamped FIDCODE message per line (the record)
    messages.jsonl   the same messages decoded, for regulators' systems
    rejected.csv     rows that failed validation, with the reasons
    manifest.json    firm, period, codebook version, counts, SHA-256 of
                     each file and a hash chain over the log lines

    python export.py events.csv --firm 4417 --period 2026-10 --out out/
"""
import argparse
import csv
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import fidcode as fc


def _label(enum, v, field):
    vals = fc.CB["enums"][enum]
    if v in vals:
        return vals[v]          # code -> label
    if v in vals.values():
        return v                # already a label
    raise fc.FidcodeError(f"{field}: {v!r} is not one of {list(vals.values())}")


def row_to_message(row):
    """Build a canonical dict from one CSV row and encode it."""
    ts = datetime.fromisoformat(row["timestamp"].strip())
    name = row["message_type"].strip()
    mtype = fc.TYPE_BY_NAME.get(name) or (name if name in fc.CB["types"] else None)
    if not mtype:
        raise fc.FidcodeError(f"unknown message type {name!r}")
    spec = fc.CB["types"][mtype]
    obj = {"message_type": spec["name"]}
    if (row.get("account") or "").strip():
        obj["account"] = row["account"].strip()
    if (row.get("ref") or "").strip():
        obj["ref"] = row["ref"].strip()
    for code, f in spec["fields"].items():
        n, enum = f["name"], f.get("enum")
        if f["type"] == "change":
            a, b = (row.get(f"{n} from") or "").strip(), (row.get(f"{n} to") or "").strip()
            if a or b:
                obj[n] = {"from": _label(enum, a, n) if enum else a,
                          "to": _label(enum, b, n) if enum else b}
            continue
        v = (row.get(n) or "").strip()
        if not v:
            continue
        if f["type"] == "enum":
            v = _label(enum, v, n)
        elif f["type"] == "number":
            v = float(v.replace(",", "")) if "." in v else int(v.replace(",", ""))
        obj[n] = v
    return ts, fc.encode(obj, today=ts.date())


def export(csv_path, firm, period, out_dir):
    rows = list(csv.DictReader(open(csv_path, newline="", encoding="utf-8-sig")))
    good, bad = [], []
    for i, row in enumerate(rows, start=2):  # line 1 is the header
        try:
            ts, msg = row_to_message(row)
            good.append((ts, msg))
        except (fc.FidcodeError, ValueError, KeyError) as e:
            bad.append({"csv_line": i, "error": str(e), **row})
    good.sort(key=lambda x: x[0])

    pkg = Path(out_dir) / f"FIRM{firm}_{period}"
    pkg.mkdir(parents=True, exist_ok=True)

    chain = hashlib.sha256(f"FIDCODE|{firm}|{period}".encode()).hexdigest()
    log_lines = []
    for ts, msg in good:
        line = f"{ts.isoformat(timespec='minutes')} {msg}"
        chain = hashlib.sha256((chain + line).encode()).hexdigest()
        log_lines.append(line)
    (pkg / "messages.log").write_text("".join(l + "\n" for l in log_lines))

    with open(pkg / "messages.jsonl", "w") as f:
        for ts, msg in good:
            f.write(json.dumps({"timestamp": ts.isoformat(timespec="minutes"),
                                "wire": msg, **fc.decode(msg, ts.date())}) + "\n")

    with open(pkg / "rejected.csv", "w", newline="") as f:
        cols = ["csv_line", "error"] + (list(rows[0].keys()) if rows else [])
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(bad)

    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    manifest = {
        "format": "FIDCODE log package",
        "codebook_version": fc.CB["version"],
        "firm": firm,
        "period": period,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_rows": len(rows),
        "messages": len(good),
        "rejected": len(bad),
        "by_type": {t: sum(1 for _, m in good if m.split()[0] == t)
                    for t in fc.CB["types"] if any(m.split()[0] == t for _, m in good)},
        "chain_head": chain,
        "files": {p.name: sha(pkg / p.name) for p in
                  [Path("messages.log"), Path("messages.jsonl"), Path("rejected.csv")]},
    }
    (pkg / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return pkg, manifest


def verify(pkg):
    """Re-check a package: file hashes, hash chain and every message."""
    pkg = Path(pkg)
    m = json.loads((pkg / "manifest.json").read_text())
    problems = [f"{name}: hash mismatch" for name, h in m["files"].items()
                if hashlib.sha256((pkg / name).read_bytes()).hexdigest() != h]
    chain = hashlib.sha256(f"FIDCODE|{m['firm']}|{m['period']}".encode()).hexdigest()
    for n, line in enumerate((pkg / "messages.log").read_text().splitlines(), 1):
        chain = hashlib.sha256((chain + line).encode()).hexdigest()
        errs = fc.validate(line.split(" ", 1)[1])
        if errs:
            problems.append(f"line {n}: {'; '.join(errs)}")
    if chain != m["chain_head"]:
        problems.append("hash chain does not match manifest")
    return problems


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("csv", nargs="?")
    ap.add_argument("--firm", type=int)
    ap.add_argument("--period")
    ap.add_argument("--out", default="out")
    ap.add_argument("--verify", metavar="PACKAGE")
    a = ap.parse_args()
    if a.verify:
        p = verify(a.verify)
        print("package verified" if not p else "\n".join(p))
        raise SystemExit(1 if p else 0)
    pkg, m = export(a.csv, a.firm, a.period, a.out)
    print(f"{m['messages']} messages written, {m['rejected']} rejected -> {pkg}")
