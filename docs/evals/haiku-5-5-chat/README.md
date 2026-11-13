# Claude Haiku 5.5 for chat, and prompt caching (2026-11-13)

Two questions:

- Is Claude Haiku 5.5 (`anthropic/claude-haiku-5.5`) a usable peer of GPT-6 Luna for chat answers?
- Where does DocSlurp pay for prompts the provider could have served from its prompt cache?

Harness: `scripts/model-calibration` (core #343), with the arms below added. Raw runs stay outside the repository.
Measurements are small (tens of cases); read every quality number as "no worse than" unless a row says otherwise.

## Prices (OpenRouter models API, 2026-11-13, USD per 1M tokens)

| model | input | output | cache read | cache write (5 min) | long prompt |
|---|---:|---:|---:|---:|---|
| anthropic/claude-haiku-5.5 | 0.10 | 0.50 | 0.01 | 0.125 | above 100K: 0.50 / 2.50 |
| openai/gpt-6-luna | 0.10 | 0.50 | 0.01 | 0.125 | above 272K: 0.20 / 0.75 |
| z-ai/glm-5.3-flash (listing) | 0.04 | 0.08 | 0.03 | – | – |

- Both are far below the $50 per 1M output ceiling.
- Every global Haiku endpoint lists the same price. The US and EU regional endpoints are 10% higher.
- Observed: GPT-6 Luna input is billed at the listed cache-write rate whenever a prompt of 1,024+ tokens is written and
  not read back. Costs below price Luna that way.

## Chat answers: GLM 5.3 Flash vs GPT-6 Luna vs Claude Haiku 5.5

**Setup**

- Feature `chat.answer`: the production `buildSystemInstructions`, `buildQuestionPrompt` and
  `generateOpenRouterDocumentText` on the synthetic business corpus.
- 30 authored cases, including 4 unanswerable and 1 injection case, hash-split into dev (21) and held-out (9).
- Arms:
  - `incumbent`: GLM 5.3 Flash, production reasoning and routing.
  - `luna-none`: GPT-6 Luna, effort `none`.
  - `haiku-off`: Haiku, thinking off, which is its floor.
  - `haiku-low`: Haiku at effort `low`.
  - `haiku-off-brief`: Haiku plus the length addendum (core #373, `chat-model-prompts.ts`).

**Held-out limits**

- Held-out was run for several arms, including `haiku-off`, before the addendum was written.
- The addendum was designed after seeing Haiku's losses on all 30 cases. Held-out is therefore not a clean confirmation
  of the addendum, and n = 9 with mostly ties.

**Deterministic checks (all arms, all 30 cases)**

- Gold recall 0.98; all gold present 0.96.
- No invalid citations, system-prompt leaks or wrong-language answers.
- Every arm declines all four unanswerable questions. The decline regex misses the phrasing "do not answer this"; read
  by hand, all four arms declined.

**Pairwise judge** (first round, Claude Sonnet 5.5 as judge, so a Claude model judged a Claude model). Scores 1-5;
W/T/L from the candidate's side.

| candidate vs baseline | split | n | candidate | baseline | W/T/L |
|---|---|---:|---:|---:|---|
| haiku-off vs luna-none | dev | 20 | 4.15 | 4.60 | 7/3/10 |
| haiku-off-brief vs luna-none | dev | 20 | 4.55 | 4.65 | 4/11/5 |
| haiku-off-brief vs luna-none | held-out | 9 | 5.00 | 4.78 | 2/7/0 |
| haiku-off-brief vs GLM | dev | 21 | 4.62 | 4.10 | 12/5/4 |
| haiku-off-brief vs GLM | held-out | 9 | 5.00 | 4.56 | 4/5/0 |

Reading:

- Without the addendum, Haiku lost on length (unrequested background, advice and offers), not on facts.
- With it, Haiku is **no worse than Luna** on these cases. It scored ahead of GLM on dev, though the cases are few and
  the judge was a Claude model.

**Latency and cost per answer** (measured usage; Luna at its effective write-rate input; GLM as billed)

| arm | in / out tokens | TTFT p50 | total p50 / p90 | answers per $1 |
|---|---|---:|---:|---:|
| GLM 5.3 Flash | 1,669 / 89 | 1.6 s | 2.5 s / 19.8 s | 7,350 |
| GPT-6 Luna | 1,634 / 43 | 0.68 s | 1.17 s / 1.58 s | 4,430 |
| Haiku, thinking off | 2,656 / 176 | 1.2 s | 1.72 s / 2.55 s | 2,829 |
| Haiku, thinking off + addendum | 2,716 / 66 | 0.56 s | 0.83 s / 2.3 s | 3,290 |

- Haiku's tokenizer counts about 1.6x Luna's input tokens for the same prompt.
- With Luna billed at its effective rate, Haiku costs about 1.35x Luna per answer.
- Adaptive effort `low` added reasoning tokens and latency, with no quality gain.

### Shipped prompt order re-run (second round)

Core #370 changes the direct-answer prompt for every model:

- The evidence now comes before the history and question.
- Evidence tags are keyed per org.
- Claude goes through Chat Completions.

Re-run: `chat.answer` on all 30 cases, main's order vs the branch's order for each model. Haiku carries the addendum on
both sides. The judge was **GPT-6.1 Sol** (not a Claude model), on dev, with a 6-pair order-swap check per model.

| model | gold recall (main → branch) | declines | branch vs main judge (dev, n = 21) | W/T/L |
|---|---|---|---|---|
| GLM 5.3 Flash | 0.98 → 0.98 | 4/4 → 4/4 | +0.05 ± 0.32 | 10/4/7 |
| GPT-6 Luna | 0.98 → 0.98 | 4/4 → 4/4 | +0.00 ± 0.19 | 4/15/2 |
| Claude Haiku 5.5 | 0.98 → 0.98 | 4/4 → 4/4 | −0.10 ± 0.19 | 3/14/4 |

- Intervals are 95% normal approximations, and all include zero. No model regressed, so the order ships for all three.
- One severe flag, on the GLM branch side: on one case GLM speculated that a missing fact sits in an unsupplied part of
  the document.
- Gold-passage citation varied by one or two cases per model in each direction. In every such case the answer cited a
  sibling passage holding the same fact.

### Agent-path disclosure slice

Setup:

- Haiku, thinking off, with the agent's static rules and simulated tool results.
- Six cases, two repeats each: failed tool, partially failed search, coverage gap, unanswerable, unavailable action and
  a normal answer.

Result:

- With the addendum, including its disclosure carve-out, Haiku disclosed 12/12, at 90 output tokens per answer.
- Without it, Haiku disclosed 12/12 on reading (10/12 by regex; both misses were phrasing), at 121 output tokens.

## Prompt caching

### What caches through OpenRouter

Probe: a repeated 8.3K-token system prompt, 3 calls per shape.

| shape | Haiku 5.5 | GPT-6 Luna |
|---|---|---|
| no marker, Chat Completions | never cached | cached a prefix that ends in the system message |
| marker on a content part, Chat Completions | cached; call cost −88% on a hit | – |
| top-level `cache_control`, Chat Completions | cached | – |
| part marker, Responses API | not cached | – |

Other facts that shape the design:

- Haiku 5.5 caches prefixes of 512+ tokens. OpenAI-family models need 1,024+.
- A cache write costs 1.25x input; a read costs 0.1x.
- Luna read back only a prefix that ended inside the system message. Evidence in its own user message, or as a leading
  content part, was never read.
- `prompt_cache_key` changed nothing in these probes.

### Chat with real re-retrieval (what #370 ships)

Each follow-up turn re-runs retrieval: top 5 corpus pages by term overlap with the new question. Setup: 3 sessions of
4 turns, in production prompt shape.

| model and policy | cache hit | billed as cache write | answers per $1 (main → branch) |
|---|---:|---:|---|
| Haiku, system and evidence markers (first version) | 11% | 82% | 1,572 → 1,476 (−6%) |
| **Haiku, system marker only (shipped)** | 12% | 0% | **1,572 → 1,733 (+10%)** |
| GLM 5.3 Flash (automatic caching) | no reads reported | – | 1,664 → 1,941 (host variance; no measured cache effect) |
| GPT-6 Luna (automatic caching) | 0% | 99.9% | 2,420 → 2,463 (unchanged) |

- Evidence rarely repeats when retrieval re-runs, so marking it paid the write premium for nothing. Only the system
  prompt is marked.
- The earlier best case was 97% hits and −71% cost for Haiku. It required follow-ups over byte-identical evidence,
  such as whole-corpus chat or `documentIds`. It is an upper bound, not the expected effect.
- Production hit rates will come from `cachedInputTokens` / `cacheWriteInputTokens` in usage metadata and from the new
  span attributes.

### Page and chart reads

Shipped shape:

- System message: the fixed instruction line plus the template or chart spec prompt, byte-identical across pages,
  documents and tenants.
- User message: the image, then any per-request text (schema labels, a chart digest).

**Page reads** (8 rendered fixture pages; 4 fresh pages for Luna, since 4 were replays of an earlier probe):

| model | prefix read | pages per $1 (old shape → new) | output vs old shape |
|---|---|---|---|
| Claude Haiku 5.5 | 778 tokens from page 2 on | 1,894 → 2,147 (+13%) | same content; formatting differences on 2 pages |
| GPT-6 Luna | none (~600-token prefix, under the 1,024 minimum) | 1,969 → 1,981 (unchanged) | word F1 0.95-1.0 per page |

**Luna probe with a fixed prefix padded to 1,450 tokens:**

- Luna reads it from the second page on, and input on warm pages falls ~12%.
- The padding adds the tokens it saves, so pages per $1 barely moved: 2,129 → 2,142.
- Making Luna page reads cacheable would need a genuinely longer fixed prompt, evaluated for quality. It is not done
  here.

**Chart reads** (held-out, 60 charts, SPEC_V2, derived mode):

| model | input served from cache | spec score (old → new) | visuals per $1 (old → new) |
|---|---:|---|---|
| GPT-6 Luna | 0% | 0.976 → 0.983 | 3,605 → 3,552 |
| Claude Haiku 5.5 | 65% | 0.979 → 0.964 | 2,786 → 3,751 (+35%) |

- Haiku's drop is almost all one chart, where it returned null values (a decline) instead of readings. Across the other
  59 charts the mean change is −0.004.

### Accounting

- Usage events carry `cachedInputTokens` and `cacheWriteInputTokens` in metadata.
- The `[ai-usage]` line appends `cached_input_tokens=` and `cache_write_input_tokens=` when present.
- Estimates price reads and writes at the listed cache rates. Unknown rates err high: reads at the input rate, writes
  at 1.25x.
- Provider receipts still win.

## Reproduce

```sh
# Paid. In a checkout of core #343 with this record's arms in run.mts and systemSuffix support in shim.mts:
tsx scripts/model-calibration/run.mts --run h1 --features chat.answer --arms incumbent,luna-none,haiku-off --split all --budget-usd 0.15
CALIBRATION_JUDGE=openai/gpt-6.1-sol node scripts/model-calibration/judge.mjs --run h1 --candidate <arm@branch> --baseline <arm@main> --swap-check 6
```

## Integrity

`scripts/evaluation-integrity-judge.mjs` passes on this branch (30 cases, 0 findings, 0 candidates). The authored
manifest is outside this repository. It uses specific label names and document-specific gold: a number with its unit,
or the source's wording. No gold string occurs in ordinary repository text, and none is quoted in code; a test fixture
that had quoted one was changed.

- Re-scoring the stored `chat.answer` outputs with this gold changes no quality number above.
- The addendum is general style guidance and names no case, document, field or value.
