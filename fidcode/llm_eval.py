"""Measure how accurately Claude reads and writes FIDCODE.

Two tasks per example in examples.yaml:
  decode: FIDCODE message  -> JSON, compared with fidcode.decode()
  encode: prose instruction -> FIDCODE message, which must validate and
          decode to the same content as the reference message

Requires Anthropic API credentials. Each run makes 2 calls per example
(24 calls for the current sample set). The codebook system prompt is cached.

    pip install anthropic pyyaml
    python llm_eval.py
"""
import json
from datetime import date
from pathlib import Path

import anthropic
import yaml

import fidcode as fc

MODEL = "claude-opus-5-5"
TODAY = date(2026, 10, 14)

SYSTEM = [{
    "type": "text",
    "text": fc.codebook_prompt() + (
        "\n\nYou translate between FIDCODE and other forms. Reply with the "
        "requested output only: no commentary, no code fences."),
    "cache_control": {"type": "ephemeral"},
}]

client = anthropic.Anthropic()


def ask(prompt):
    resp = client.beta.messages.create(
        model=MODEL,
        max_tokens=2000,
        system=SYSTEM,
        output_config={"effort": "low"},
        betas=["server-side-fallback-2026-07-01"],
        extra_body={"fallbacks": "default"},
        messages=[{"role": "user", "content": prompt}],
    )
    if resp.stop_reason == "refusal":
        return None, resp.usage
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    return text, resp.usage


def main():
    examples = yaml.safe_load(Path(__file__).with_name("examples.yaml").read_text())
    ok = {"decode": 0, "encode": 0}
    cached = 0
    for ex in examples:
        ref = fc.decode(ex["compact"], TODAY)
        keys = ", ".join(f'"{k}"' for k in ref)

        out, usage = ask(
            f"Today is {TODAY.isoformat()}. Decode this FIDCODE message to a flat "
            f"JSON object using these keys: {keys}. Use full enum labels, ISO "
            f"dates, numbers as numbers, and changes as {{\"from\":..,\"to\":..}}."
            f"\n\n{ex['compact']}")
        cached += usage.cache_read_input_tokens or 0
        try:
            good = out is not None and json.loads(out) == ref
        except json.JSONDecodeError:
            good = False
        ok["decode"] += good
        print(f"decode {'PASS' if good else 'FAIL'}  {ex['compact']}" + ("" if good else f"\n   got: {out}"))

        out, usage = ask(f"Today is {TODAY.isoformat()}. Write this as one FIDCODE "
                         f"message:\n\n{ex['prose']}")
        cached += usage.cache_read_input_tokens or 0
        try:
            good = out is not None and fc.decode(out, TODAY) == ref
        except fc.FidcodeError:
            good = False
        ok["encode"] += good
        print(f"encode {'PASS' if good else 'FAIL'}  {ex['compact']}" + ("" if good else f"\n   got: {out}"))

    n = len(examples)
    print(f"\nDecode accuracy: {ok['decode']}/{n}   Encode accuracy: {ok['encode']}/{n}")
    print(f"Cached input tokens read: {cached}")


if __name__ == "__main__":
    main()
