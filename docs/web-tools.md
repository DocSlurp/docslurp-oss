# Web tools

Web tools let API, MCP and chat callers search the public web, read pages as
Markdown, list a site's URLs, crawl a site and ingest a crawled site into a
workspace. The server routes each call to one of several third-party web
providers behind one generic interface. Callers never see which provider served
a call.

## Endpoints and tools

| REST | MCP tool | What it does | Credits |
|---|---|---|---|
| `POST /v1/web/search` | `webSearch` | Ranked results: URL, title, snippet, published date; page Markdown with `includeContent` | 1 per search; 2 for `depth: "deep"` or `includeContent` |
| `POST /v1/web/fetch` | `webFetch` | Up to 10 URLs as Markdown | 0.25 per page read |
| `POST /v1/web/map` | `webMap` | A site's URLs, optionally ranked by `search` text | 1 per started 50 URLs |
| `POST /v1/web/crawl` | `webCrawl` | Up to 100 same-site pages, 3 link hops, returned and not stored | 0.25 per page read |
| `POST /v1/web/ingest` | `ingestWebsite` | Crawl, then ingest each page as a Markdown document | 0.25 per page, plus normal ingestion |

Server API keys need the `search` scope (`ingest` for `/v1/web/ingest`).
Browser (client) keys also need the opt-in `web` scope, which requires a
workspace allowlist; without it they get `403 web_scope_required`. Every
response carries `cached` and `usage.credits`. An identical request within the
cache window is served without a new provider call and is still charged.

Re-ingesting a site replaces each page's previous version, because a page's
canonical ID is its URL.

### Chat

The chat assistant gets only `webSearch` and `webFetch`. It never gets crawl,
map or ingest. In chat, `webFetch` reads only URLs from the user's own messages
or from `webSearch` results in the same turn. This stops document or web text
from steering the model into fetching an attacker URL that carries workspace
data. Instruction-like lines in web text are suppressed before the model reads
them, and pages are capped at 6,000 characters.

## Turning web tools on and off

- **Server:** `WEB_TOOLS_ENABLED=true`, plus at least one provider key:
  `TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY` or `JINA_API_KEY`.
  Each tool is listed only while some configured provider supports it.
  `WEB_TOOLS_CHAT_ENABLED=false` keeps web tools out of chat.
- **Workspace:** the workspace pipeline's `webTools` setting, default `true`.
  Migration 0080 writes `webTools: true` into every existing workspace. Set
  `pipeline.webTools: false` through the workspace settings API to opt a
  workspace out.
- **Privacy:** `local-only` and `strict-privacy` workspaces never use web
  tools, because queries go to a hosted provider.

## Render ladder for page reads

Each provider offers its page reads at one or more render tiers:

| Tier | Option | What it does | Provider cost per page (2026-10-24) |
|---|---|---|---|
| 0, plain | `jina.direct` | HTTP fetch, no browser | ~$0.00023 (tokens) |
| 0 | `exa.cached` | Exa's index copy | $0.001 |
| 0 | `tavily.basic` | Static HTML extract | $0.008 per started block of 5 URLs |
| 1, JavaScript | `jina.browser` | Headless browser | ~$0.00036 (tokens) |
| 1 | `firecrawl.standard` | Browser, auto proxy (retries blocked sites on an enhanced proxy) | $0.00099 |
| 1 | `tavily.advanced` | JavaScript render, tables and embeds | $0.016 per started block of 5 URLs |
| 2, heavy | `jina.browser-wait` | Longer wait, shadow DOM and iframes, no cache | ~$0.0003 (tokens) |
| 2 | `firecrawl.rendered-wait` | Waits, scrolls for lazy content, no cache | $0.00099 |
| 2 | `exa.live` | Forces a fresh live crawl | $0.001; nothing when it fails |

A read starts at the lowest tier, or at tier 1 for `depth: "deep"`, using the
cheapest eligible option. Only the pages that come back unreadable, blocked
(401, 403, 429 or 451 from the site), timed out or thin (a JavaScript shell,
anti-bot wall or near-empty text) are retried, at the next tier. A provider
error such as a rate limit or outage fails over within the same tier instead.
Pages already read are kept, and a thin page is returned when nothing better
turns up.

- **Price guard:** an option whose estimate is `WEB_MAX_COST_RATIO` (default 15)
  times the cheapest eligible option's estimate, or more, is never tried. It is
  listed in the call's trace as `docslurp.web.price_blocked`.
