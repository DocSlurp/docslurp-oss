# Pricing provider

DocSlurp core measures work and prices it through one seam, the **pricing provider** (`PricingProvider` in
`packages/shared/src/pricing-provider.ts`). Core owns the measurements, the usage ledger, spend checks, budgets, usage
attribution and AI-usage logging; the provider owns the numbers and rules that turn measured work into credits and
internal cost.

## What the provider decides

| Method | Called by |
|---|---|
| `pageCredits(mode, pages)`, `richPagesForOutputTokens(tokens)` | worker page charges (Fast at completion, Rich per model read) |
| `mediaRichPages(kind, seconds)` | worker media charges, media spend reserves, upload estimates |
| `featureCredits(feature, pages)` | worker optional-feature charges (summary, structured fields, knowledge graph, propositions) |
| `pageChargeShare(plan)` | the completion page charge of partial reprocess runs |
| `speedBoostMultiplier(boost)` | unit charges of opt-in speed-boosted runs (must be a finite number ≥ 1) |
| `storageCreditsPerMonth(bytes)`, `extractRetentionCredits(bytes, months)` | the daily storage meter, extract retention |
| `searchUnits`, `searchCredits`, `webSearchCredits`, `webPageCredits`, `webMapCredits` | search and web tool charges |
| `chatModelTier`, `chatAnswerUnits`, `chatAnswerCredits` | chat answer charges |
| `plans` | credit packs, the starter grant, org worker ceilings |
| `qualityModePricing(mode)`, `publicPrices()` | the processing quality picker, `GET /v1/billing/prices` |
| `estimateIngest(input)`, `quoteUpload(args)` | every work estimate, `POST /v1/uploads/estimate` |
| `internalCost.*` | internal cost of local compute, remote sandboxes and worker slots (never a customer charge) |

`version` is stamped on every billable unit event (`metadata.priceCard`) and pinned on runs, so a receipt says which
rules charged it.

## The open default

Without a provider, core prices with `OPEN_PRICING` (`packages/shared/src/pricing-open.ts`), one flat, published rule a
self-hosted operator can predict:

- every page costs 0.1 credit ($1 per 1,000 pages), however it was read;
- an audio or video file counts one page per started minute;
- storage, searches, chat answers, web tools and optional features cost nothing;
- no speed boost surcharge, no output-token surcharge, every run pays its full page charge;
- internal cost rates are unknown (0), except where `DOCSLURP_*_CENTS_PER_*` variables set them.

Self-hosted deployments usually run with billing disabled (no `STRIPE_SECRET_KEY`), where nothing is charged and
estimates show no credits. The open default is not DocSlurp's hosted pricing.

## Loading a provider

`DOCSLURP_PRICING_PLUGIN` names one module (an absolute path or a `file:` URL) that exports `register(host)` and returns
a `PricingProvider` with `apiVersion: 1`. `host.shared` is the host's own `@docslurp/shared`: call anything that reads the
installed provider (such as `assembleEstimateQuote`) through it, not through a bundled copy. The API server and the worker load it at startup
(`@docslurp/shared/pricing-loader`), before serving requests or polling task queues.

Fail closed:

- a named plugin that does not load, exports no `register`, or returns an incomplete provider is a startup error;
- `DOCSLURP_SERVICE_PROFILE=service` (or `DOCSLURP_PRICING_REQUIRED=1`) without `DOCSLURP_PRICING_PLUGIN` is a startup
  error, and `pricing()` throws in the service profile until a provider is installed, so a billing deployment never prices
  with the open default;
- the id `open` is reserved for the open default; a second, different provider in one process is refused.

## Estimates and file profiles

`POST /v1/uploads/estimate` accepts, per file, a **file profile** from the offline profiler (`@docslurp/estimate`,
`packages/estimate/README.md`): neutral, aggregate facts measured on the customer's machine. Profiles are untrusted:

- validated strictly (`fileProfileSchema`, unknown fields refused), at most 1,000 files and a 6 MiB body per request,
  and rate limited with uploads;
- clamped against the file they claim to describe (`normalizeFileProfile`): a size mismatch or inconsistent histogram
  drops the profile, counts are clamped to the pages sampled, durations to a day;
- passed to `quoteUpload` only. Billing is measured by the worker; a profile never changes a charge.

The response says `kind: "estimate"` and carries the `pricingVersion` that priced it. Offline, clients show the
profiles without credits and ask the user to connect for a quote.

## Hosted prices

DocSlurp's hosted price list is on [docslurp.io/pricing](https://docslurp.io/pricing) and `GET /v1/billing/prices`.

## The quote endpoint: `POST /v1/estimate`

Price transparency: anyone can profile files in the browser (`@docslurp/estimate` in a Web Worker; files never leave the
machine) and see what processing and hosting them costs, then turn knobs and watch the price move. Each knob change
re-sends only the small profiles and the settings; the server re-quotes in milliseconds (`quote()` must stay fast; the
shared test measures 1,000 profiled files at a few milliseconds per quote). Prices and their rules never leave the server.

Request (strict: unknown fields are refused):

```json
{
  "files": [{ "name": "scan.pdf", "size": 812345, "type": "application/pdf", "profile": { "schema": 1, "...": "..." } }],
  "settings": { "quality": "auto", "indexing": "full", "hostingMonths": 12, "searchesPerMonth": 0 }
}
```

Knobs (`quoteSettingsSchema`; omitted ones take a new workspace's defaults): `quality` (`fast`, `auto`, `good`),
`indexing` (`full`, `on-demand`), `documentSummary`, `structuredFields`, `knowledgeGraph`, `propositions`,
`videoFrames`, `speedBoost`, `hostingMonths` (1–60), `searchesPerMonth`, `chatAnswersPerMonth`, `chatTier`.

Response (`EstimateQuote`): `kind: "estimate"`, `pricingVersion`, `validUntil`, `billing`, the resolved `settings`,
`files` (total, profiled), `pages` and `mediaMinutes`, `ingest.credits` (once) and `ingest.seconds`, `hosting` (bytes,
credits per month, months, total), `usage.creditsPerMonth` (searches and chat), neutral `lines`
(`pages`, `media`, `storage`, `search`, `chat`; label, period, credit range) and `rates` (pages per $1, pages per
minute). Every credit figure is a range where the profile is uncertain, and null where the deployment does not bill.

Limits: anonymous; a 1 MiB body; at most 200 files; per client IP `ESTIMATE_RATE_LIMIT_PER_MINUTE` quotes a minute
(default 120) on top of the API's IP limits; no database read, nothing stored. Signed-in callers and API keys quote
against a workspace's settings with `POST /v1/uploads/estimate` (`settings` overrides, answer in `quote`), which uses
the same quote function.
