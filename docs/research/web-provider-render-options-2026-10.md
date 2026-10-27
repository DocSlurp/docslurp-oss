# Web provider render/escalation options (2026-10-23)

These findings come from official docs only, fetched on 2026-10-23. No provider APIs were called. "Unverified" means the official pages do not state it.
USD rates used: Firecrawl Standard $0.00099/credit, Tavily PAYG $0.008/credit, Exa as listed, Jina $/1M tokens (see the Jina section).

## 1. Firecrawl v2 (`/scrape`, `/crawl`, `/search` `scrapeOptions`)

Base cost: 1 credit per page ($0.00099). Crawl uses the same per-page cost and modifiers. Search costs 2 credits per 10 results, rounded up, plus the scrape cost of each scraped result. Modifiers stack.

| Option | Param | Effect | Cost | Source |
|---|---|---|---|---|
| Proxy basic | `proxy:"basic"` | Standard proxies | 1 cr ($0.00099) | [scrape ref][fc-scrape] |
| Proxy enhanced | `proxy:"enhanced"` | Anti-bot proxies | **+0**, 1 cr total | [billing][fc-bill], [enhanced][fc-enh] |
| Proxy auto (default) | `proxy:"auto"` | Starts on basic. Retries **once** on enhanced if the target returns 401/403/429. No retry on 404/5xx | +0. The escalated retry is not billed separately | [enhanced][fc-enh] |
| Proxy stealth | `proxy:"stealth"` | **Removed**: the v2 enum is basic/enhanced/auto only | n/a | [scrape ref][fc-scrape] |
| `proxy` param itself | — | Docs mark it **deprecated**; auto is recommended | — | [proxies][fc-prox] |
| waitFor | `waitFor` (ms, default 0, max 60000) | Extra wait on top of smart-wait (JS settle) | No surcharge listed | [scrape ref][fc-scrape] |
| actions | `actions[]` (wait, click, write, press, scroll, screenshot, scrape, executeJavascript, generatePDF; ≤50; total wait ≤60s) | Browser interaction. **Disables the cache** | No surcharge listed (unverified that it is free) | [adv. guide][fc-adv], [billing][fc-bill] |
| Screenshot format | `formats:["screenshot"]` | Page image | No surcharge listed (unverified) | [billing][fc-bill] |
| Cache | `maxAge` (ms, default 172800000 = 2 days; `0` = force fresh), `storeInCache` (default true) | Serves the cached copy when it is younger than maxAge | **No discount**: "Cached results still cost 1 credit per page" | [fast scraping][fc-fast] |
| Lockdown (cache-only) | `lockdown` | Serves from cache only and never fetches | Hit: +4 (5 cr, $0.00495). Miss: 1 cr, no document | [billing][fc-bill] |
| PDF parsing | `parsers:[{type:"pdf",mode:"fast"|"auto"|"ocr"}]` (default on) | Parses PDF pages | +1 cr per PDF page. `parsers:[]` returns base64 at a flat 1 cr | [billing][fc-bill], [adv. guide][fc-adv] |
| mobile | `mobile:true` | Mobile emulation | No surcharge listed | [scrape ref][fc-scrape] |
| blockAds | `blockAds` (default true) | Blocks ads and cookie popups | No surcharge listed | [scrape ref][fc-scrape] |
| location | `location:{country (default US), languages}` | Geo proxy/locale | No surcharge listed | [scrape ref][fc-scrape] |
| timeout | `timeout` (ms, default 60000, 1000–300000) | Request timeout | — | [scrape ref][fc-scrape] |
| JSON format | `formats:[{type:"json",schema,prompt}]` | LLM extraction | +4 (5 cr, $0.00495) | [billing][fc-bill] |
| question / highlights / audio / video | formats | LLM or transcription | +4 each | [billing][fc-bill] |
| summary format | `formats:["summary"]` | LLM summary | **Not in the billing table (unverified)** | [billing][fc-bill] |
| ZDR / PII redaction / prompt-injection check | `zeroDataRetention` / `redactPII` / `checkPromptInjection` | Compliance options | +1 / +4 / +4 | [billing][fc-bill] |

**Credit reporting:** `/crawl` status returns `creditsUsed` and `/search` returns `creditsUsed`. The documented `/scrape` response has **no `metadata.creditsUsed`**, so a scrape's cost must be computed from the options sent. Scrape metadata does include `statusCode`, `error`, `contentType`, `numPages`/`totalPages` (PDF) and `cacheState` ("hit"/"miss").