- **Learned costs:** estimates follow what each option has actually billed. An
  exponentially weighted ratio of reported cost to estimate applies after 3
  samples, so ordering and the price guard track real bills.
- **Retries:** a transient failure (5xx, dropped connection) is retried once on
  the same option (`WEB_TRANSIENT_RETRIES`, default 1), unless the provider
  already billed for the job. `WEB_PROVIDER_MAX_ATTEMPTS` (default 4) bounds the
  provider calls per web call, failovers and escalations included.
- **Switching options off:** `WEB_DISABLED_OPTIONS=exa.live,firecrawl.rendered-wait`
  disables those options.
- **Cost tracking:** every paid provider call is its own internal cost event,
  carrying `option`, `tier` and `optionKey` (`provider.option`) in its
  metadata. Spans carry `docslurp.web.option`, `docslurp.web.tier`,
  `docslurp.web.estimate_usd` and `docslurp.web.cost_usd`, and the call span
  lists `docslurp.web.options_paid` and `docslurp.web.max_tier`.

## Routing and cost

`WEB_PROVIDER_STRATEGY` chooses the provider order for each call:

- `cheapest` (default): the lowest estimated cost for this request.
- `round-robin`: rotates the first provider to spread load and rate limits.
- `ordered`: follows `WEB_PROVIDER_ORDER`.

`WEB_PROVIDERS_SEARCH`, `_FETCH`, `_MAP` and `_CRAWL` restrict a capability to
the listed providers.

A failed call moves on to the next provider, up to `WEB_PROVIDER_MAX_ATTEMPTS`
(default 3), on these errors: rate limit, exhausted quota, auth failure,
timeout or outage. A request the provider rejects as invalid is never retried
elsewhere. A provider that fails is benched:

- Auth or quota failures: 10 minutes.
- Rate limits: the provider's `Retry-After` value.
- Outages: 15 seconds.

An empty map or crawl gets one second opinion from the next provider, never
more.

Provider cost is recorded as internal cost events (`web-<capability>`) that
never debit credits. The cost is the reported figure where the provider returns
one (Tavily credits, Exa `costDollars`, Firecrawl `creditsUsed`, Jina tokens)
and a price-sheet estimate otherwise. You can tune the estimates with:

- `TAVILY_USD_PER_CREDIT` (0.008)
- `FIRECRAWL_USD_PER_CREDIT` (0.00099)
- `JINA_USD_PER_MILLION_TOKENS` (0.05)

Customers pay the `web-search`, `web-page` and `web-map` price card units.

## Guardrails

- **URLs:** caller URLs pass the server's SSRF checks before any spend, which
  refuses private, loopback and metadata addresses.
- **Rate limit:** `WEB_TOOLS_ORG_PER_MINUTE` (default 60) per organization and
  process, on top of the API rate limits.
- **Credits:** each call checks the spend guard first. A failed charge never
  fails a result the caller already has.
- **Cache:** controlled by `WEB_CACHE_TTL_SECONDS` (900) and
  `WEB_CACHE_MAX_ENTRIES` (500). Results over 1 MB are not cached, and deep
  fetches bypass the cache.
- **Errors:** caller-facing errors are generic: `web_disabled`, `url_blocked`,
  `privacy_mode_blocked`, `rate_limited`, `unavailable` and `invalid_request`.
  Provider names and provider error text appear only in internal logs, traces
  and cost events.
- **In chat:** a failed `webSearch` or `webFetch` never fails the answer. The
  model gets a plain reason (the site may be down, may block automated AI
  access, needs a login, or the lookup timed out), tells the user it could not
  retrieve that source, and answers the rest of the question. A fetch that read
  some pages answers from those and lists the unread ones. The one exception is
  the URL guard: a fetch of a URL the user did not write and web search did not
  return still blocks the turn.

## Tracing

Each call is one `web <capability>` span (tracer `docslurp.web`). It carries the
capability, surface, call ID, workspace and org, cache hit, result count, cost
in cents, credits, attempts and outcome. Each provider attempt is a child client
span, `web.provider <capability>`, with the provider, attempt number, outcome,
HTTP status, runtime and cost. One `[web] call ...` log line per call, and one
`[web] provider_failure ...` line per failed attempt, correlate in SigNoz by
`call=`.
