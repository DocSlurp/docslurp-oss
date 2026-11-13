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
| `visualExportRetryCredits()`, `chartExportExpectedRetriesPerRead()` | chart & diagram export second reads: the credits for a visual's one answered repair or cut-off retry (billed as its own event, at most once per visual), and the expected share of such second reads per model-read visual (0 to 1) that estimates and quotes add; the open default charges 0 |
| `visualExportCredits({ visuals, callsPerVisual, formats })` | chart & diagram export, per model-sourced visual (deterministic sources are never passed; core computes `callsPerVisual` from the per-format mode); the open default charges 0 |
| `pageChargeShare(plan)` | the completion page charge of partial reprocess runs |
| `speedBoostMultiplier(boost)` | unit charges of opt-in speed-boosted runs (must be a finite number ≥ 1) |
| `storageCreditsPerMonth(bytes)`, `extractRetentionCredits(bytes, months)` | the daily storage meter, extract retention |
| `searchUnits`, `searchCredits`, `webSearchCredits`, `webPageCredits`, `webMapCredits` | search and web tool charges |
| `chatModelTier`, `chatAnswerUnits`, `chatAnswerCredits` | chat answer charges |
| `plans` | credit packs, the starter grant, org worker ceilings |
| `qualityModePricing(mode)`, `publicPrices()` | the processing quality picker, `GET /v1/billing/prices` |
| `estimateIngest(input)`, `quoteUpload(args)` | every work estimate, `POST /v1/uploads/estimate` |
| `internalCost.*` | internal cost of local compute, remote sandboxes and worker slots (never a customer charge) |
| `internalCost.chartGeneratorMaxPricesUsdPerMTok()` | chart & diagram export generator selection: the highest input and output list prices (USD per 1M tokens) a generator may have; both must hold. `null` lets core derive them from `visualExportCredits` (one call at the image limit, or one answer at the output cap, costs the whole per-visual charge); with nothing charged per visual there is no ceiling of its own |

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
installed provider (such as `assembleEstimateQuote`) through it, not through a bundled copy. The API server, the worker and
the chat executor load it at startup (`@docslurp/shared/pricing-loader`), before serving requests, polling task queues or
claiming chat operations.

`host.durableState` (`PricingDurableState`) is durable, fleet-shared state for the provider, read-only: named, monotone
64-bit counters in Postgres (`pricing_provider_state`, migration 0131), the same for every API, worker and chat-executor
process. A provider uses it for what must survive restarts and be shared, such as the highest version of something an
operator has activated, so it can refuse an older one replayed later.

- `read(key)` returns the stored value as a `bigint`, or `null` when the key was never raised;
- keys are 1-128 characters of `[a-z0-9._:-]`, starting with a letter or digit;
- it throws when the database is unavailable, and in a process started without one. What the provider does then is its
  own rule; a provider that depends on the state should refuse to price (fail closed).

The runtime seam never raises a value, and the least-privilege runtime roles (`docslurp_app`, `docslurp_worker`) can
only read the table: neither can execute `pricing_state_raise`, insert, update, delete or truncate it. That protects the
mark only when each runtime process actually connects as its least-privilege role. A process connected as the table
owner or a superuser can move or reset the value. Two checks enforce the roles:

- **At startup:** wherever pricing is required, the API, worker and chat executor refuse to start if their role, or an
  allowed role it can `SET ROLE` into, could move the mark or act as the owner: a superuser or elevated role, another
  role membership, `CREATE` on the database or any non-system schema, owned objects, ownership of
  `pricing_provider_state`, a table or column write on it, `EXECUTE` on `pricing_state_raise`, a reachable SECURITY
  DEFINER function outside a short allowlist, or a writable view or rule over the table
  (`DOCSLURP_REFUSE_PRICING_STATE_WRITER`, always on there). A process that must check but has no database connection
  refuses to start.
- **At deploy:** `server/db/runtime-role-check.mjs` gates deploys on the same rule.

