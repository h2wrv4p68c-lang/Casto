"""FIDCODE: encode, decode, validate and render compact dealer messages.

    python fidcode.py decode 'KYC.U @A10293 RT:L>M EF:T0 SRC:MTG'
    python fidcode.py render 'KYC.U @A10293 RT:L>M EF:T0 SRC:MTG'
    python fidcode.py encode '{"message_type": "KYC update", ...}'
    python fidcode.py schema            # JSON Schema for every message type
    python fidcode.py rulebook          # message type -> rule references
"""
import json
import re
import shlex
import sys
from datetime import date, datetime
from pathlib import Path

import yaml

CODEBOOK_PATH = Path(__file__).with_name("codebook.yaml")
DATE_RE = re.compile(r"^(T0|\d{6})$")
NUM_RE = re.compile(r"^\d+(\.\d+)?$")
ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class FidcodeError(ValueError):
    pass


def load_codebook(path=CODEBOOK_PATH):
    cb = yaml.safe_load(Path(path).read_text())
    for name, vals in cb["enums"].items():  # guard against YAML 1.1 yes/no/on/off coercion
        for k, v in vals.items():
            if not isinstance(k, str) or not isinstance(v, str):
                raise ValueError(f"enum {name}: quote {k!r}: {v!r} in codebook.yaml")
    return cb


CB = load_codebook()
TYPE_BY_NAME = {t["name"]: code for code, t in CB["types"].items()}


def _field_by_name(spec):
    return {f["name"]: code for code, f in spec["fields"].items()}


def _expand_date(v, today=None):
    if v == "T0":
        return (today or date.today()).isoformat()
    return datetime.strptime(v, "%y%m%d").date().isoformat()


def _compact_date(v):
    return datetime.strptime(v, "%Y-%m-%d").strftime("%y%m%d")


# ---------------------------------------------------------------- parsing

def parse(msg):
    """Split a wire message into (type, account, ref, {code: raw_value})."""
    try:
        parts = shlex.split(msg.strip(), posix=True)
    except ValueError as e:
        raise FidcodeError(f"unbalanced quotes: {e}")
    if not parts:
        raise FidcodeError("empty message")
    mtype, account, ref, fields = parts[0], None, None, {}
    if mtype not in CB["types"]:
        raise FidcodeError(f"unknown message type {mtype!r}")
    for p in parts[1:]:
        if p.startswith("@") and account is None and not fields:
            account = p[1:]
        elif p.startswith("#") and ref is None and not fields:
            ref = p[1:]
        elif ":" in p:
            code, val = p.split(":", 1)
            if code in fields:
                raise FidcodeError(f"field {code} repeated")
            fields[code] = val
        else:
            raise FidcodeError(f"cannot parse element {p!r}")
    return mtype, account, ref, fields


def validate(msg):
    """Return a list of problems; empty means the message is valid."""
    try:
        mtype, account, ref, fields = parse(msg)
    except FidcodeError as e:
        return [str(e)]
    spec, errs = CB["types"][mtype], []
    if spec.get("account") == "required" and not account:
        errs.append("account (@...) is required")
    if spec.get("account") == "none" and account:
        errs.append("this message type takes no account")
    for code, f in spec["fields"].items():
        if f.get("required") and code not in fields:
            errs.append(f"missing required field {code} ({f['name']})")
    for code in spec.get("required_change", []):
        if code not in fields:
            errs.append(f"missing required field {code}")
    for group in spec.get("one_of", []):
        if sum(c in fields for c in group) != 1:
            errs.append(f"exactly one of {', '.join(group)} is required")
    for code, val in fields.items():
        f = spec["fields"].get(code)
        if f is None:
            errs.append(f"field {code} is not defined for {mtype}")
            continue
        errs += [f"{code}: {e}" for e in _check_value(f, val)]
    if mtype not in ("ACK",) and spec.get("account") == "required" and len(fields) == 0:
        errs.append("message carries no fields")
    return errs


