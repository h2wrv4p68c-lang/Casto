"""Compare token counts for the same messages as prose, JSON and FIDCODE.

Uses Anthropic's token-counting endpoint when credentials are available
(ANTHROPIC_API_KEY etc.); otherwise falls back to the open o200k_base
tokenizer as a proxy and says so in the output.

    python benchmark.py > RESULTS.md
"""
import json
import os
from datetime import date
from pathlib import Path

import yaml

import fidcode as fc

TODAY = date(2026, 10, 14)
MODEL = "claude-opus-5-5"
CACHE_READ_MULTIPLIER = 0.1  # cache reads bill at ~0.1x base input price


def make_counter():
    if any(os.environ.get(k) for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")):
        import anthropic
        client = anthropic.Anthropic()
        base = client.messages.count_tokens(
            model=MODEL, messages=[{"role": "user", "content": "x"}]).input_tokens

        def count(text):
            n = client.messages.count_tokens(
                model=MODEL, messages=[{"role": "user", "content": text}]).input_tokens
            return n - base + 1
        return count, f"Anthropic count_tokens ({MODEL})"
    import tiktoken
    enc = tiktoken.get_encoding("o200k_base")
    return (lambda t: len(enc.encode(t))), "o200k_base (open tokenizer, proxy only)"


def main():
    count, source = make_counter()
    examples = yaml.safe_load(Path(__file__).with_name("examples.yaml").read_text())
    rows, tot = [], {"prose": 0, "json": 0, "compact": 0}
    for ex in examples:
        compact = ex["compact"]
        js = json.dumps(fc.decode(compact, TODAY))
        n = {"prose": count(ex["prose"]), "json": count(js), "compact": count(compact)}
        for k in tot:
            tot[k] += n[k]
        rows.append((compact.split()[0], n))

    prompt = fc.codebook_prompt()
    schemas = json.dumps({c: fc.json_schema(c) for c in fc.CB["types"]})
    c_prompt, c_schema = count(prompt), count(schemas)

    pct = lambda a, b: f"{100 * (1 - a / b):.0f}%"
    print(f"# FIDCODE token benchmark\n\nTokenizer: **{source}**. "
          f"{len(examples)} sample messages from `examples.yaml`.\n")
    print("| Type | Prose | JSON | FIDCODE | Saving vs prose | Saving vs JSON |")
    print("|---|---:|---:|---:|---:|---:|")
    for t, n in rows:
        print(f"| {t} | {n['prose']} | {n['json']} | {n['compact']} | "
              f"{pct(n['compact'], n['prose'])} | {pct(n['compact'], n['json'])} |")
    print(f"| **Total** | **{tot['prose']}** | **{tot['json']}** | **{tot['compact']}** | "
          f"**{pct(tot['compact'], tot['prose'])}** | **{pct(tot['compact'], tot['json'])}** |\n")

    saving = (tot["prose"] - tot["compact"]) / len(examples)
    per_call = c_prompt * CACHE_READ_MULTIPLIER
    print("## One-time context cost\n")
    print(f"- Codebook as a system prompt: **{c_prompt} tokens**")
    print(f"- Same rules as JSON Schema (the usual way to describe JSON messages): **{c_schema} tokens**")
    print(f"- Average saving per message vs prose: **{saving:.1f} tokens**")
    print(f"- With prompt caching, each call re-reads the codebook at about "
          f"{CACHE_READ_MULTIPLIER}x price, about {per_call:.0f} token-equivalents.")
    print(f"- Break-even: about **{per_call / saving:.1f} messages per call** "
          f"(input side). Output tokens cost about 5x input, so when the AI *writes* "
          f"messages the break-even falls to about {per_call / (saving * 5):.1f}.")


if __name__ == "__main__":
    main()
