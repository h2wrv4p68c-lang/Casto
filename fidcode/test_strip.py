import random
from datetime import datetime

import pytest

import fidcode as fc
import strip

WHEN = datetime(2026, 10, 14, 10, 30)


def frame():
    return strip.build(strip.SAMPLE, firm_id=4417, frame_no=1, when=WHEN)


def test_always_ten_symbols_of_thirteen_bytes():
    syms = frame()
    assert len(syms) == 10 and all(len(s) == 13 for s in syms)


def test_round_trip_any_scan_order():
    syms = frame()
    random.Random(1).shuffle(syms)
    out = strip.read(syms)
    assert out["messages"] == strip.SAMPLE
    assert out["firm"] == 4417 and out["time"] == WHEN.isoformat()


def test_tampering_detected():
    syms = frame()
    s = bytearray(syms[2])
    s[5] ^= 0x01  # flip one bit in the payload
    syms[2] = bytes(s)
    with pytest.raises(fc.FidcodeError, match="seal"):
        strip.read(syms)


def test_wrong_key_detected():
    with pytest.raises(fc.FidcodeError, match="seal"):
        strip.read(frame(), key=b"another-firm")


def test_missing_symbol_detected():
    with pytest.raises(fc.FidcodeError, match="incomplete"):
        strip.read(frame()[:9])


def test_overfull_frame_rejected():
    with pytest.raises(fc.FidcodeError, match="a frame holds 96"):
        strip.build(strip.SAMPLE * 2, 1, 1, WHEN)


def test_symbols_fit_micro_qr_m4():
    segno = pytest.importorskip("segno")
    for s in frame():
        assert segno.make(s, version="M4", error="m", micro=True, boost_error=False).version == "M4"
