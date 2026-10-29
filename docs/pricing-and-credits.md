# Pricing and credits

This is the index for pricing, credits and metering. Code is the source of truth, and this page names the
module behind each rule that code comments cite. 1 credit = 1 US cent.

## Where the numbers live

| What | Where |
| --- | --- |
| Credit rate card (`CREDIT_RATE_CARD`), page prices (`PRICE_CARD`), starter credits, worker slots | `packages/shared/src/billing.ts` |
| Flat Extract tiers and private dedicated capacity | `packages/shared/src/extract-pricing.ts` |
| What the infrastructure costs (`INFRA_COST_OBSERVATIONS`), the margin policy every list price must meet (`RESOURCE_CLASS_POLICY`), the slot cost basis (`WORKER_SLOT`) | `packages/shared/src/infra-costs.ts` |
| Model list prices: evaluation and router registry | `scripts/lib/model-prices.json`, with the retained official responses in `docs/evals/model-prices-<date>.json` |
| Chat model prices used when a usage receipt is missing | `packages/shared/src/chat-model-prices.ts` (a test keeps it equal to `model-prices.json`) |
| Vision model token prices and per-page estimates | `visionModelCatalog` in `packages/shared/src/embedding.ts` |
| Spend attribution for budgets, limits and billing | `server/src/services/usage-attribution.ts` |

Entries marked `prohibited` in `model-prices.json` (OpenAI Pro/Ultra, or output at or above $50 per 1M tokens) are
kept only as historical evidence. `packages/shared/src/__tests__/prohibited-models.test.ts` fails if a catalog,
default, preset or the page router can select one.

Rate-card and plan changes are owner decisions. Before you change `CREDIT_RATE_CARD`, `SERVICE_PLANS`,
`INFRA_COST_OBSERVATIONS` or worker sizing, run `pnpm pricing:validate` in DocSlurp/app and compare the result with
the latest load test. `pnpm pricing:watch` there tracks model prices and where each model is hosted.

## Processing quality

`pipeline.quality` (`packages/shared/src/quality.ts`) is the public extraction choice, and `QUALITY_MODES`
(`billing.ts`) prices it from `PRICE_CARD`:

| Quality | Billing | Per 1,000 pages |
| --- | --- | --- |
| `fast` | Text layer only. Pages without one keep their page image, are never OCR'd or read by a model, and bill Fast (`splitRemainingPages` in `worker/src/db/page-base-fee.ts`). | $0.05 |
| `auto` (default) | Text pages bill Fast; pages a model reads, and unread scans and image files, bill Rich. | $0.05 to $2.50 |
| `good` | Vision reads every page, so every page bills Rich, plus `richPagesForOutputTokens` for long output. | $2.50 |

`PIPELINE_PROFILES` (the `estimateIngest` page-class model) is keyed by the same ids, so estimator ranges match the
catalog: `billing.test.ts` checks every mix stays inside its mode's range. A quality picker shows
`qualityModePriceRange(mode)`. Parser playbooks are internal (`parserPlaybookForQuality`).

## Flat Extract tiers

Extract pages sell at a flat price per page. A hosted route may serve a flat-tier page only when its token prices
put it at or under the tier's route cost cap (`isRouteEligibleForFlatTier`), and unknown prices fail closed. The
estimate is `SELF_HOSTED_PAGE_TOKENS` (1,500 input and 800 output tokens) at the route's token prices. For a vision
model whose profile pins providers, those are the pinned route's prices, not the model's list price. Pages that
escalate to an ineligible route are billed at metered rates on top of the flat price.

## Billing latency

Billed checkpoints append to `credit_debits_pending` and do not lock the organization row. A flusher applies each
organization's pending rows in one transaction: the worker maintenance leader about every 2 s, the app sweeper about
every 5 s. Balances can therefore lag spend by a few seconds. See migration `0030_pending_credit_debits.sql`.

## Credit leases

A run holds an organization-level credit lease that is sized from its burn rate and renewed at checkpoints. A
crashed worker's lease lapses after its TTL. Leases are off in production unless `WORKER_CREDIT_LEASES=on`; with
them off, the worker keeps the `WORKER_SPEND_CHECK_PAGES` / `_CREDITS` cadence check. See
`packages/shared/src/credit-leases.ts` and migration `0052_credit_leases.sql`.

## Chat reserve and overdraft

Ingestion and automation never spend an organization's last `reserve` credits, so an organization can still chat and
search over what it uploaded. Interactive spend may carry a small negative balance (the overdraft), which the next
top-up pays first. Defaults are $3 for funded organizations and $1 for starter ones. See
`packages/shared/src/chat-reserve.ts` and migration `0053_chat_credit_reserve.sql`.

## Gotchas

7. Credits are checked atomically when the run row is inserted (`admitRunSpend`). An admitted run is paused, not
   failed, when the balance goes negative mid-run (`server/src/services/run-creation.ts`).

## Stripe

Credits are prepaid packs bought through one-off Checkout payments. There are no plans or subscriptions. The webhook
endpoint is created by `scripts/stripe-sync-billing.mjs --webhook-url <url>` in DocSlurp/app. That script pins the
endpoint to the API version the server's Stripe client uses (`server/src/services/billing/stripe-client.ts`), so
move both together.

### End-to-end test

`scripts/billing-e2e.mjs` in DocSlurp/app tests the integration in Stripe test mode against a running app on a
development database. Its header lists the required environment.
