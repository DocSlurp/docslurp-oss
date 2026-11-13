# Speed boost with OpenRouter Nitro

Speed boost is a request-level opt-in. The dashboard control starts on; API and SDK requests omit it by default, which means off. Enabling it charges **4× the normal service credits** for that chat turn or ingestion run. Provider expense is recorded separately from service credits and uses actual provider receipts when available. No speed improvement is guaranteed.

The eligible chat model families are:

- `z-ai/glm-5.3-flash:nitro`
- `deepseek/deepseek-v4.1-flash-1017:nitro`
- `openai/gpt-6-luna:nitro`

Speed boost answers with the chosen model's own Nitro variant: GLM 5.3 Flash (the default chat model) answers with `z-ai/glm-5.3-flash:nitro`, at GLM's answer tier times the Speed boost multiplier. No model is swapped for another (`SPEED_BOOST_MODEL_SWAPS` is empty), and a swap may never name a model that is never selected automatically ([model configuration](model-configuration.md#models-never-selected-automatically)). The response's `debug.model` names the model that answered.

Pass `speedBoost: true` with either the base model ID or its listed Nitro variant. Naming `:nitro` without the flag is rejected. Boosted chat requests for unsupported models are rejected rather than silently routed normally. Each variant retains its base answer tier and reasoning policy; the 4× credit multiplier is applied separately.

For uploads and reprocessing, pass the same top-level flag. The created run snapshots the choice: eligible OpenRouter AI stages use Nitro; unsupported models, local processing, embeddings and other non-generation calls keep their existing routes. The run-level credit multiplier applies to the opted-in run, not only the individual calls that can use Nitro. Omitting the flag on a new API request does not inherit a previous UI choice.

```ts
await client.chat({ q: "Summarize the document", model: "openai/gpt-6-luna", speedBoost: true });
await client.upload(file, { speedBoost: true });
await client.reprocessRun(runId, { speedBoost: true });
```

For the OpenAI-compatible endpoint, put the opt-in under `docslurp`:

```json
{
  "model": "project:default",
  "messages": [{ "role": "user", "content": "Summarize the document" }],
  "docslurp": { "speedBoost": true }
}
```

The project must resolve to an eligible model. Both streaming and non-streaming chat support the explicit choice; SDK `chatStream` carries it as a query parameter. URL uploads, direct upload sessions and multipart uploads carry it as a top-level boolean (the multipart field uses `"true"` or `"false"`).

A boosted request goes to the cheapest host that is fast right now, not to the fastest host at any price. The `:nitro` id stays DocSlurp's internal name for tiers, billing and usage; the request sent to OpenRouter names the base model (OpenRouter reads a `:nitro` suffix as a throughput sort) and carries:

- `sort: "price"`;
- `preferred_max_latency: { p50: 1, p90: 2.5 }` (time to first token, seconds) and `preferred_min_throughput: { p50: 120, p90: 50 }` (tokens per second). These are OpenRouter preferences over its rolling per-host statistics: a host that misses them is tried after the hosts that meet them, never refused;
- `max_price` at the model's first-party list price, per million tokens: DeepSeek V4.1 Flash $0.30 prompt / $1.20 completion, GLM 5.3 Flash $0.15 / $0.50, GPT-6 Luna $0.10 / $0.50. A host that reprices above it is never chosen.

Open-weight models list hosts from a fraction of their first-party price to several times it, and the spread moves; throughput sorting followed it to the top. Measured 2026-11-10 on DeepSeek V4.1 Flash 1017 (~3k-token prompt, 8 calls per route), throughput sorting answered in 1.18 s p50 at 0.118 cents a call, and this routing in 0.57 s p50 at 0.055 cents uncached (0.0045 cents with prompt-cache hits). No speed improvement is guaranteed. See [OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection).

When no host is under the ceiling OpenRouter answers 404, and the call is retried once on the model's ordinary price-sorted route. A caller can lower the ceilings. Existing regional restrictions remain effective; GLM and DeepSeek exclude FP4-class quantizations (FP8 or higher, plus hosts that do not disclose a quantization), intersected with any narrower caller selection. An empty intersection fails before network access. The ceilings exclude priority service tiers priced above them.

Accounting uses the provider's actual usage charge, including BYOK upstream charges, or the generation receipt. Base-model catalog prices never estimate Nitro usage. When neither receipt is available, token usage remains recorded with an explicitly marked endpoint-ceiling estimate (`accountingStatus: receipt-missing`, `reconciliationRequired: true`). This is an estimated expense, not a held budget reserve. No automatic reconciliation consumer exists; an operator must reconcile it manually using the generation ID. Such rows must be excluded from actual-cost benchmark claims. This unresolved operational limitation keeps the feature in draft pending review and evidence.

A provider replay is not an end-to-end app test. Benchmark reports must distinguish these paths and preserve provider identity, cache tokens, actual receipts, failures, and paired sample counts.