Until a deployment's runtime roles are rolled out, its runtime processes can still move the mark. The operator's activation tool raises values with the table owner's credential through
`pricingStateAdminFromSql(sql).raise(key, candidate)`, which calls `pricing_state_raise(key, candidate)` (SECURITY
INVOKER). It is a strict compare-and-set: it seeds a missing key or sets an existing one to a `candidate` strictly above
the stored value and returns it, and fails for a candidate at or below the stored value, so of concurrent raises to one
value exactly one succeeds. It refuses a candidate below 1. A missing key is seeded at any candidate (after a database reset the operator
restores the current value); an existing key rises by at most 1000 per raise, a guard against typos.

Fail closed:

- a named plugin that does not load, exports no `register`, or returns an incomplete provider is a startup error;
- `DOCSLURP_SERVICE_PROFILE=service` (or `DOCSLURP_PRICING_REQUIRED=1`) without `DOCSLURP_PRICING_PLUGIN` is a startup
  error, and `pricing()` throws under either setting until a provider is installed, so a billing deployment never prices
  with the open default, even in a process whose startup did not load one;
- the id `open` is reserved for the open default; a second, different provider in one process is refused.

## Estimates and file profiles

`POST /v1/uploads/estimate` accepts, per file, a **file profile** from the offline profiler (`@docslurp/estimate`,
`packages/estimate/README.md`): neutral, aggregate facts measured on the customer's machine. Profiles are untrusted:

- validated strictly (`fileProfileSchema`, unknown fields refused), at most 1,000 files and a 6 MiB body per request,
  and rate limited with uploads;
- read for page equivalents: `profilePageEquivalents` scales the sampled pages' equivalents (the billing measurement's
  rule, `page-equivalents.ts`) to the document, so a stuffed document is quoted at the pages it will be billed as
  (`QuoteFile.pageEquivalents`);
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

Knobs (`quoteSettingsSchema`; omitted ones take a new project's defaults): `quality` (`fast`, `auto`, `good`),
`indexing` (`full`, `on-demand`, `visual`: page images embedded on upload, a read of every page, refused with `fast`), `documentSummary`, `structuredFields`, `knowledgeGraph`, `propositions`,
`videoFrames`, `speedBoost`, `hostingMonths` (1–60), `searchesPerMonth`, `chatAnswersPerMonth`, `chatTier`.

Response (`EstimateQuote`): `kind: "estimate"`, `pricingVersion`, `validUntil`, `billing`, the resolved `settings`,
`files` (total, profiled), `pages` and `mediaMinutes`, `ingest.credits` (once) and `ingest.seconds`, `hosting` (bytes,
credits per month, months, total), `usage.creditsPerMonth` (searches and chat), neutral `lines`
(`pages`, `media`, `storage`, `search`, `chat`; label, period, credit range) and `rates` (pages per $1, pages per
minute). Every credit figure is a range where the profile is uncertain, and null where the deployment does not bill.
`validUntil` says when to re-quote; it is not a price hold. Prices may change without notice, and billing follows what
processing measures.

Limits: anonymous; a 1 MiB body; at most 200 files; per client IP `ESTIMATE_RATE_LIMIT_PER_MINUTE` quotes a minute
(default 120) and per quote session `ESTIMATE_SESSION_RATE_LIMIT_PER_MINUTE` (default 60; an opaque random
`ds_estimate_session` cookie, issued on the first quote, holding no identity) on top of the API's IP limits; no database
read, nothing stored.

Page equivalents follow the provider's dense-page allowance (`pageEquivalentAllowance`; core's default
`DEFAULT_PAGE_EQUIVALENT_ALLOWANCE` is 3). It covers text only, and only PDF pages and image frames: each such page bills
max(its text equivalents when above the allowance else 1, its area equivalents up to 8) (`billedPagePageEquivalents`), so
a twice-Letter page with little text bills 2. Office, EPUB, HTML and text files keep the whole-document text rule with no
allowance. Billing (`recordPageEquivalents`' `allowance`, over the stored whole measurements) and quotes (the profile's
`pageEquivalentsByAllowance`, exact for an allowance of 1 to 3) apply the same rule. Pages the profiler had to estimate (`textEstimatedPages`), and unsampled pages
of a file whose sampled pages were dense, widen only a quote's high end. Signed-in callers and API keys quote
against a project's settings with `POST /v1/uploads/estimate` (`settings` overrides, answer in `quote`), which uses
the same quote function.
