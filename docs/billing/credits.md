# Credits and metering

1 credit = 1 US cent. Customers buy prepaid credits; measured work is charged per unit. What each unit costs is the
deployment's pricing provider's ([Pricing provider](pricing-provider.md)); this page covers the metering core owns.

## Where the mechanics live

| What | Where |
| --- | --- |
| The pricing seam, its open default and loader | `packages/shared/src/pricing-provider.ts`, `pricing-open.ts`, `pricing-loader.ts` |
| Unit metrics, unit charge metadata, provider-cost receipts | `packages/shared/src/billing.ts` |
| Model list prices: evaluation and router registry | `scripts/lib/model-prices.json`, with the retained official responses in `docs/evals/model-prices-<date>.json` |
| Live OpenRouter list prices for usage without a receipt | `packages/shared/src/live-model-prices.ts` |
| Hardcoded fallback model prices used when no live price is loaded | `packages/shared/src/chat-model-prices.ts`, `defaultAiUsagePricingCatalog` in `packages/shared/src/usage.ts` |
| Spend attribution for budgets, limits and billing | `server/src/services/usage-attribution.ts` |

Entries marked `prohibited` in `model-prices.json` (OpenAI Pro/Ultra, or output at or above $50 per 1M tokens) are
kept only as historical evidence. `packages/shared/src/__tests__/prohibited-models.test.ts` fails if a catalog, default,
preset or the page router can select one.

## Provider cost

Unit charges are what customers pay; what providers charge us is recorded separately on each AI Usage Event as
`metadata.providerCostCents`, with `costSource` (`provider` or `estimate`), and never debits credits.

### Loss alerts

The alert leader compares, every 5 minutes, what each chat turn, finished run and search session charged in credits
with its provider cost (receipts, or list-price estimates where no receipt arrived). A generated aggregate-search answer
(`POST /v1/search/aggregate` with `generateAnswer`) is one item too: its model cost and its charge carry the same
`metadata.chatTurnId`.

- Each item whose provider cost exceeds its credits logs `[billing] provider_cost_loss` and emits the
  `docslurp.billing.provider_cost_loss` telemetry event once (`info` for refunded turns, `warn` otherwise).
- An organization whose losses over the last hour, refunded turns excluded, reach `ALERT_PROVIDER_LOSS_CENTS`
  (default 100, so $1) fires the `provider-cost-loss:<orgId>` alert through the normal tracker and Telegram/webhook
  delivery. It resolves when the hour's losses fall below the threshold.

It runs only where billing is enforced. `ALERT_PROVIDER_LOSS_CENTS=0` turns it off; `ALERT_PROVIDER_LOSS_INTERVAL_MS`
(default 300000) and `ALERT_PROVIDER_LOSS_SETTLE_MS` (default 120000) tune it. The query is `providerCostLossItems` in
`server/src/services/usage-attribution.ts`.

## Billing latency

Billed checkpoints append to `credit_debits_pending` and do not lock the organization row. A flusher applies each
organization's pending rows in one transaction: the worker maintenance leader about every 2 s, the app sweeper about
every 5 s. Balances can therefore lag spend by a few seconds. See migration `0030_pending_credit_debits.sql`.

## Credit leases

A run holds an organization-level credit lease that is sized from its burn rate and renewed at checkpoints. A crashed
worker's lease lapses after its TTL. Leases are off in production unless `WORKER_CREDIT_LEASES=on`; with them off, the
worker keeps the `WORKER_SPEND_CHECK_PAGES` / `_CREDITS` cadence check. See `packages/shared/src/credit-leases.ts` and
migration `0052_credit_leases.sql`.

## Chat reserve and overdraft

Ingestion and automation never spend an organization's last `reserve` credits, so an organization can still chat and
search over what it uploaded. Interactive spend may carry a small negative balance (the overdraft), which the next
top-up pays first. See `packages/shared/src/chat-reserve.ts` and migration `0053_chat_credit_reserve.sql`.

A job that is already running may finish below zero: credit leases, the worker's mid-run check and media admission let
it use the chat reserve and take the balance down to `-RUN_CREDIT_OVERDRAFT_CREDITS` (default 25 credits, $0.25), then
pause it. New runs are still admitted only above the reserve. The balance shows the negative amount, and the next
purchase pays it first. Set `RUN_CREDIT_OVERDRAFT_CREDITS=0` (on the worker) to pause running jobs at zero. See
migration `0137_run_completion_overdraft.sql`.

## Run admission

Credits are checked atomically when the run row is inserted (`admitRunSpend`). An admitted run is paused, not failed,
when the balance goes negative mid-run (`server/src/services/run-creation.ts`).

## Stripe

Credits are prepaid packs bought through one-off Checkout payments. There are no plans or subscriptions. The server's
Stripe client pins the API version (`server/src/services/billing/stripe-client.ts`); a webhook endpoint must use the
same version.
