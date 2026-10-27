# Router revenue parity, 2026-10-27

Council Architect finding on OSS PR184, original head `92efa03a7a3b5346aed9a7ed493d0bdab32a7b58`.

## Receipt trace and resolution

`worker/src/pipeline/local-compute-cost.ts:buildLocalComputeUsageEvent` records provider cost and internal resource-list credits but always stamps `billable: false`, even with `DOCSLURP_BILL_COMPUTE=true`. `packages/shared/src/billing.ts:priceAiUsageEvent` likewise makes provider AI receipts cost-only. `worker/src/pipeline/usage-ledger.ts` bills PRICE_CARD Rich pages once per run/page (including output-token units); Fast pages are billed at completion in `worker/src/db/page-base-fee.ts`. Extract tiers have separate page prices. These receipts do not support either hypothetical slot/GPU list revenue or provider AI markup revenue.

The router has assignment costs, scopes and cascade expectations, but lacks run-level mode/tier and page-charge deduplication context. The fix therefore sets resource-level billed revenue to zero for CPU, GPU, hosted AI and decision calls. Costs, corrections and margin-floor logic are retained. Positive floors can defer positive-cost work; zero-floor cost-only plans still work. This is a conservative bound, not a claim that customer pages generate no revenue. Any future page/tier allocation must count a page charge once across assignments, attempts and router calls and cover both regular and Extract billing.

No CREDIT_RATE_CARD, PRICE_CARD, SERVICE_PLANS, resource policy, worker sizing or INFRA_COST_OBSERVATIONS values were changed by this fix. Main was merged forward (OSS main `7b55bde75977df1706a315066150973227a621b0`); its latest billing behavior was retained. Existing PR observation edits remain historical evidence, not freshly verified Vast prices.

## Gates

- App `pnpm pricing:validate`, live, 2026-10-27T14:25:26Z: script PASS. Retained JSON and console log are adjacent.
- Fly, Modal, Tigris, Neon and OpenRouter source requests succeeded. Fly/Modal/Tigris/Neon comparable observations showed zero drift.
- **Incomplete verification:** Vast offers and Fly inventory could not be read: VAST_API_KEY and FLY_API_TOKEN absent. In particular the historical L4 observation and the prior reported $0.6741/h sample are unresolved; the script PASS is not proof of current GPU economics. No observation was refreshed from an unavailable source.
- Router/local-compute/AI-receipt/usage-attribution tests: 328 pass, 2 skip (36 files pass, 1 skip).
- Shared full suite (includes prohibited-model and infra pricing regressions): 718 pass, 82 files.
- Server chat-model policy: 16 pass.
- App pricing-source helpers: 10 pass.
- Shared build, worker typecheck and worker build: pass. Final worker typecheck rerun after test typing corrections: pass.
- No paid model calls, GPU rentals, compute jobs or deployment; only free read-only pricing requests and local checks.

## Remaining review/dependency work

App PR221 was inspected read-only at `4940cae034c0f49b0ede911280ad3dc2ba1cabb4`. It depends on OSS184 for prohibited/pinned-route model metadata. Its validator corrects embedding defaults, document-level text assumptions, pinned vision endpoints and load-test revenue attribution. Those changes were not imported here, so the app-main validator is not an independent complete billing-economics audit. PR221 is not needed to remove fictitious router revenue; it remains relevant to the full pricing review. No rate-card/plan changes were made, so no new paid load test was run.

The prior two reviewers reportedly found no security block but did not validate economics. This implementation is not a replacement council approval. Parent/human review must assess the conservative deferral behavior and unresolved live GPU observations before merge. No merge or deployment was performed.