**Charging rule:** a returned document costs 1 credit **even when the target sent a 403 or 404**. A scrape that returns no document costs 0. Check `metadata.statusCode`.

**Escalation signals:** `metadata.statusCode` is 401, 403 or 429 after `auto` (auto already escalated once, so it is final), empty or very short `markdown`, `metadata.error` is set, `totalPages > numPages` (truncated PDF), or an HTTP 408 from Firecrawl. Next steps: add `waitFor`, then `actions` (wait for a selector or scroll), then `maxAge:0`. An enhanced proxy adds nothing beyond auto.

## 2. Jina Reader (`r.jina.ai`)

Billing is by output tokens ("charges tokens based on content length"). Failed requests are not charged. The official page loads the price table dynamically and `jina.ai/pricing` returns 404, so **$/1M is unverified**. A third-party source cites ~$0.05/1M on a standard top-up (1B tokens for $50), which would put a 5k-token page at about $0.00025. Reader states it **does not bypass anti-bot systems**. Source: [jina.ai/reader][jina].

| Option | Header | Effect | Cost | Source |
|---|---|---|---|---|
| Direct | `X-Engine: direct` | Plain HTTP fetch, no JS; a few hundred ms | Tokens ×1 (no multiplier stated) | [jina] |
| Browser (default) | `X-Engine` omitted/default (`browser`) | Headless browser that runs JS; low seconds | Tokens ×1 (no multiplier stated) | [jina] |
| CF renderer | `X-Engine: cf-browser-rendering` | Experimental Cloudflare renderer | No multiplier stated | [jina] |
| ReaderLM-v2 | `X-Respond-With: readerlm-v2` | LLM HTML→MD/JSON | **Multiplier unverified** (the page shows none; older docs said 3×) | [jina] |
| OCR | `X-Respond-With: jina-ocr-v1` | Image/doc OCR | **40× tokens** | [jina] |
| Timeout | `X-Timeout` (s) | Max page-load wait | — | [jina] |
| Wait for selector | `X-Wait-For-Selector` | Waits for a CSS selector before extracting | — | [jina] |
| Shadow DOM / iframes | `X-With-Shadow-Dom`, `X-With-Iframe` | Includes that content | Only via extra output tokens | [jina] |
| Geo proxy | `X-Proxy: <country>|auto|none` | Location-based proxy | No surcharge stated | [jina] |
| Own proxy | `X-Proxy-Url` | Routes through your proxy | — | [jina] |
| Cookies | `X-Set-Cookie` | Forwards cookies; **never cached** | — | [jina] |
| Cache bypass | `X-No-Cache: true`, or `X-Cache-Tolerance: <s>` (0 = fresh) | Default cache is about 5 min for a repeated URL | No discount stated for hits | [jina] |
| Locale | `X-Locale` | Browser locale | — | [jina] |
| Budget cap | `X-Token-Budget` | Fails the request if exceeded | Cost guard | [jina] |
| Token reducers | `X-Retain-Images: none`, `X-Target-Selector`, `X-Remove-Selector` | Shrinks output | Lowers cost | [jina] |

**Escalation signals:** empty or near-empty content, or "enable JavaScript" / captcha text (step up from direct to browser, then add wait-for-selector or a longer timeout). Status codes 422 (unprocessable/no content) and 451 (blocked/security-restricted URL) are **not documented officially (unverified)**. Treat 451 as terminal and 422 as an escalation candidate.

## 3. Tavily `/extract`

| Option | Param | Effect | Cost | Source |
|---|---|---|---|---|
| Basic (default) | `extract_depth:"basic"` | Simple text extraction; default timeout 10s | 1 credit per 5 **successful** URLs ($0.0016/URL) | [credits][tv-cred], [extract][tv-ext] |
| Advanced | `extract_depth:"advanced"` | "Tables and embedded content". Best-practices guide recommends it for "Dynamic content or JavaScript-rendered pages"; default timeout 30s | 2 credits per 5 successful URLs ($0.0032/URL) | [credits][tv-cred], [best practices][tv-bp] |
| Timeout | `timeout` (1–60 s) | Per-request cap | — | [extract][tv-ext] |
| Other | `format` (markdown/text), `query` + `chunks_per_source` (1–5), `include_images`, `include_usage` | Reranking/chunking | No surcharge stated | [extract][tv-ext] |

