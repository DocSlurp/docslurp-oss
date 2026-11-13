# Speed boost

Speed boost is a request-level opt-in for faster answers and uploads. The dashboard control starts on; API and SDK requests omit it by default, which means off. Enabling it charges **4× the normal service credits** for that chat turn or ingestion run. No speed improvement is guaranteed.

## Chat: by tier

Callers choose a chat tier, never a model ([chat tiers](search-api.md#tier)). Speed boost runs on the tiers whose managed model has a reviewed fast route:

| Tier | Speed boost |
| --- | --- |
| `fastest` | Not available. A boosted request answers HTTP 400 `speed_boost_unavailable`. |
| `balanced` | Available. |
| `smart` | Not available. A boosted request answers HTTP 400 `speed_boost_unavailable`. |

The `speed_boost_unavailable` message names the tiers that support Speed boost for the project. A project whose tier mapping a DocSlurp operator changed can differ; the project record's `chatSpeedBoostTiers` lists its tiers. Boosted requests are refused rather than silently routed at normal speed, and the boost never moves the answer to another model.

```ts
await client.chat({ q: "Summarize the document", tier: "balanced", speedBoost: true });
```

For the OpenAI-compatible endpoint, put the tier and the opt-in under `docslurp`:

```json
{
  "model": "project:default",
  "messages": [{ "role": "user", "content": "Summarize the document" }],
  "docslurp": { "tier": "balanced", "speedBoost": true }
}
```

Both streaming and non-streaming chat support the opt-in. Responses report the tier that answered in `debug.model`, never a model id.

## Uploads and reprocessing

Pass the same top-level flag. The created run snapshots the choice: AI stages with a fast route use it; local processing, embeddings and other non-generation calls keep their usual routes. The run-level credit multiplier applies to the opted-in run, not only the calls that can use a fast route. Omitting the flag on a new API request does not inherit a previous dashboard choice.

```ts
await client.upload(file, { speedBoost: true });
await client.reprocessRun(runId, { speedBoost: true });
```

URL uploads, direct upload sessions and multipart uploads carry it as a top-level boolean (the multipart field uses `"true"` or `"false"`).

## Routing

A boosted request goes to the cheapest host that is fast right now, not to the fastest host at any price. The request sent to OpenRouter carries:

- `sort: "price"`;
- `preferred_max_latency: { p50: 1, p90: 2.5 }` (time to first token, seconds) and `preferred_min_throughput: { p50: 120, p90: 50 }` (tokens per second). These are OpenRouter preferences over its rolling per-host statistics: a host that misses them is tried after the hosts that meet them, never refused;
- `max_price` at the model's first-party list price. A host that reprices above it is never chosen.

Every OpenRouter request, boosted or not, also carries an output-price ceiling under the platform cap of $50 per million output tokens. A caller can lower the ceilings, never raise them. When no host is under the ceiling OpenRouter answers 404, and the call is retried once on the model's ordinary price-sorted route. Regional restrictions stay in force. An empty intersection with a narrower caller selection fails before any network access. See [OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection).

## Accounting

- **Usage:** accounting uses the provider's actual usage charge, including BYOK upstream charges, or the generation receipt. When neither receipt is available, token usage is still recorded, with an explicitly marked endpoint-ceiling estimate (`accountingStatus: receipt-missing`, `reconciliationRequired: true`).
- **Estimates are not reserves:** that endpoint-ceiling figure is an estimated expense, not a held budget reserve.
- **Manual reconciliation:** no automatic reconciliation consumer exists; an operator reconciles these rows manually using the generation ID. Exclude them from actual-cost benchmark claims.
- **Benchmarks:** a provider replay is not an end-to-end app test. Benchmark reports keep these paths apart and preserve provider identity, cache tokens, actual receipts, failures and paired sample counts.
