# Claude Haiku 5.5 for chat, and prompt caching (2026-11-13)

Two questions:

- Does Claude Haiku 5.5 (`anthropic/claude-haiku-5.5`) belong beside GPT-6 Luna in chat?
- Where does DocSlurp lose money or latency to prompts the provider never caches?

The harness is `scripts/model-calibration` (core #343), run unchanged except for the new arms below. Raw runs stay
outside the repository.

## Prices (OpenRouter models API, 2026-11-13, USD per 1M tokens)

| model | input | output | cache read | cache write (5 min) | long prompt |
|---|---:|---:|---:|---:|---|
| anthropic/claude-haiku-5.5 | 0.10 | 0.50 | 0.01 | 0.125 | above 100K: 0.50 / 2.50 |
| openai/gpt-6-luna | 0.10 | 0.50 | 0.01 | 0.125 | above 272K: 0.20 / 0.75 |
| z-ai/glm-5.3-flash (listing) | 0.04 | 0.08 | 0.03 | – | – |

Both are far below the $50 per 1M output ceiling. Every Haiku endpoint lists the same price: Anthropic, Claude
Platform on AWS, Vertex global, Bedrock and Azure global. The US and EU regional endpoints are 10% higher.

## Chat answers: GLM 5.3 Flash vs GPT-6 Luna vs Claude Haiku 5.5

The feature is `chat.answer`: the production `buildSystemInstructions` and `buildQuestionPrompt`, run through
`generateOpenRouterDocumentText` on the synthetic business corpus. There are 30 authored cases, including 4
unanswerable ones and 1 injection case, split by hash into dev (21) and held-out (9). Settings were chosen on dev;
held-out was run once.

Arms:

- `incumbent`: GLM 5.3 Flash with the production reasoning and routing.
- `luna-none`: GPT-6 Luna at effort `none`.
- `haiku-off`: Haiku with thinking off (`{ enabled: false }`, its verified floor).
- `haiku-low`: Haiku at adaptive effort `low` with 512 extra output tokens.
- `haiku-off-brief`: `haiku-off` plus the addendum in `packages/shared/src/chat-model-prompts.ts`.

Deterministic checks (all 30 cases): gold recall is 0.98 and all gold is 0.96 for every arm. No arm produced an invalid
citation, a system-prompt leak or a wrong language. `haiku-off` declines 4 of 4 unanswerable questions: the decline
regex misses one phrasing ("do not answer this question"), which is a scorer false negative.

Blinded pairwise judge (`judge.mjs`, Claude Sonnet 5.5): scores 1-5 and W/T/L are from the candidate's side.

| candidate vs baseline | split | n | candidate | baseline | W/T/L | severe errors |
|---|---|---:|---:|---:|---|---|
| haiku-off vs luna-none | dev | 20 | 4.15 | 4.60 | 7/3/10 | 1/0 |
| haiku-off vs luna-none | held-out | 9 | 4.22 | 4.78 | 2/1/6 | 0/0 |
| haiku-off vs GLM | dev | 19 | 4.26 | 4.47 | 5/6/8 | 0/0 |
| **haiku-off-brief vs luna-none** | dev | 20 | 4.55 | 4.65 | 4/11/5 | 0/0 |
| **haiku-off-brief vs luna-none** | held-out | 9 | **5.00** | 4.78 | 2/7/0 | 0/0 |
| **haiku-off-brief vs GLM** | dev | 21 | 4.62 | 4.10 | 12/5/4 | 0/0 |
| **haiku-off-brief vs GLM** | held-out | 9 | **5.00** | 4.56 | 4/5/0 | 0/0 |

- Without the addendum, Haiku's losses were all about length: unrequested background, advice and offers. No losses
  were about facts.
- Position bias: re-judging 10 `haiku-off` pairs in reverse order gave the same direction: 2/1/6 against Luna and 2/4/4 against GLM. The `-brief` arms had no swap check.
- Caveat: the judge is a Claude model judging a Claude model. The deterministic checks above do not depend on it.

Latency and cost, from measured usage. Cost is at list price; Luna's OpenRouter route is BYOK, so its router charge is
0 and the list price is used.

| arm | in / out tokens per answer | TTFT p50 | total p50 / p90 | USD per 1,000 answers | answers per $1 |
|---|---|---:|---:|---:|---:|
| GLM 5.3 Flash (as billed) | 1,669 / 89 | 1.6 s | 2.5 s / 19.8 s | 0.136 | 7,350 |
| GPT-6 Luna | 1,634 / 43 | 0.68 s | 1.17 s / 1.58 s | 0.185 | 5,416 |
| Haiku, thinking off | 2,656 / 176 | 1.2 s | 1.72 s / 2.55 s | 0.353 | 2,829 |
| Haiku, adaptive low | 2,663 / 331 | 1.6 s | 2.03 s / 3.12 s | 0.432 | 2,317 |
| **Haiku, thinking off + addendum** | 2,716 / 66 | **0.56 s** | **0.83 s / 2.3 s** | 0.304 | 3,290 |

- Haiku's tokenizer counts about 1.6x Luna's input tokens for the same prompt. At equal list prices that makes
  Haiku about 1.6x Luna's cost per answer.
- Adaptive `low` added reasoning tokens and latency with no quality gain. Thinking off is the floor ("lowest
  reasoning first").
- On `chat.search-options` (10 cases), every arm returned valid output. Haiku off took 0.67 s p50 against GLM's 3.9 s.

### Decision

- Haiku 5.5 with the addendum is a peer of Luna for chat answers, and it beats GLM 5.3 Flash on quality and latency.
- Its chat route-tier option (`tier-options.ts`) joins Luna's tiers.
- It is recommended for the second chat failover slot: `[gpt-6-luna, claude-haiku-5.5, glm-5.3-flash]`, owned by
  core #361. Haiku runs on Anthropic, Vertex and Bedrock infrastructure, separate from Luna's OpenAI and Azure.

## Prompt caching

Probe: a repeated 8.3K-token system prompt, 3 calls per shape, through OpenRouter.

| shape | Haiku 5.5 | GPT-6 Luna |
|---|---|---|
| no marker, Chat Completions | never cached | cached (automatic) |
| `cache_control` on a content part, Chat Completions | cached, call cost −88% | – |
| top-level `cache_control`, Chat Completions | cached | – |
| part marker, Responses API | **not cached** | – |
| top-level `cache_control`, Responses API | cached | – |

Haiku 5.5 caches prefixes of 512 tokens or more. A cache write costs 1.25x input; a read costs 0.1x.

GPT-6 Luna on our BYOK OpenAI route: OpenRouter reports `cache_write_tokens` of about the whole prompt on every call
of 1,024+ tokens. The upstream input charge matches the $0.125 write rate, not $0.10. Reads happened only when the
reused prefix ended at a message boundary inside the system message. Evidence in its own user message, or as a leading
content part, was never read back. Untrusted evidence stays out of the system role, so for Luna only the static
instructions are cacheable. The usage ledger now prices those writes at the write rate.

### Multi-turn chat over the same evidence

The production `generateOpenRouterDocumentText` was run as on `main` (before) and on this branch (after). Each
session has 4 turns over the same six evidence pages (about 4-6.6K prompt tokens), 2 sessions per model.

| model | cache hit before | cache hit after (turns 2-4) | USD per 1,000 turns before -> after | median latency before -> after |
|---|---:|---:|---|---|
| Claude Haiku 5.5 | 0% | 85% (97%) | 0.745 -> 0.215 (−71%) | 1.19 s -> 0.94 s |
| GLM 5.3 Flash (as billed) | 1% | 84% (95%) | 0.324 -> 0.120 (−63%) | 3.70 s -> 2.25 s |
| GPT-6 Luna | 0% | 0% | 0.417 -> 0.422 | unchanged within noise |

What changed:

- **Evidence before the question.** The order is now system, then evidence, then history and question. Before, the
  question came first and broke the prefix on every turn.
- **Evidence tags derived from the evidence.** The tag is a SHA-256 of the evidence, replacing a per-call random
  nonce. The tag is still unforgeable from document text, and the evidence bytes now repeat across turns.
- **Cache markers for Claude.** Claude calls use Chat Completions, where `createOpenRouterPromptCacheFetch` adds
  markers: the end of the system prompt, and the end of the evidence part.

## Reproduce

```sh
# Paid. In a checkout of core #343 with the arms from this record added to run.mts (and systemSuffix support in shim.mts):
tsx scripts/model-calibration/run.mts --run haiku-chat1 --features chat.answer,chat.search-options \
  --arms incumbent,luna-none,haiku-off,haiku-low --split all --budget-usd 0.8
tsx scripts/model-calibration/run.mts --run haiku-chat1 --append --features chat.answer --arms haiku-off-brief --split all --budget-usd 0.1
node scripts/model-calibration/judge.mjs --run haiku-chat1 --candidate haiku-off-brief --baseline luna-none --budget-usd 0.25
```

Integrity: `scripts/evaluation-integrity-judge.mjs` was run with an authored manifest of the 30 cases against this
branch and against `main`. Every finding on this branch also appears on `main`: generic answers such as "30 days" or
"month" occur in unrelated files. The branch adds no finding in any file it changes. The addendum is general style
guidance and names no case, document or value.