def _check_value(f, val):
    t, enum = f["type"], CB["enums"].get(f.get("enum"), {})
    if t == "enum":
        return [] if val in enum else [f"{val!r} is not one of {list(enum)}"]
    if t == "change":
        if ">" not in val:
            return [f"expected FROM>TO, got {val!r}"]
        a, b = val.split(">", 1)
        if enum:
            return [f"{x!r} is not one of {list(enum)}" for x in (a, b) if x not in enum]
        return [f"bad id {x!r}" for x in (a, b) if not ID_RE.match(x)]
    if t == "date":
        if not DATE_RE.match(val):
            return [f"expected YYMMDD or T0, got {val!r}"]
        try:
            _expand_date(val)
        except ValueError:
            return [f"invalid date {val!r}"]
        return []
    if t == "number":
        return [] if NUM_RE.match(val) else [f"expected a number, got {val!r}"]
    if t == "id":
        return [] if ID_RE.match(val) else [f"bad identifier {val!r}"]
    return []  # text


# --------------------------------------------------------- decode/encode

def decode(msg, today=None):
    """Compact wire message -> canonical JSON-ready dict with full names."""
    errs = validate(msg)
    if errs:
        raise FidcodeError("; ".join(errs))
    mtype, account, ref, fields = parse(msg)
    spec = CB["types"][mtype]
    out = {"message_type": spec["name"]}
    if account:
        out["account"] = account
    if ref:
        out["ref"] = ref
    for code, f in spec["fields"].items():  # codebook order
        if code not in fields:
            continue
        val, enum = fields[code], CB["enums"].get(f.get("enum"), {})
        if f["type"] == "enum":
            out[f["name"]] = enum[val]
        elif f["type"] == "change":
            a, b = val.split(">", 1)
            out[f["name"]] = {"from": enum.get(a, a), "to": enum.get(b, b)}
        elif f["type"] == "date":
            out[f["name"]] = _expand_date(val, today)
        elif f["type"] == "number":
            out[f["name"]] = float(val) if "." in val else int(val)
        else:
            out[f["name"]] = val
    return out


def encode(obj, today=None):
    """Canonical dict (full names) -> compact wire message."""
    mtype = TYPE_BY_NAME.get(obj.get("message_type"))
    if not mtype:
        raise FidcodeError(f"unknown message_type {obj.get('message_type')!r}")
    spec = CB["types"][mtype]
    by_name = _field_by_name(spec)
    parts = [mtype]
    if obj.get("account"):
        parts.append("@" + obj["account"])
    if obj.get("ref"):
        parts.append("#" + obj["ref"])
    for name, val in obj.items():
        if name in ("message_type", "account", "ref"):
            continue
        code = by_name.get(name)
        if code is None:
            raise FidcodeError(f"field {name!r} is not defined for {mtype}")
        f = spec["fields"][code]
        rev = {v: k for k, v in CB["enums"].get(f.get("enum"), {}).items()}
        if f["type"] == "enum":
            v = rev[val]
        elif f["type"] == "change":
            v = f"{rev.get(val['from'], val['from'])}>{rev.get(val['to'], val['to'])}"
        elif f["type"] == "date":
            v = "T0" if today and val == today.isoformat() else _compact_date(val)
        elif f["type"] == "text":
            if '"' in val:
                raise FidcodeError(f"{name}: text may not contain double quotes")
            v = f'"{val}"' if (not val or re.search(r"[\s:>@#']", val)) else val
        else:
            v = str(val)
        parts.append(f"{code}:{v}")
    msg = " ".join(parts)
    errs = validate(msg)
    if errs:
        raise FidcodeError("; ".join(errs))
    return msg


def render(msg, today=None):
    """Plain-language rendering for records and human review."""
    d = decode(msg, today)
    head = d["message_type"][0].upper() + d["message_type"][1:]
    if "account" in d:
        head += f" for account {d['account']}"
    if "ref" in d:
        head += f" (ref {d['ref']})"
    lines = [head + "."]
    for k, v in d.items():
        if k in ("message_type", "account", "ref"):
            continue
        if isinstance(v, dict):
            v = f"changed from {v['from']} to {v['to']}"
        elif isinstance(v, (int, float)) and "CAD" in k:
            v = f"${v:,}"
        lines.append(f"- {k[0].upper() + k[1:]}: {v}")
    rules = CB["types"][parse(msg)[0]]["rules"]
    if rules:
        lines.append(f"- Related obligations (draft): {', '.join(rules)}")
    return "\n".join(lines)


