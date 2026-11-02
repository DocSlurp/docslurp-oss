# Speed boost with OpenRouter Nitro

Speed boost is a request-level opt-in. The dashboard control starts on; API and SDK requests omit it by default, which means off. Enabling it charges **4× the normal service credits** for that chat turn or ingestion run. Provider expense is recorded separately from service credits and uses actual provider receipts when available. No speed improvement is guaranteed.

The eligible chat model families are:

- `z-ai/glm-5.3-flash:nitro`
- `deepseek/deepseek-v4.1-flash:nitro`
- `openai/gpt-6-luna:nitro`

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
  "model": "workspace:default",
  "messages": [{ "role": "user", "content": "Summarize the document" }],
  "docslurp": { "speedBoost": true }
}
```

The workspace must resolve to an eligible model. Both streaming and non-streaming chat support the explicit choice; SDK `chatStream` carries it as a query parameter. URL uploads, direct upload sessions and multipart uploads carry it as a top-level boolean (the multipart field uses `"true"` or `"false"`).

Nitro prioritizes throughput and admits priority service tiers; it does not guarantee lower time to first token or the same price. DocSlurp's ordinary GLM and DeepSeek paths already sort providers by price, so comparisons against the app baseline must retain that setting. See [OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection).

Nitro requests cap provider prompt pricing at $1 and completion pricing at $5 per million tokens. A caller can lower these ceilings. Existing regional restrictions remain effective; GLM and DeepSeek retain FP8-or-higher quantization, intersected with any narrower caller selection. An empty intersection fails before network access. These ceilings can exclude otherwise eligible priority endpoints.

Accounting uses the provider's actual usage charge, including BYOK upstream charges, or the generation receipt. Base-model catalog prices never estimate Nitro usage. When neither receipt is available, token usage remains recorded with an explicitly marked endpoint-ceiling estimate (`accountingStatus: receipt-missing`, `reconciliationRequired: true`). This is an estimated expense, not a held budget reserve. No automatic reconciliation consumer exists; an operator must reconcile it manually using the generation ID. Such rows must be excluded from actual-cost benchmark claims. This unresolved operational limitation keeps the feature in draft pending review and evidence.

A provider replay is not an end-to-end app test. Benchmark reports must distinguish these paths and preserve provider identity, cache tokens, actual receipts, failures, and paired sample counts.
