from pathlib import Path

import pytest
import yaml

import binary as b
import fidcode as fc

EXAMPLES = yaml.safe_load(Path(__file__).with_name("examples.yaml").read_text())


@pytest.mark.parametrize("ex", EXAMPLES, ids=lambda e: e["compact"].split()[0])
def test_binary_round_trip(ex):
    data, bits = b.pack(ex["compact"])
    assert b.unpack(data) == ex["compact"]
    assert len(data) == -(-bits // 8)


def test_binary_smaller_than_text():
    for ex in EXAMPLES:
        assert len(b.pack(ex["compact"])[0]) < len(ex["compact"].encode())


def test_field_cost_is_sub_character():
    # RT change: 1 presence bit + 3 + 3 bits = 7 bits, under one 8-bit character
    base = b.pack("KYC.U @A1 EF:T0 SRC:MTG")[1]
    with_rt = b.pack("KYC.U @A1 RT:L>M EF:T0 SRC:MTG")[1]
    assert with_rt - base == 6  # presence bit is paid either way


def test_invalid_message_not_packed():
    with pytest.raises(fc.FidcodeError):
        b.pack("KYC.U @A1 RT:L>Z EF:T0 SRC:MTG")


def test_lowercase_identifier_rejected():
    with pytest.raises(fc.FidcodeError):
        b.pack("DOC.R @a1 DOC:ID DUE:T0")