# ------------------------------------------------- machine-readable outputs

def json_schema(mtype):
    spec = CB["types"][mtype]
    props = {"message_type": {"const": spec["name"]}}
    required = ["message_type"]
    if spec.get("account") == "required":
        props["account"] = {"type": "string", "pattern": ID_RE.pattern}
        required.append("account")
    props["ref"] = {"type": "string", "pattern": ID_RE.pattern}
    for code, f in spec["fields"].items():
        enum = list(CB["enums"].get(f.get("enum"), {}).values())
        t = f["type"]
        if t == "enum":
            s = {"enum": enum}
        elif t == "change":
            leaf = {"enum": enum} if enum else {"type": "string"}
            s = {"type": "object", "properties": {"from": leaf, "to": leaf},
                 "required": ["from", "to"], "additionalProperties": False}
        elif t == "date":
            s = {"type": "string", "format": "date"}
        elif t == "number":
            s = {"type": "number", "minimum": 0}
        else:
            s = {"type": "string"}
        s["x-fidcode"] = code
        props[f["name"]] = s
        if f.get("required") or code in spec.get("required_change", []):
            required.append(f["name"])
    schema = {"$schema": "https://json-schema.org/draft/2020-12/schema",
              "title": f"FIDCODE {CB['version']} {mtype}: {spec['name']}",
              "type": "object", "properties": props, "required": required,
              "additionalProperties": False, "x-rules": spec["rules"]}
    for group in spec.get("one_of", []):
        names = [spec["fields"][c]["name"] for c in group]
        schema["oneOf"] = [{"required": [n]} for n in names]
    return schema


def rulebook():
    return {code: {"name": t["name"], "rules": t["rules"],
                   "required_fields": [f["name"] for f in t["fields"].values() if f.get("required")]}
            for code, t in CB["types"].items()}


def codebook_prompt():
    """A compact text rendering of the codebook for an AI system prompt."""
    out = [f"FIDCODE {CB['version']} message format. One message per line:",
           "TYPE [@ACCOUNT] [#REF] CODE:VALUE ... ; change = FROM>TO ; dates YYMMDD or T0=today ; quoted free text.",
           "", "ENUMS"]
    for name, vals in CB["enums"].items():
        out.append(f"{name}: " + ", ".join(f"{k}={v}" for k, v in vals.items()))
    out += ["", "TYPES (* = required)"]
    for code, t in CB["types"].items():
        req = set(t.get("required_change", []))
        fs = " ".join(f"{c}{'*' if f.get('required') or c in req else ''}={f['name']}"
                      f"[{f.get('enum') or f['type']}{'>' if f['type'] == 'change' else ''}]"
                      for c, f in t["fields"].items())
        acct = " @acct*" if t.get("account") == "required" else ""
        extra = "".join(f" (exactly one of {'/'.join(g)})" for g in t.get("one_of", []))
        out.append(f"{code} {t['name']}:{acct} {fs}{extra}")
    return "\n".join(out)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd, arg = argv[1], (argv[2] if len(argv) > 2 else None)
    try:
        if cmd == "decode":
            print(json.dumps(decode(arg), indent=2))
        elif cmd == "render":
            print(render(arg))
        elif cmd == "validate":
            errs = validate(arg)
            print("valid" if not errs else "\n".join(errs))
            return 1 if errs else 0
        elif cmd == "encode":
            print(encode(json.loads(arg)))
        elif cmd == "schema":
            print(json.dumps({c: json_schema(c) for c in CB["types"]}, indent=2))
        elif cmd == "rulebook":
            print(json.dumps(rulebook(), indent=2))
        elif cmd == "prompt":
            print(codebook_prompt())
        else:
            print(__doc__)
            return 1
    except FidcodeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
