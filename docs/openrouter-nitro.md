# OpenRouter Nitro chat variants

Workspace chat accepts three explicit optional variants:

- `z-ai/glm-5.3-flash:nitro`
- `deepseek/deepseek-v4.1-flash:nitro`
- `openai/gpt-6-luna:nitro`

Defaults remain unchanged. Each variant inherits its base model's answer tier and reasoning policy. Arbitrary suffixes and other Nitro models are not accepted as workspace chat choices.

Nitro prioritizes throughput and admits priority service tiers; it does not guarantee lower time to first token or the same price. DocSlurp's ordinary GLM and DeepSeek paths already sort providers by price, so comparisons against the app baseline must retain that setting. See [OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection).

Nitro requests cap provider prompt pricing at $1 and completion pricing at $5 per million tokens. A caller can lower these ceilings. Existing regional restrictions remain effective; GLM and DeepSeek retain FP8-or-higher quantization, intersected with any narrower caller selection. An empty intersection fails before network access. These ceilings can exclude otherwise eligible priority endpoints.

Accounting uses the provider's actual usage charge, including BYOK upstream charges, or the generation receipt. Base-model catalog prices never estimate Nitro usage. When neither receipt is available, token usage remains recorded with an explicitly marked endpoint-ceiling estimate (`accountingStatus: receipt-missing`, `reconciliationRequired: true`). This is an estimated expense, not a held budget reserve. No automatic reconciliation consumer exists; an operator must reconcile it manually using the generation ID. Such rows must be excluded from actual-cost benchmark claims. This unresolved operational limitation keeps the feature in draft pending review and evidence.

A provider replay is not an end-to-end app test. Benchmark reports must distinguish these paths and preserve provider identity, cache tokens, actual receipts, failures, and paired sample counts.
