"""A fixed ten-symbol FIDCODE frame of Micro QR codes.

Every frame is exactly ten Micro QR symbols (version M4, error level M,
17 x 17 modules, 13 bytes each). Byte 0 of each symbol holds its position
and the frame length, so symbols can be scanned in any order.

    symbol 0      header: format, codebook version, firm, frame no., time
    symbols 1-8   payload: up to 96 bytes of length-prefixed messages
    symbol 9      seal: 96-bit HMAC-SHA256 tag over header and payload

    python strip.py out/strip.png      # render the sample client-meeting frame
"""
import hashlib
import hmac
import io
import struct
import sys
from datetime import datetime, timedelta

import binary
import fidcode as fc

SYMBOLS, SYMBOL_BYTES = 10, 13
DATA = SYMBOL_BYTES - 1                 # 12 bytes after the position byte
PAYLOAD = DATA * (SYMBOLS - 2)          # 96 bytes
MAGIC = 0xFD
EPOCH = datetime(2000, 1, 1)
DEMO_KEY = b"demo-key-not-for-production"


def build(messages, firm_id, frame_no, when, key=DEMO_KEY):
    body = b""
    for m in messages:
        data, _ = binary.pack(m)
        body += bytes([len(data)]) + data
    if len(body) > PAYLOAD:
        raise fc.FidcodeError(f"messages need {len(body)} bytes; a frame holds {PAYLOAD}")
    body = body.ljust(PAYLOAD, b"\0")
    minutes = int((when - EPOCH).total_seconds() // 60)
    header = struct.pack(">BBIHI", MAGIC, binary.VERSION, firm_id, frame_no, minutes)
    seal = hmac.new(key, header + body, hashlib.sha256).digest()[:DATA]
    chunks = [header] + [body[i:i + DATA] for i in range(0, PAYLOAD, DATA)] + [seal]
    return [bytes([(i << 4) | SYMBOLS - 1]) + c for i, c in enumerate(chunks)]


def read(symbols, key=DEMO_KEY):
    """Reassemble symbols (any order), verify the seal, return frame contents."""
    by_pos = {s[0] >> 4: s[1:] for s in symbols}
    if sorted(by_pos) != list(range(SYMBOLS)):
        raise fc.FidcodeError(f"frame incomplete: have positions {sorted(by_pos)}")
    header, seal = by_pos[0], by_pos[SYMBOLS - 1]
    body = b"".join(by_pos[i] for i in range(1, SYMBOLS - 1))
    expect = hmac.new(key, header + body, hashlib.sha256).digest()[:DATA]
    if not hmac.compare_digest(seal, expect):
        raise fc.FidcodeError("seal does not match: frame altered or wrong key")
    magic, ver, firm, frame_no, minutes = struct.unpack(">BBIHI", header)
    if magic != MAGIC:
        raise fc.FidcodeError("not a FIDCODE frame")
    msgs, i = [], 0
    while i < len(body) and body[i]:
        n = body[i]
        msgs.append(binary.unpack(body[i + 1:i + 1 + n]))
        i += 1 + n
    return {"codebook_version": ver, "firm": firm, "frame": frame_no,
            "time": (EPOCH + timedelta(minutes=minutes)).isoformat(), "messages": msgs}


def render(symbols, path, scale=8):
    import segno
    from PIL import Image
    imgs = []
    for s in symbols:
        buf = io.BytesIO()
        segno.make(s, version="M4", error="m", micro=True, boost_error=False).save(
            buf, kind="png", scale=scale, border=2)
        buf.seek(0)
        imgs.append(Image.open(buf).convert("RGB"))
    gap = scale * 2
    w = sum(i.width for i in imgs) + gap * (len(imgs) - 1)
    strip = Image.new("RGB", (w, imgs[0].height), "white")
    x = 0
    for im in imgs:
        strip.paste(im, (x, 0))
        x += im.width + gap
    strip.save(path)


SAMPLE = [  # one client meeting, A10293
    "KYC.U @A10293 RT:L>M TH:5-10>10+ EF:T0 SRC:MTG",
    'TCP.U @A10293 NM:"Priya Sharma" REL:CH PH:416-555-0142 CON:Y EF:T0',
    "ADDR.U @A10293 TYP:RES PROV:ON PC:M5V2T6 VER:ID EF:T0",
    "SUIT.R @A10293 TRG:KYC RES:S ACTN:NONE DT:T0",
]

if __name__ == "__main__":
    syms = build(SAMPLE, firm_id=4417, frame_no=1, when=datetime(2026, 10, 14, 10, 30))
    render(syms, sys.argv[1] if len(sys.argv) > 1 else "out/strip.png")
    print(read(syms))
