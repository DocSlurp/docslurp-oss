# Official pricing registry refresh — 2026-10-25

OpenRouter's official `/api/v1/models` response listed 467 models. Of the 30
stored registry entries, 29 remain listed. The retained response subset is
[model-prices-2026-10-25.json](model-prices-2026-10-25.json). Prices are USD per
million tokens for the actual OpenRouter route, rather than another provider's
native API. Context windows and image-input support now come from the same response.

| Model | Previous input/output | Current input/output |
| --- | --- | --- |
| GLM 5.3 Flash | 0.048 / 0.16 | 0.15 / 0.50 |
| DeepSeek V4.1 Flash | 0.30 / 1.20 | 0.02 / 1.00 |
| Gemini 3.7 Flash | 0.375 / 1.875 | 0.75 / 3.75 |
| Gemini 3.8 Flash | 0.75 / 3.75 | 0.825 / 4.125 |
| Beam 1.0 | 0.30 / 1.00 | 0.25 / 1.00 |

MiniMax M3.1 Flash's `:free` route is absent. Its historical record remains marked
unavailable, and its runtime chat/eval price entry is removed so it cannot pass
eval admission as a verified zero-cost model. Pro/Ultra and output-price exclusions
remain in force; retained historical entries do not authorize new calls.

Runtime chat prices, vision token prices and hosted-equivalent billing references
are reconciled. The default Qwen text fallback is corrected from $0.10/$0.30 to
$0.065/$0.26. GLM's computed page estimate is now 0.073 cents for 3,000 input and
560 output tokens. Historical measured latency, throughput and page costs retain
their original provenance; this audit does not claim new performance measurements.

Native prices separately confirmed unchanged on 2026-10-25:

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing): Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50; Haiku prompts above 100k use $0.50/$2.50.
- [OpenAI embedding](https://developers.openai.com/api/docs/models/text-embedding-3-small): $0.02/M input tokens.
- [OpenAI GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini): $0.40/$1.60.
- [DeepInfra BGE-M3](https://deepinfra.com/BAAI/bge-m3): $0.010/M input tokens.

Infrastructure observations use official Fly, Modal, Tigris, Neon pricing pages
and Vast's verified rentable on-demand single-GPU API offers. Fixed prices are
unchanged. Initial live Vast medians: RTX 4090 $0.58962963/h (n=45), RTX 3090
$0.25111111/h (n=27), A100 80GB $1.00222222/h (n=7), H100 SXM $2.40266667/h (n=3).
Vast market quotes fluctuate within minutes; later validation compares a fresh
sample rather than expecting exact equality. RTX 4090 exceeds the current standard
GPU lane's $0.54/h cost ceiling and is marked disallowed in the cost policy, matching
how other uneconomic SKUs are represented. This policy catalog is not a provider
provisioning change. Customer rate-card values and worker sizing are unchanged.

Vast L4 has only two live samples (minimum three), so its historical date remains
2026-10-09. [OpenRouter pricing](https://openrouter.ai/pricing) confirms the Standard
5.5% credit-purchase fee (Business is 8%; the observation assumes Standard).
[Hugging Face pricing](https://huggingface.co/pricing) confirms the managed RTX PRO
6000 96GB quote is unchanged at $2.75/h.

App `pnpm pricing:validate` failed before these corrections (GLM reference drift
and RTX 4090 margin) and passed afterward. The app retains the full validation
report and sanitized infrastructure source snapshot. Latest local load-test
comparison (`load-test-s-on.md`, generated 2026-10-24) reports 1,268 pages/min for
1,000 pages, 45% slot utilization and -6% margin in that CPU scenario; this audit
does not generalize that run to GPU performance or revise customer pricing.

Regression checks compare retained official evidence against registry prices,
capabilities, context windows, runtime chat/vision/default-text rates and billing
references. An absent free route is also covered by server eval-admission tests.

Decision-model prices checked separately against official product pages because they
are absent from the chat-model API listing: [Jev](https://openrouter.ai/typesafe/jev-1.13)
$0.042/M input, [Clef Flash](https://openrouter.ai/cloudflare/clef-flash) standard
Cloudflare rate $0.038/M (temporary DeepInfra promotion $0.019/M is not used for
our conservative fallback), [Clef Omni](https://openrouter.ai/cloudflare/clef-omni)
$0.15/M, [GPT-6 Luna Decisions](https://openrouter.ai/openai/gpt-6-luna-decisions)
$0.10/M. [Liquid d1](https://www.liquid.ai/pricing) is corrected from $0.04/M to
$0.02/M for both native and [OpenRouter](https://openrouter.ai/liquid/d1) routes.
All have zero output-token price. [Perplexity](https://docs.perplexity.ai/docs/getting-started/pricing)
confirms the stored v1.1 alias selects v1.2 at the same $0.02/M; embedding prices
remain $0.004/M (0.6B) and $0.03/M (4B). Decision prices retain the current routing
and billing-mode behavior; no new models or benchmark performance claims are introduced.
