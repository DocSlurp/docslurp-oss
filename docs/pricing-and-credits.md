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
| Live OpenRouter list prices for usage without a receipt | `packages/shared/src/live-model-prices.ts` (see [Provider cost](#provider-cost)) |
| Hardcoded fallback prices used when no live price is loaded | `packages/shared/src/chat-model-prices.ts` (a test keeps it equal to `model-prices.json`), `defaultAiUsagePricingCatalog` in `packages/shared/src/usage.ts` |
| Vision model token prices and per-page estimates | `visionModelCatalog` in `packages/shared/src/embedding.ts` |
| Spend attribution for budgets, limits and billing | `server/src/services/usage-attribution.ts` |

Entries marked `prohibited` in `model-prices.json` (OpenAI Pro/Ultra, or output at or above $50 per 1M tokens) are
kept only as historical evidence. `packages/shared/src/__tests__/prohibited-models.test.ts` fails if a catalog,
default, preset or the page router can select one.

Rate-card and plan changes are owner decisions. Before you change `CREDIT_RATE_CARD`, `SERVICE_PLANS`,
`INFRA_COST_OBSERVATIONS` or worker sizing, run `pnpm pricing:validate` in DocSlurp/app and compare the result with
the latest load test. `pnpm pricing:watch` there tracks model prices and where each model is hosted.

## Provider cost

Credits are flat (the price card); what providers charge us is recorded separately on each AI Usage Event as
`metadata.providerCostCents`, with `costSource` (`provider` or `estimate`) and, for estimates, `pricingSource`.
Customers' charges never depend on it.

Each call records, in order of preference:

1. **The provider's reported charge.** OpenRouter's `usage.cost` from the response (chat, agent steps, vision,
   embeddings, moderation; summed per request for batched embeddings; BYOK adds the upstream cost), else the
   `/api/v1/generation` receipt, looked up again once after 1.5 s when it is not ready. Media transcription and
   media vision record the provider's figure when it is within 25% of the rate estimate; a disputed figure is kept as
   evidence and the estimate is recorded.
2. **The live list price** (`pricingSource: "openrouter-live"`): OpenRouter's public chat and embeddings catalogs,
   loaded at startup and hourly by the server and worker, with listed long-prompt and time-of-day overrides
   applied. A failed refresh keeps the last snapshot, retries after 5 minutes, and a snapshot older than 7 days is
   ignored. It is off without `OPENROUTER_API_KEY` or with `LIVE_MODEL_PRICES=off`.
3. **The hardcoded fallback** (`model-prices`, `catalog`): the tables above, then `COST_PER_1K_*`
   (`configured-fallback`).

Live prices only price usage. Prohibited-model checks and the eval-model allowlist keep using the verified
hardcoded prices, so a live listing never admits a model.

### Loss alerts

The alert leader compares, every 5 minutes, what each chat turn, finished run and search session charged in credits
with its provider cost (receipts, or list-price estimates where no receipt arrived). A generated aggregate-search answer
(`POST /v1/search/aggregate` with `generateAnswer`) is one item too: its model cost and its charge carry the same
`metadata.chatTurnId`.

- Each item whose provider cost exceeds its credits logs `[billing] provider_cost_loss` and emits the
  `docslurp.billing.provider_cost_loss` telemetry event once (`info` for refunded turns, `warn` otherwise).
- An organization whose losses over the last hour, refunded turns excluded, reach `ALERT_PROVIDER_LOSS_CENTS`
  (default 100, so $1) fires the `provider-cost-loss:<orgId>` alert through the normal tracker and Telegram/webhook
  delivery, with its loss, provider cost, credits, estimated share and top models. It resolves when the hour's
  losses fall below the threshold.

It runs only where billing is enforced. `ALERT_PROVIDER_LOSS_CENTS=0` turns it off;
`ALERT_PROVIDER_LOSS_INTERVAL_MS` (default 300000) and `ALERT_PROVIDER_LOSS_SETTLE_MS` (default 120000, how long an
item's last event must age before it is judged) tune it. Item dedupe is per process: a new leader can repeat an item
from the last hour. Runs longer than six hours are judged on their recent usage. The query is
`providerCostLossItems` in `server/src/services/usage-attribution.ts`.

## Processing quality

`pipeline.quality` (`packages/shared/src/quality.ts`) is the public extraction choice, and `QUALITY_MODES`
(`billing.ts`) prices it from `PRICE_CARD`:

| Quality | Billing | Per 1,000 pages |
| --- | --- | --- |
| `fast` | Text layer only. Pages without one keep their page image and are never OCR'd or read by a model. Billing comes from the usage ledger (`remainingFastPages` in `worker/src/db/page-base-fee.ts`), never from the best-effort page facts: a page bills Rich only when a vision or OCR model read it and that read was recorded for the run (charged as it was read), and every other page bills Fast. A workspace cannot combine Fast with visual indexing mode, which embeds page images and bills them Rich. | $0.05 |
| `auto` (default) | A page bills Rich only when a vision or OCR model read that page's content: a scanned PDF page the extractor OCR'd and found words on, every frame of an uploaded image the OCR engine read (with or without text), a page a vision model read. Each such page is recorded on the usage ledger once per run, and every other page, an unread scan or image included, bills Fast. A local caption of a photo on the page (the image labeler, metric `image-label`) does not read the page's text: it is recorded at its compute cost and the page stays Fast. | $0.05 to $2.50 |
| `good` | Vision reads every page (Good turns `visionFallback` on), so every page it reads bills Rich, plus `richPagesForOutputTokens` for long output (one more Rich page per 1,000 output tokens past the first 1,000, summed over the models that read the page: OCR then vision is one page plus the vision output's surcharge). A run cost cap can stop vision early; pages it did not read bill as in Auto. On-demand materialization reads every page with vision too. | $2.50 |

`PIPELINE_PROFILES` (the `estimateIngest` page-class model) is keyed by the same ids, so estimator ranges match the
catalog: `billing.test.ts` checks every mix stays inside its mode's range. A quality picker shows
`qualityModePriceRange(mode)`. Parser playbooks are internal (`parserPlaybookForQuality`).

## OCR reads

- **Uploaded images:** every frame the OCR engine reads bills one Rich page (0.25 credits), whether or not it found text. A blank photo still costs the OCR VM's run. Before 2026-11-05 a frame without words billed nothing.
- **Scanned PDF pages:** a page OCR read bills Rich only when the read found words; a blank page bills Fast at completion.
- **Escalation** (`ocr-escalation`, a hosted second read of a page the recogniser read poorly): at most one Rich page per page, whatever its output length. Its output tokens never add Rich pages, and a page the recogniser already charged stays one page. An escalation that returns no text charges nothing. Its provider cost is recorded either way, for the loss alert.
- **OCR long edge:** `DOCSLURP_OCR_MAX_LONG_EDGE` above the 2000 px default is an explicit opt-in. A page still bills one Rich page while its VM time grows, so a dense page at a high cap with escalation can cost slightly more than it bills. The VM's provider cost is recorded at the sandbox rate (`modalSandboxCostCents`, as `providerCostCents`), so the provider-cost loss alert sees such runs.
- **Before an image's OCR read:** the run's cost cap, then the balance for its first Rich page plus the activity's buffered charges. A reached cap or an unfunded run stops the stage before any VM starts (a run-policy stop: the image stays unread and runs again on resume). Admission checks the organization once per run; this check holds for every read.
- **TIFF spend check:** once OCR has counted a TIFF's frames, and before any is charged or escalated, the worker checks the balance for the Rich frames admission did not price, summed over the run's TIFFs. If they do not fit, the run pauses and the image is refused with nothing charged (`imageFramesUnfunded`). The VM's provider cost is still recorded.
- **Charge checks fail closed:** the pre-read, frame-count and measured Office page checks (`enforceRunSpendForCharge`) refuse with a retryable `SpendCheckUnavailableError` when the balance read or the pause write fails, or the run has no organization. The document is left unfinished, not failed, and Temporal retries the activity. The cadence check (`enforceRunSpend`, at checkpoints and stage boundaries) still fails open on a database error: it charges nothing itself, and the next check runs at the next checkpoint.
- **TIFF frames:** each frame is a page. The frames read become `documents.page_count`, so page rows, citations and the bill agree: a 7-frame fax is 7 Rich pages, 1.75 credits. Intake marks a TIFF's count `assumed` until then. A TIFF with more than 64 frames is refused before anything is charged (public error `imageTooManyFrames`); split it or upload a PDF.
- **Runs in flight at a cutover:** `startRun` pins the run's page billing rules (`run:page-billing-rules`, the `PRICE_CARD_VERSION`). A run without the pin was started by an earlier release and keeps that release's completion rule: image files and pages the page facts show as scans bill Rich at completion (`rich-scan:<run>`), less the pages a per-read charge already covered.

## Which pages a document bills

`documents.page_count` is the page basis: the pages the extracted text splits into, which citations, page rows and the page index use. A PDF's count is its own. Word, OpenDocument, RTF, legacy Office, slide, sheet and EPUB files have no page breaks in their text and arrive counted as one page (`documents.page_count_source` is `assumed`), so the worker measures what they hold and records it as `documents.billing_pages` (`worker/src/lib/office-page-count.ts`); the completion fee and the optional features bill that count, and a forecast uses it only once it exists.

| Format | How `billing_pages` is counted |
| --- | --- |
| Word, OpenDocument, legacy Office | Pages of the file converted to PDF by LibreOffice. Where the worker has no LibreOffice (the lean production image) the text rule over the extracted text, then the file's size at the format's typical bytes per page (`size-estimate`, the quote's typical count). Never one page for a long document. No tool in the lean image reads a legacy `.ppt` or `.xls`, so those bill the size estimate: a 30 MB `.ppt` is 768 Fast pages, 3.84 credits, and no feature bills on that guess. |
| PowerPoint | Slides. |
| Spreadsheet | The text rule (60 lines or 3,500 characters a page) over the text each sheet's non-empty cells hold, never the CSV's separators: a stray cell far down or far across a sheet is a page, not thousands. A 12 KB sheet of 1,000 short rows with one cell at `XFD1` measures 17 pages, not 4,688. |
| EPUB | The text rule over the chapters' text. |

A measured count far above intake's one page owes credits admission never saw, so the worker re-checks the organization's balance after measuring and pauses the run when the extra fee and enabled features no longer fit. The Fast fee on measured pages is charged when the run completes, so the check adds the extra pages of every document of the run measured so far: ten 400-page DOCX files against 10 spendable credits pause the run at the sixth file (11.97 credits owed), where each alone (2 credits) would have passed.

Features read text, so a measured count is capped by the text the document holds when features bill, whatever method measured it (layout conversion, sheet cells, EPUB chapters, the text rule): blank pages bill the base fee but not features. Slides are the exception: a slide is a page whatever it holds. A size estimate never prices a feature; the feature bills the text it read, or intake's count.

A new version of a document (a reprocess, a configuration re-index, a full index) keeps the measured count, its method, intake's count source and the file facts, and re-index and full-index estimates price `coalesce(billing_pages, page_count)`: a 300-page DOCX re-indexes as 300 pages, not 1. Progress counts (`pages_total`) and page-image work stay on the page basis.

The optional features that read text bill what their model read, not the page count alone. Structured extraction (`outputSchema`) and the knowledge graph charge the document's pages, or their share when only part was read, and at least the pages of text the model read (3,500 characters a page); a 1-page PDF with 800,000 characters read in 8 windows bills 229 pages of structured fields, 23 credits, not 1. A window the model answered is billed even when a later one fails or its answer does not parse (for the knowledge graph, even when no window parsed and the graph fell back to heuristics: the provider was paid to read them), a retry bills only what is new and a structured-extraction retry asks the model only for the windows that never finished, the spend counts against the run's cost cap (no further window is read once it is reached), and `DOCSLURP_STRUCTURED_MAX_WINDOWS` lowers the 8-window ceiling per document.

## Quotes for Word, slide and sheet files

No model reads a Word, legacy Office, OpenDocument, RTF, slide or sheet page in any quality: their text is extracted, never rendered for vision. A quote (`quoteUpload`, and the offline estimator's port) prices their pages Fast at both ends, in Fast, Auto and Good alike (`FAST_ONLY_FORMATS`, `fastOnlyPages` in `estimateIngest`). A 300-page DOCX in a Good workspace was quoted at 75 credits; it is quoted, and bills, 1.5. A page mix the client sends does not change this (estimate rules 6): a 30-page DOCX sent with an all-scanned mix was quoted 7.5 to 15 credits in Good; it is quoted 0.15, what it bills.

## Quotes for TIFF files

A TIFF is quoted at its frames, up to 64 (`IMAGE_MAX_FRAMES`, card `multiFrameImages`; estimate rules 6). The offline estimator reads a TIFF whole (up to 64 MB) and counts its frames from the image directory chain. A file over 64 frames is quoted at 64 and the quote's basis says it will be refused. An uncounted TIFF is quoted from 1 frame to its size at 16 KB a frame, at most 64. Each frame is priced as a scanned page. EPUB is quoted as before. Structured fields and the knowledge graph bill at least the pages of text read; the quote knows characters only for text files, whose pages already count them (3,500 characters a page).

## Aggregate search answers

A generated answer over several workspaces bills one chat answer at the answering model's tier (`PRICE_CARD.chatAnswerTiers`, once more per started 100,000 total tokens), the same rule as chat, to the one organization searched. A retrieval fallback that called no model charges nothing. Before price card `2026-11-04b` these answers charged nothing.

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