Failed URLs are not charged. Crawl cost is map plus extract (for 10 pages: basic 3 credits, advanced 5). Proxy and anti-bot handling are not documented.
**Escalation signals:** the URL appears in `failed_results[]` with an `error` (only "Failed to retrieve content" is documented), `raw_content` is empty or short, or `results` is empty on an HTTP 200. Check both arrays.

## 4. Exa `/contents`

Contents cost **$1 per 1k pages per content type** ($0.001/page for `text`; text plus highlights is $0.002). Source: [pricing][exa-price].

| Option | Param | Effect | Cost | Source |
|---|---|---|---|---|
| Cache default | `maxAgeHours` omitted | Uses the cache, live-fetches when there is none | $0.001/page/type | [contents ref][exa-ref] |
| Force live | `maxAgeHours: 0` (`-1` = cache only; max 720) | Always fetches fresh | **No livecrawl surcharge documented (unverified)** | [contents ref][exa-ref] |
| Legacy | `livecrawl: never|always|fallback|preferred` | **Deprecated**; cannot be combined with maxAgeHours | — | [contents ref][exa-ref] |
| Live timeout | `livecrawlTimeout` (ms, default 10000, max 90000) | Caps live-fetch wait | — | [contents ref][exa-ref] |
| Subpages | `subpages` (0–100), `subpageTarget` | Crawls linked subpages | **Per-subpage billing unverified** (likely per page/type) | [contents ref][exa-ref] |

JS rendering and proxy/anti-bot handling are not documented. The response carries `costDollars` (`total`, `contents.text`, ...; "not an invoice record").
**Escalation signals:** `statuses[].status:"error"` (on an HTTP 200) with `error.tag`. `CRAWL_LIVECRAWL_TIMEOUT`: raise `livecrawlTimeout`. `CRAWL_TIMEOUT`: retry. `SOURCE_NOT_AVAILABLE` or `CRAWL_HTTP_403`: fall to another provider. `CRAWL_NOT_FOUND`, `UNSUPPORTED_URL`: terminal. `CRAWL_UNKNOWN_ERROR`: retry. The tag set is open-ended; also check `statuses[].source` (`cached`/`crawled`). Source: [error codes][exa-err].

## Cost-ordered ladder (single URL → Markdown, USD/page)

1. Exa contents, cached/default: $0.001 (no JS guarantee).
2. Jina `direct` or default browser: ~$0.00025 per 5k tokens (unverified price; JS is included in the default).
3. Firecrawl `auto` (+`maxAge` cache): $0.00099. The enhanced proxy is free, so auto already covers it.
4. Tavily basic: $0.0016, then advanced (JS/tables): $0.0032.
5. Firecrawl with `waitFor`/`actions`/`maxAge:0`: $0.00099 (no listed surcharge; slower).
6. Exa `maxAgeHours:0` with a longer `livecrawlTimeout`: $0.001.
7. LLM modes (Firecrawl JSON +4 = $0.00495; Jina OCR 40×).

On per-page price alone, Jina, Firecrawl and Exa are within about 2× of each other. Tavily is the most expensive non-LLM option. Order the ladder by capability (none → JS → wait/actions → fresh) rather than by price, because Firecrawl's anti-bot escalation now costs nothing extra.

[fc-scrape]: https://docs.firecrawl.dev/api-reference/endpoint/scrape
[fc-bill]: https://docs.firecrawl.dev/billing
[fc-enh]: https://docs.firecrawl.dev/features/enhanced-mode
[fc-prox]: https://docs.firecrawl.dev/features/proxies
[fc-adv]: https://docs.firecrawl.dev/advanced-scraping-guide
[fc-fast]: https://docs.firecrawl.dev/features/fast-scraping
[jina]: https://jina.ai/reader/
[tv-cred]: https://docs.tavily.com/documentation/api-credits
[tv-ext]: https://docs.tavily.com/documentation/api-reference/endpoint/extract
[tv-bp]: https://docs.tavily.com/documentation/best-practices/best-practices-extract
[exa-ref]: https://exa.ai/docs/reference/get-contents
[exa-err]: https://exa.ai/docs/reference/error-codes
[exa-price]: https://exa.ai/pricing
