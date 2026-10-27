# Vendor billing notifications

Customer organization credits, credit exhaustion, and delayed funding resume do
not notify operator Telegram/webhook channels. Their funding/resume UI and
backend behavior are unchanged. Legacy customer-credit notification IDs are also
dropped by the delivery function, including recovery messages.

The existing provider-fetch wrapper observes actual upstream responses for
OpenAI, OpenRouter, DeepInfra, Anthropic and Perplexity inference/embedding,
Gemini page/query embeddings, Resend authentication/run notification emails,
Fly worker-floor machine API calls, and existing Vast/DeepInfra capacity calls.
Google query-key and x-goog-api-key authentication, and FlyV1 credentials, are
matched without emitting their values. A response is eligible only on the
known vendor's HTTPS hostname, using the same credential as its configured
platform environment key. BYOK/customer keys, private endpoints, DocSlurp HTTP
402 responses and ordinary 429 rate limits are excluded. No balance is polled or
estimated, and no extra model/provider calls are made.

An upstream 402, or an explicit billing error marker (`insufficient_quota`,
`billing_hard_limit`, insufficient credits/balance) in a bounded 400/403/429
response prefix, or a bounded HTTP200 SSE top-level error object/code402, emits `docslurp.vendor.billing` to structured telemetry with
only provider, operation, normalized reason and firing/resolved state. Error
bodies, URLs, credentials, account IDs and balances are not emitted. SDK response
bytes remain unchanged. The existing Telegram bot/chat settings are reused;
`ALERT_TELEGRAM=off` disables this transport too. Storage through AWS/S3 SDKs, Stripe/customer payments, Temporal, Cloudflare,
and vendors without these instrumented transport paths are not covered.
Cohere/Voyage/Mistral have no corresponding direct configured transport here;
routed models remain attributed to the upstream router account. Add coverage
only at a verified upstream transport seam. Error previews are capped at 16 KiB
and 1 second; unavailable/truncated evidence can miss an incident and never
fabricates one.

Warnings deduplicate per process, platform credential and operation, repeat at
most every four hours, and retry failed warning or recovery delivery no more than once
a minute on new matching upstream evidence. Resolved scopes are removed after delivery (or silently when no warning was delivered). Abandoned scopes expire after 24 hours of no billing/success evidence, without a fabricated recovery. The map is bounded to 32 simultaneous active scopes. This is
**per-process** deduplication: multiple API/worker processes can each notify for
the same vendor incident. A fleet-wide persistent incident ledger is not
implemented. Process restart loses state; silence or an unrelated successful
operation never fabricates recovery. A recovery is sent only after an actual
successful response body finishes in the same credential/operation scope, with
no embedded error field, and only if that process delivered the warning. Failed recovery delivery stays pending and retries on a later matching success after cooldown. An
interrupted or cancelled response cannot resolve it. A successful request is
not a claim that a vendor balance has been topped up.

Inspect the vendor's billing console and the correlated dependency status before
acting. Do not add customer credits to fix an upstream vendor account problem.
Tests use synthetic transport responses; no live vendor failure or balance
mutation is induced. The earlier labeled Telegram delivery QA established only
transport acceptance, not an end-to-end vendor incident or funding workflow.

Primary references: [OpenAI billing versus rate-limit errors](https://developers.openai.com/api/docs/guides/error-codes),
[Resend API rate limits](https://resend.com/changelog/api-rate-limit),
[Resend usage/quota monitoring](https://www.resend.com/changelog/account-usage-api).

HTTP200 SSE failures are parsed from bounded `data:` JSON frames, accepting
only a top-level upstream `error` object. Assistant-generated text/choices never
supply billing evidence. Split frames retain at most 16 KiB per line/event;
malformed or oversized frames cannot manufacture a warning or recovery. See
[OpenRouter streaming errors](https://openrouter.ai/docs/api_reference/streaming).
