"""Sub-character binary layer for FIDCODE.

Packs a FIDCODE message into the fewest bits the codebook allows: each
enum value takes only the bits its list needs (5 risk levels -> 3 bits),
dates take 16 bits, and optional fields cost one presence bit when absent.
The same codebook drives the text form, so the layers convert both ways.

    python binary.py 'KYC.U @A10293 RT:L>M EF:T0 SRC:MTG'
    python binary.py --stats            # sizes for every example
    python binary.py --qr out/kyc.svg 'KYC.U ...'
"""
import math
import sys
from datetime import date, datetime, timedelta

import fidcode as fc

VERSION = 1
EPOCH = date(2000, 1, 1)
ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.-_"  # 6 bits per character
TYPES = list(fc.CB["types"])


def nbits(n):
    return max(1, math.ceil(math.log2(n)))


class Writer:
    def __init__(self):
        self.bits = []

    def put(self, value, width):
        if value < 0 or value >= 1 << width:
            raise fc.FidcodeError(f"value {value} does not fit in {width} bits")
        self.bits += [(value >> i) & 1 for i in reversed(range(width))]

    def to_bytes(self):
        b = self.bits + [0] * (-len(self.bits) % 8)
        return bytes(int("".join(map(str, b[i:i + 8])), 2) for i in range(0, len(b), 8))


class Reader:
    def __init__(self, data):
        self.bits = [int(c) for byte in data for c in f"{byte:08b}"]
        self.pos = 0

    def get(self, width):
        v = 0
        for _ in range(width):
            v = (v << 1) | self.bits[self.pos]
            self.pos += 1
        return v


# ---------------------------------------------------------- value codecs

def _put_enum(w, enum, v):
    keys = list(fc.CB["enums"][enum])
    w.put(keys.index(v), nbits(len(keys)))


def _get_enum(r, enum):
    keys = list(fc.CB["enums"][enum])
    return keys[r.get(nbits(len(keys)))]


def _put_id(w, v):
    if not 1 <= len(v) <= 16 or any(c not in ID_CHARS for c in v):
        raise fc.FidcodeError(f"identifier {v!r} must be 1-16 of {ID_CHARS}")
    w.put(len(v) - 1, 4)
    for c in v:
        w.put(ID_CHARS.index(c), 6)


def _get_id(r):
    return "".join(ID_CHARS[r.get(6)] for _ in range(r.get(4) + 1))


def _put_date(w, v):
    w.put(v == "T0", 1)
    if v != "T0":
        w.put((datetime.strptime(v, "%y%m%d").date() - EPOCH).days, 16)


def _get_date(r):
    return "T0" if r.get(1) else (EPOCH + timedelta(days=r.get(16))).strftime("%y%m%d")


def _put_number(w, v):
    frac = "." in v
    n = round(float(v) * 100) if frac else int(v)
    w.put(frac, 1)
    w.put(n.bit_length(), 5)
    if n:
        w.put(n, n.bit_length())


def _get_number(r):
    frac, length = r.get(1), r.get(5)
    n = r.get(length) if length else 0
    return f"{n / 100:.2f}" if frac else str(n)


def _put_text(w, v):
    data = v.encode("ascii")
    w.put(len(data), 7)
    for b in data:
        w.put(b, 7)


def _get_text(r):
    return bytes(r.get(7) for _ in range(r.get(7))).decode("ascii")


def _required(spec, code):
    return spec["fields"][code].get("required") or code in spec.get("required_change", [])


# --------------------------------------------------------------- pack

def pack(msg):
    errs = fc.validate(msg)
    if errs:
        raise fc.FidcodeError("; ".join(errs))
    mtype, account, ref, fields = fc.parse(msg)
    spec = fc.CB["types"][mtype]
    w = Writer()
    w.put(VERSION, 4)
    w.put(TYPES.index(mtype), nbits(len(TYPES) * 8))  # room for 8x more types
    if spec.get("account") == "required":
        _put_id(w, account)
    w.put(ref is not None, 1)
    if ref:
        _put_id(w, ref)
    for code, f in spec["fields"].items():
        present = code in fields
        if not _required(spec, code):
            w.put(present, 1)
        if not present:
            continue
        v, t = fields[code], f["type"]
        if t == "enum":
            _put_enum(w, f["enum"], v)
        elif t == "change":
            a, b = v.split(">", 1)
            for x in (a, b):
                _put_enum(w, f["enum"], x) if f.get("enum") else _put_id(w, x)
        elif t == "date":
            _put_date(w, v)
        elif t == "number":
            _put_number(w, v)
        elif t == "id":
            _put_id(w, v)
        else:
            _put_text(w, v)
    return w.to_bytes(), len(w.bits)


def unpack(data):
    r = Reader(data)
    if r.get(4) != VERSION:
        raise fc.FidcodeError("unsupported version")
    mtype = TYPES[r.get(nbits(len(TYPES) * 8))]
    spec = fc.CB["types"][mtype]
    parts = [mtype]
    if spec.get("account") == "required":
        parts.append("@" + _get_id(r))
    if r.get(1):
        parts.append("#" + _get_id(r))
    for code, f in spec["fields"].items():
        if not _required(spec, code) and not r.get(1):
            continue
        t = f["type"]
        if t == "enum":
            v = _get_enum(r, f["enum"])
        elif t == "change":
            get = (lambda: _get_enum(r, f["enum"])) if f.get("enum") else (lambda: _get_id(r))
            v = f"{get()}>{get()}"
        elif t == "date":
            v = _get_date(r)
        elif t == "number":
            v = _get_number(r)
        elif t == "id":
            v = _get_id(r)
        else:
            s = _get_text(r)
            v = f'"{s}"' if (not s or any(c in s for c in " :>@#'")) else s
        parts.append(f"{code}:{v}")
    return " ".join(parts)


def qr_svg(data, path):
    import segno
    q = segno.make(data, error="m", micro=False)
    q.save(path, scale=6, border=2)
    return q.version


def main(argv):
    if "--stats" in argv:
        import yaml
        from pathlib import Path
        exs = yaml.safe_load(Path(__file__).with_name("examples.yaml").read_text())
        print(f"{'type':8}{'prose':>8}{'text':>8}{'binary':>8}  bits")
        tot = [0, 0, 0]
        for e in exs:
            data, bits = pack(e["compact"])
            row = [len(e["prose"].encode()), len(e["compact"].encode()), len(data)]
            tot = [a + b for a, b in zip(tot, row)]
            print(f"{e['compact'].split()[0]:8}{row[0]:>8}{row[1]:>8}{row[2]:>8}  {bits}")
        print(f"{'total':8}{tot[0]:>8}{tot[1]:>8}{tot[2]:>8}   (bytes)")
        return 0
    if "--qr" in argv:
        i = argv.index("--qr")
        path, msg = argv[i + 1], argv[i + 2]
        data, bits = pack(msg)
        print(f"{bits} bits, {len(data)} bytes, QR version {qr_svg(data, path)} -> {path}")
        return 0
    data, bits = pack(argv[1])
    print(f"{bits} bits / {len(data)} bytes: {data.hex(' ')}")
    print("unpacked:", unpack(data))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
