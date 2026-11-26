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

## Converted documents and copies

Word, OpenDocument, RTF, slide, sheet and EPUB files arrive counted as one assumed page. The worker counts their pages after
conversion, from the extractor's output (slides, sheet cells and the text rule), stores the count in
`documents.billing_pages`, and the completion charge bills that one stored number once per run
(`worker/src/lib/office-page-count.ts`, `worker/src/db/page-base-fee.ts`). Counts a document declares about itself
(`docProps/app.xml` pages or slides, "Page 1 of 1" in the text) never move a charge. One file measures at most 100,000
pages.

A content-deduplicated copy (an upload whose bytes match a completed document of the same organization, so its conversion
is reused and nothing is read again) bills like its original: the original's measured pages, at the classes those pages
billed (Fast, OCR, Rich), and an audio or video copy the original's media pages. The reuse is the platform's saving, never a
discount. When the API creates the copy it records these facts on the copy's own row (`billing_pages`, `page_count_source`,
`copy_ocr_pages`, `copy_rich_pages`, `copy_media_pages`; migration `20261126T0240_dedup_copy_billing.sql`), in the
transaction that sets `deduped_from_document_id`, so deleting the original later changes nothing a copy bills. A document
whose bill was never measured (a legacy original with no measured count, or a copy whose original was deleted before copies
recorded their facts) is never reused: the upload is processed and billed as an original.

Copies are spend-checked like originals: `run_measured_pages` counts a copy's pages above its intake count at its recorded
classes, and the worker checks the balance for them before any stage of the run (`PageBasis.authorizeCopies`, called by
format-detect), pausing an unfunded run exactly as it pauses one whose originals measured more pages than admission priced.
The completion charge bills copies from their own rows under fixed ids per run (`copy-fast:`, `copy-ocr:`, `copy-rich:`,
`copy-media:`), only for copies that complete; a copy made before migration `20261126T0240` bills its original's measured
count Fast through the pointer. Re-indexing a copy bills like re-indexing an original. Per-document feature charges
(summaries, structured fields, knowledge graph, propositions, chart export, summary tree) are not billed for copies: they are
recorded per call and per run, and copying them exactly would mean re-pricing each call.

`DOCSLURP_BILL_DEDUP_COPIES` (worker and API): unset, empty, `1`, `true`, `on` or `yes` is on; `0`, `false`, `off` or `no`
restores the earlier rule (copies bill nothing and are left out of spend checks). Any other value is read as on and logged
once. Roll out with the variable at `0` until every worker runs this release, then set it to `1`: a worker from an earlier
release that completes a run bills its copies nothing, and the run's charges are then final.

The upload quote cannot know these pages before conversion, so it prices them over a range of bytes per page
(`packages/shared/src/upload-pages.ts`). From the size alone the range is ordinary (about 1 KB a page at the high end for
Word and EPUB) and is not a ceiling: files of repetitive content (a clause template, a generated table, a column of ids)
compress far below that and can measure more pages. Such a quote says so (`unboundedFiles` and its basis text). With a client
file profile the high end is a ceiling for Word, slide and EPUB files: it covers the profile's uncompressed body size at
400 bytes a page, up to the worker's 100,000-page cap. A sheet is never bounded (its cells can repeat one long shared string,
which is outside the worksheet parts the profile measures). The API never opens an upload to measure this: customer files
are parsed only inside the parser VM.

## Stripe

Credits are prepaid packs bought through one-off Checkout payments. There are no plans or subscriptions. The server's
Stripe client pins the API version (`server/src/services/billing/stripe-client.ts`); a webhook endpoint must use the
same version.
