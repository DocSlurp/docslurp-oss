# MiniMax M3.1 Flash calibration (2026-11-11)

## Target behavior and release decision

Should `minimax/minimax-m3.1-flash` (OpenRouter, $0.15 / $0.60 per 1M tokens, 1M context, text + image + video)
replace the production model of any LLM feature, and what settings make it work when an operator or project
selects it?

**Decision: keep every incumbent as the default.** MiniMax fails a hard gate: it corrupts non-English output
(CJK and English fragments injected into Spanish text) on every OpenRouter host at every reasoning effort, while
the incumbents never did. Ship the compatibility calibration only, so an explicit selection
(`DOCSLURP_TEXT_MODEL`, a project's `textGeneration.model(s)`, `DOCSLURP_CHAT_EVAL_MODELS`) works instead of
failing. Before this change, selecting it for any worker text stage failed every call with HTTP 400.

## Evaluation contract

Harness: `scripts/model-calibration/` (production prompt builders and parsers, a fetch shim per arm). Corpus: six
synthetic business documents (annual report, services agreement, product manual, board minutes, a Spanish
quarterly report, an R&D memo) written once from authored fact sheets (`corpus/facts.json`); gold comes from the
fact sheets. Vision: 20 pages of the tracked synthetic PDF fixtures, scored against `doppler-md/` references
(silver: text-layer extraction). Splits: `corpus.mts split()` holds out about a third of each feature's cases by
hash; settings were chosen on dev only.

| Claim or risk | Dataset slice | Metric or gate | Scorer | Threshold | Evidence |
| --- | --- | --- | --- | --- | --- |
| Output stays in the source language, uncorrupted | Spanish document and queries | rows with CJK/Hangul/kana | regex over raw text | 0 (gate) | **Fail:** 8/93 Spanish rows across features; 3-7/10 Spanish summaries at every effort (incumbents 0/60 each); English 0/624 |
| Calls succeed when the model is selected | all features | HTTP 4xx | call records | 0 (gate) | Before fix: 100% of worker calls 400; after: 0 |
| Answers are not cut off | all features | `finish_reason=length` | call records | 0 | +0 tokens: up to 89% (HyDE); +512: 9 in 875 dev; +768: 0 in 196 held-out |
| Chat answers are grounded and cited | 30 QA cases, 4 unanswerable, 1 injection | gold-fact recall, declines, citation validity | deterministic | parity | Parity: recall 0.97 / 1.0 both, declines 100% both, no invalid citations |
| Open-ended quality | 10 generative features | blinded pairwise W/T/L, severe flags | Claude Sonnet 5.5 judge | no loss | See experiments; position-swap agreement 0.65-0.70 (noisy on short outputs) |
| Structured outputs parse | JSON features | parse/schema validity, exact match | deterministic | ≥ incumbent | Parity or better |
| Cost and latency | all | calls per $1, wall p50/p95 | provider `usage.cost`, wall clock | reported | See experiments |

## Experiments

Arms: `incumbent` (production model and routing), `mm-asis` (MiniMax with current production settings),
`mm-minimal` (effort `minimal`), `mm-minimal-r512` / `-r768` (plus 512 / 768 output tokens), `mm-low-r512`.
Dev = development split with r512; HO = held-out split with r768 (the calibrated setting). Calls per $1 from
provider-reported cost; p50 is case wall time.

| Feature (incumbent) | p50 incumbent → MiniMax (dev; HO) | Calls per $1 incumbent → MiniMax | Quality (dev; HO) | Decision |
| --- | --- | --- | --- | --- |
| Chat answer (GLM 5.3 Flash) | 6.5 s → 1.1 s; 2.4 s → 0.9 s (TTFT 2.3 → 0.5 s) | 6,880 → 3,885 | judge W/T/L 8/7/6; 3/5/1; facts and declines equal | Not default (language gate); best fit if the defect is fixed |
| Instructions Improve (GLM 5.3 Flash) | 35.7 s → 4.2 s; 24.1 s → 2.7 s | 9,399 → 2,816 | 1/0/1; 3/0/1 (n small) | Not default (language gate) |
| Search-settings parser (chat model) | 2.7 s → 0.7 s; 4.9 s → 0.6 s | 44,407 → 20,908 | valid 0.75 → 1.0; 0.83 → 1.0 | Follows the chat model; no change |
| Query rewrite (GLM) | 2.3 s → 0.7 s; 2.3 s → 1.2 s | 106,868 → 9,930 | 7/0/10; 6/1/8 | No: 11x cost, no quality gain |
| HyDE (GLM) | 3.2 s → 3.0 s; 3.4 s → 1.6 s | 42,000 → 4,190 | 2/6/11 (5 severe); 2/7/5 | No |
| Step-back (GLM) | 1.9 s → 0.6 s; 2.1 s → 0.6 s | 94,114 → 13,537 | 3/9/13; 1/1/5 | No |
| Contextual compression (GLM) | 3.1 s → 2.6 s; 2.8 s → 3.4 s | 14,229 → 1,770 | accepted 0.22 → 0.32, gold kept 0.76 → 0.80 | No: 8x cost |
| Self-query filters (GLM) | 17.9 s → 1.7 s; 3.3 s → 1.2 s | 65,041 → 4,155 | key accuracy 0.20 → 0.41; 0.50 → 1.0 (n=2) | No: 16x cost; more spurious keys |
| Bridge entities (GLM) | 2.5 s → 1.5 s; 2.3 s → 1.7 s | 13,398 → 6,652 | supported 0.69 → 0.65 | No |
| Map router (GLM) | 1.8 s → 0.5 s; 2.0 s → 0.4 s | 18,328 → 15,714 | top-1 1.0 both | Candidate: ids only, 4x faster, -14% calls per $1 |
| Document summary (Qwen 3.5 Flash) | 1.7 s → 1.8 s; 1.8 s → 1.7 s | 5,285 → 4,942 | 2/0/1 (1 severe: garbled Spanish); 3/0/0 | Not default (language gate) |
| Contextual preamble (Qwen) | 1.0 s → 0.9 s; 1.2 s → 0.7 s | 7,060 → 7,251 | 3/0/1; 0/0/2 | No |
| Propositions (Qwen) | 2.2 s → 2.8 s; 3.2 s → 2.3 s | 8,686 → 1,152 | 2/0/2; 0/0/2; one Spanish run looped to the cap | No |
| Structured extraction (Qwen) | 3.9 s → 1.9 s; 3.3 s → 2.1 s | 3,000 → 2,862 | field accuracy 1.0 both; evidence as requested objects | Parity; not default (language gate on values) |
| Graph extraction (Qwen) | 7.7 s → 6.2 s; 6.7 s → 8.2 s | 1,945 → 770 | MiniMax writes larger graphs and overflows the 1,600-token cap (80% dev) | No |
| Community summary (Qwen) | 1.8 s → 3.2 s; 3.5 s → 4.6 s | 18,676 → 5,180 | 4/0/0; 2/0/0 (judge: Qwen invents relationships) | Not default (language gate) |
| Document map (Qwen) | 4.3 s → 2.4 s | 4,200 → 2,268 | heading recall 0.23 → 0.65 (Qwen truncates at 600 tokens on 50%) | Fix the Qwen cap first (open failure) |
| Vision page (DeepSeek V4.1 Flash) | 1.6 s → 2.3 s per document (minimal) | ~1,000 → ~1,500 pages per $1 | word F1 0.92 both, number recall 1.0 both; default effort ran to 8,195 reasoning tokens | English pages only; untested on other languages |

Reasoning at `minimal` across 458 calls: p50 69, p95 372, p99 653, max 847 tokens. `reasoning.max_tokens` is
ignored and cannot be combined with `effort`. Effort `low` did not reduce truncation or improve quality over
`minimal` plus headroom.

Spend for the whole program: about $1.6 of the $10 thread budget (corpus $0.20, model runs $0.31, judge $0.92,
probes $0.17).

## Open failures and next actions

| Failure cluster | Evidence | Likely cause | Next discriminating test | Owner |
| --- | --- | --- | --- | --- |
| MiniMax injects CJK/English fragments into Spanish output | 3-7/10 Spanish summaries, all 11 hosts, every effort; incumbents 0/60 | Model defect (not quantization: first-party and FP8 hosts too) | Repeat on French, German, Japanese, Portuguese pages and chat; report upstream with samples | Eval owner |
| Qwen 3.5 Flash document-map windows truncate | 50% `length` at 600 tokens on five-page windows; map stops on malformed JSON | Cap sized for a smaller map | Raise the cap or retry once with double tokens on `length`, measure heading recall | Worker owner |
| Qwen graph extraction truncates on 12-16k-character windows | 40% `length` at 1,600 tokens (standard depth) | Cap vs window size | Same retry-on-`length` pattern as community summaries | Worker owner |
| GLM search-settings parser truncates | 25% `length` at 160 tokens (dev) | Reasoning at the floor still spends tokens on some hosts | Add a GLM reserve or raise the cap | Server owner |
| GLM latency tails on price-sorted hosts | Self-query p50 17.9 s, Improve 24-36 s, chat p95 12.9-19.7 s | Cheapest host is slow | Compare price sort with latency thresholds (as Speed boost does) | Server owner |
| `chat-model-prices.ts` GLM 5.3 Flash price is stale | Table $0.15 / $0.50; live list $0.0399 / $0.0784 | Price drop after the 2026-10-26 snapshot | `pnpm pricing:validate`, refresh the evidence snapshot | Pricing owner |
| Judge position bias | Swap agreement 0.65-0.70 | Short outputs with near-ties | Only lopsided or severity-flagged results count; rerun with two judges before any promotion | Eval owner |

## Decisions

| Date | Decision | Evidence | Revisit when |
| --- | --- | --- | --- |
| 2026-11-11 | No default changes; MiniMax stays out of the chat, search and vision catalogs | Language-corruption gate; 2-25x cost on search helpers | MiniMax ships a build that passes the multilingual probe |
| 2026-11-11 | Reasoning floor `minimal` plus a 768-token output reserve for MiniMax | 400s at `none`; 0 truncations in 196 held-out cases at +768 | Reasoning distribution shifts or a new MiniMax build |
| 2026-11-11 | Retry after "Reasoning is mandatory" drops the caller's own "reasoning off" choice | Worker calls resent effort `none` and failed twice | — |
| 2026-11-11 | Structured extraction keeps evidence written as plain strings | The default text model returned string evidence on every field, and it was dropped with its page provenance | — |
