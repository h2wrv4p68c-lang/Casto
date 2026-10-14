# FIDCODE token benchmark

Tokenizer: **o200k_base (open tokenizer, proxy only)**. 12 sample messages from `examples.yaml`.

| Type | Prose | JSON | FIDCODE | Saving vs prose | Saving vs JSON |
|---|---:|---:|---:|---:|---:|
| KYC.U | 50 | 77 | 25 | 50% | 68% |
| TCP.U | 43 | 66 | 28 | 35% | 58% |
| ORD.B | 33 | 52 | 23 | 30% | 56% |
| ORD.R | 37 | 50 | 23 | 38% | 54% |
| ORD.X | 37 | 64 | 26 | 30% | 59% |
| TRF.I | 33 | 53 | 25 | 24% | 53% |
| SUIT.R | 41 | 55 | 22 | 46% | 60% |
| VC.H | 50 | 62 | 25 | 50% | 60% |
| CMP.R | 39 | 52 | 19 | 51% | 63% |
| ADDR.U | 44 | 67 | 28 | 36% | 58% |
| DOC.R | 35 | 43 | 20 | 43% | 53% |
| ACK | 27 | 39 | 15 | 44% | 62% |
| **Total** | **469** | **680** | **279** | **41%** | **59%** |

## One-time context cost

- Codebook as a system prompt: **1137 tokens**
- Same rules as JSON Schema (the usual way to describe JSON messages): **3763 tokens**
- Average saving per message vs prose: **15.8 tokens**
- With prompt caching, each call re-reads the codebook at about 0.1x price, about 114 token-equivalents.
- Break-even: about **7.2 messages per call** (input side). Output tokens cost about 5x input, so when the AI *writes* messages the break-even falls to about 1.4.
