from datetime import date
from pathlib import Path

import pytest
import yaml

import fidcode as fc

TODAY = date(2026, 10, 14)
EXAMPLES = yaml.safe_load(Path(__file__).with_name("examples.yaml").read_text())


@pytest.mark.parametrize("ex", EXAMPLES, ids=lambda e: e["compact"].split()[0])
def test_examples_valid(ex):
    assert fc.validate(ex["compact"]) == []


@pytest.mark.parametrize("ex", EXAMPLES, ids=lambda e: e["compact"].split()[0])
def test_round_trip(ex):
    decoded = fc.decode(ex["compact"], TODAY)
    assert fc.encode(decoded, TODAY) == ex["compact"]
    assert fc.decode(fc.encode(decoded, TODAY), TODAY) == decoded


def test_every_type_has_an_example():
    assert {e["compact"].split()[0] for e in EXAMPLES} == set(fc.CB["types"])


@pytest.mark.parametrize("msg,problem", [
    ("KYC.U @A1 RT:L>M EF:T0", "missing required field SRC"),
    ("KYC.U @A1 RT:L>Z EF:T0 SRC:MTG", "'Z' is not one of"),
    ("KYC.U RT:L>M EF:T0 SRC:MTG", "account (@...) is required"),
    ("ORD.R @A1 FND:X1 AMT:5 UN:5 ACT:TFSA SOL:U", "exactly one of AMT, UN"),
    ("ORD.B @A1 FND:X1 AMT:abc ACT:TFSA SOL:S", "expected a number"),
    ("CMP.R @A1 CAT:FEES RCV:261340 ACK:T0", "invalid date"),
    ("XYZ.Q @A1", "unknown message type"),
    ("DOC.R @A1 DOC:ID DUE:T0 ZZ:1", "not defined"),
    ('DOC.R @A1 DOC:ID DUE:T0 NOTE:"open', "unbalanced quotes"),
])
def test_rejects_bad_messages(msg, problem):
    assert any(problem in e for e in fc.validate(msg))


def test_render_is_plain_language():
    out = fc.render("ORD.B @A20511 FND:FDX101 AMT:25000 ACT:TFSA SOL:S", TODAY)
    assert "Purchase order for account A20511." in out
    assert "$25,000" in out and "TFSA" in out and "solicited" in out


def test_schemas_cover_all_types():
    for code in fc.CB["types"]:
        s = fc.json_schema(code)
        assert s["properties"]["message_type"]["const"] == fc.CB["types"][code]["name"]


def test_text_with_apostrophe_round_trips():
    d = {"message_type": "document request", "account": "A1",
         "document": "identification", "due date": "2026-11-04", "note": "client's passport"}
    assert fc.decode(fc.encode(d, TODAY), TODAY) == d
