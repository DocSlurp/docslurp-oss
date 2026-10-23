# Web search/crawl providers: APIs and pricing (researched 2026-10-23)

Sources are official docs and pricing pages only. No provider API was called. "Unverified" means the official pages did not confirm the item.

## Summary: per-call USD estimates

| Capability | Tavily (PAYG $0.008/credit) | Exa (PAYG) | Firecrawl (Standard, $0.00099/credit) | Jina ($0.05/1M tokens) |
|---|---|---|---|---|
| Basic search, 5–10 results, no content | 1 credit = **$0.008** | `auto`: **$0.007** (`lite`: $0.004) | 2 credits/10 results = **~$0.002** | ≥10k tokens = **~$0.0005** (unverified) |
| Search with page content | Raw content adds no credit cost (unverified) → basic $0.008, advanced $0.016 | $0.007 + $0.001/page per content type → **~$0.017** for 10 pages of text | 2 + 1/page scraped → **~$0.007** for 5 pages | Default s.jina.ai already reads the top results, ≥10k tokens → **~$0.0005+** |
| Single page fetch → Markdown | Extract basic: 1 credit per 5 URLs → **$0.0016/URL** | `/contents` text: **$0.001/page** | Scrape: 1 credit → **~$0.001** | Output tokens; a 5k-token page ≈ **$0.00025** |
| Per crawled page | Crawl basic: 0.1 map + 0.2 extract credits → **$0.0024** | No crawl endpoint; `/contents` `subpages` ≈ $0.001/page (unverified) | 1 credit → **~$0.001** | No crawl endpoint |
| Reports usage in the response? | Yes: `usage.credits`, only when `include_usage: true` | Yes: `costDollars.{total,search,contents,summary}` | `creditsUsed` on search and crawl status; on scrape and map it is unverified | Yes: `usage.tokens` in the JSON response (exact field path unverified) |

## Tavily

- **Base URL:** `https://api.tavily.com`. **Auth:** `Authorization: Bearer tvly-...`.
- **`POST /search`**
  - Params: `query`; `search_depth` (`basic` or `fast` or `ultra-fast` = 1 credit, `advanced` = 2); `max_results` 0–20 (default 10); `chunks_per_source` 1–3.
  - `include_raw_content` (`markdown`/`true` or `text`); `include_answer` (`basic` or `advanced`); `topic` (`general`, `news`, `finance`).
  - Filters: `time_range`, `start_date`/`end_date`, `include_published_date`, `include_domains` (max 300), `exclude_domains` (max 150), `country`, `language`.
  - `auto_parameters` costs 2 credits. `include_usage` returns credit usage.
  - Response: `{query, answer?, images, results[{id,title,url,content,score,raw_content?,published_date?,favicon?}], response_time, usage{credits}, request_id}`.
  - Source: https://docs.tavily.com/documentation/api-reference/endpoint/search
- **`POST /extract`** (fetch)
  - Params: `urls` (1–20); `extract_depth` (`basic`, `advanced`); `format` (`markdown`, `text`); `query` + `chunks_per_source` (1–5) to rerank chunks; `timeout` (1–60 s); `include_usage`.
  - Response: `{results[{url,raw_content}], failed_results[{url,error}], response_time, usage, request_id}`.
  - Failed URLs are not charged. Usage can read 0 until you accumulate 5 successful extractions, so billing is amortized.
- **`POST /crawl`**
  - Synchronous; returns in the 200 body with `timeout` 10–150 s.
  - Params: `url`, `max_depth` 1–5, `max_breadth` 1–500, `limit` (default 50), `instructions` (doubles the map cost), `select_paths`, `extract_depth`, `format`, `include_usage`.
  - Response: `{base_url, results[{url,raw_content}], usage, request_id}`.
- **`POST /map`**
  - Params: the same traversal params as `/crawl`, plus `select_domains`, `exclude_paths`, `exclude_domains`, `allow_external`.
  - Response: `{base_url, results: string[], usage}`.
- **`POST /research`**
  - Async: returns 201 `{request_id, status: "pending"}`, then poll `GET /research/{request_id}`. The poll response shape is unverified.
  - Params: `input`; `model` (`mini`, `pro`, `auto`); `stream` (SSE); `output_schema`; `citation_format`; `output_length`.
- **Credits** (https://docs.tavily.com/documentation/api-credits)
  - Search: basic 1, advanced 2.
  - Extract: basic 1 per 5 URLs, advanced 2 per 5 URLs.
  - Map: 1 per 10 pages, or 2 per 10 with `instructions`.
  - Crawl: map cost + extract cost. Example: 10 pages basic = 3 credits.
  - Research: `pro` 15–250 credits, `mini` 4–110 credits (dynamic).
- **$/credit:** PAYG $0.008. Project $30 for 4k credits ($0.0075). Bootstrap $100 for 15k ($0.0067). Startup $220 for 38k ($0.0058). Growth $500 for 100k ($0.005). Free tier: 1k credits/month.
- **Rate limits** (https://docs.tavily.com/documentation/rate-limits)
  - Production keys: 1,000 RPM general, 100 RPM crawl, 20 RPM research creation.
  - Development keys: 100 RPM.
- **Errors:** 429 with `Retry-After`; **432** key or plan limit exceeded; **433** PAYG limit exceeded; 401; 422.
- **Internal LLM:** `include_answer`, `auto_parameters`, `instructions` and Research use one. Cost is in credits only, never tokens. The pricing page lists no separate credit cost for `include_answer` (unverified).

## Exa

- **Base URL:** `https://api.exa.ai`. **Auth:** `x-api-key: <key>` or `Authorization: Bearer <key>`.
- **`POST /search`**
  - `type`: `auto` (default), `lite`, `deep-lite`, `deep`. `fast`, `instant` and `deep-reasoning` are legacy.
  - `numResults` 1–100. Filters: `includeDomains`/`excludeDomains` (≤1,200), `start/endPublishedDate`, `category`.
  - `contents`: `text` (`maxCharacters` up to 1M), `highlights`, `summary` (with optional JSON `schema`), `maxAgeHours` (0 = always fresh, -1 = cache only; replaces `livecrawl`).
  - Other options: `outputSchema`, `stream`.
  - Response: `{requestId, searchTime, results[{id,url,title,publishedDate,author,text?,highlights?,highlightScores?,summary?,subpages?,favicon,image}], costDollars{total,search,contents,summary}, output?}`. There is no top-level `score`; use `highlightScores`.
  - Source: https://exa.ai/docs/reference/search
- **`POST /contents`** (fetch)
  - Params: `urls` or `ids` (1–100); `text` with `verbosity` and section filters; `highlights`; `summary`; `subpages` 0–100 with `subpageTarget`; `maxAgeHours`; `livecrawlTimeout`.
  - Response: `{results[], statuses[{id,status,source:cached|crawled,error{tag,httpStatusCode}}], costDollars, searchTime}`.
  - Source: https://exa.ai/docs/reference/get-contents
- **Crawl and map:** No dedicated endpoints. The closest equivalent is `/contents` with `subpages`.
- **Other endpoints:** `POST /answer` (LLM answer + `citations[{title,url,publishedDate}]`, SSE stream). `POST /findSimilar` (**deprecated**; use `/search`). Agent API `/agent/runs` (async). `/monitors`, `/batches`, Websets. OpenAI-compatible `/chat/completions` and `/responses`. Source: https://exa.ai/docs/exa-spec.yaml
- **Pricing** (https://exa.ai/pricing)
  - Search, per 1k requests up to 10 results: `lite` $4, `auto`/`fast` $7, `deep-lite`/`deep` $12, `deep-reasoning` $15.
  - Search extras: +$1 per 1k results above 10; AI summaries $1 per 1k pages.
  - `/contents`: $1 per 1k pages per content type (text, highlights, summary).
  - `/answer`: $5 per 1k requests.
  - Agent: $0.012–$1.00 per run by effort, or metered at $0.10/ACU.
  - `findSimilar`: no price listed (unverified).
- **Rate limits** (https://exa.ai/docs/reference/rate-limits)
  - `/search` and `/answer`: 10 QPS. Deep search: 5 QPS. `/contents`: 100 QPS. Agent: 5 QPS and 50 active runs.
  - Limits apply per team. PAYG teams can reach 25 QPS after buying $1k in credits within 30 days.
- **Errors:** **402** out of credits or key budget exceeded. **429** with `Retry-After`; `CONCURRENCY_LIMIT_REACHED` for agent runs. Error body: `{requestId, error, tag}`.
- **Internal LLM:** answer, summary, deep search and agent use one. Cost is a flat $ per request or page, not tokens, and is reported in `costDollars`.

## Firecrawl

- **Base URL:** `https://api.firecrawl.dev/v2`. **Auth:** `Authorization: Bearer fc-...`.
- **`POST /scrape`** (fetch)
  - Params: `url`; `formats` (default markdown; also html, links, screenshot, json); `onlyMainContent` (default true); `maxAge` (cache, default 2 days); `waitFor`; `timeout`; `proxy` (`basic`, `enhanced`, `auto`; per the scrape doc, enhanced bills the same as basic); `parsers` (PDF 1 credit/page; `mode` `fast`, `auto`, `ocr`).
  - Response: `{success, data{markdown, html?, metadata{title,sourceURL,url,statusCode,contentType}}}`. `creditsUsed` is not in the scrape schema (unverified).
  - Source: https://docs.firecrawl.dev/api-reference/endpoint/scrape
- **`POST /search`**
  - Params: `query` (≤500 chars); `limit` 1–100; `sources` (`web`, `news`, `images`); `tbs`; `location`/`country`; `categories`; `scrapeOptions.formats` (needed for page content).
  - Response: `{success, creditsUsed, data{web[{url,title,description,markdown?,metadata?}], news[], images[]}}`.
- **`POST /crawl`** (async)
  - Params: `url`, `limit` (default 10k), `maxDiscoveryDepth`, `include/excludePaths` (regex), `sitemap` (`skip`, `include`, `only`), `crawlEntireDomain`, `allowSubdomains`, `scrapeOptions`, `webhook` (started/page/completed/failed), `prompt`.
  - Returns `{id, url}`. Poll `GET /crawl/{id}` for `{status: scraping|completed|failed|cancelled, total, completed, creditsUsed, expiresAt, duration, next (10 MB pages), data[{markdown, metadata}]}`.
  - Get Crawl Errors lists dropped pages.
- **`POST /map`**
  - Params: `url`, `search` (relevance order), `limit` (default 5k, max 100k), `sitemap`, `includeSubdomains`.
  - Response: `{success, links[{url,title?,description?}]}`.
- **`POST /batch/scrape`**: async. Params: `urls[]`, scrape options, `webhook`, `maxConcurrency`. Returns `{id, url, invalidURLs}`.
- **`POST /extract`:** LLM structured extraction (`urls`, `prompt`, `schema`, `enableWebSearch`). Returns `{id}`. Polling and pricing are unverified. The pricing page has moved to "Agent", which is dynamically priced on agent tokens.
- **Credits** (https://www.firecrawl.dev/pricing)
  - Scrape and crawl: 1 per page.
  - Map: 1 per call.
  - Search: 2 per 10 results, plus scrape cost per scraped result.
  - JSON format: +4 per page. PDF: 1 per PDF page. Prompt-injection check: +4.
- **Plans** (monthly price, credits, $/credit)
  - Hobby: $19, 5k, $0.0038.
  - **Standard: $99, 100k, $0.00099.**
  - Growth: $399, 500k, $0.000798.
  - Scale: $749, 1M, $0.000749.
  - PAYG top-ups: Standard $5 per 2k credits ($0.0025/credit).
- **Rate limits:** Standard allows 500/min for scrape, map and search; 100/min for crawl and agent; 25 concurrent browsers. Growth allows 5,000/min.
- **Errors:** **402** insufficient credits; **429** rate limited.
- **Internal LLM:** JSON format, extract and agent use one. JSON format is a flat +4 credits/page; agent is token-based (rate unverified).

## Jina (Reader, Search, DeepSearch)

- **Endpoints**
  - Reader: `GET https://r.jina.ai/<url>`
  - Search: `GET https://s.jina.ai/<query>`
  - DeepSearch: `https://deepsearch.jina.ai/v1/chat/completions` (OpenAI-compatible; endpoint path unverified)
- **Auth:** `Authorization: Bearer jina_...`. Reader works without a key at 20 RPM; Search requires a key.
- **Reader headers**
  - `Accept: application/json` returns JSON.
  - `X-Respond-With`: `markdown`, `html`, `text`, `screenshot`, `pageshot`, `frontmatter`. ReaderLM-v2 mode costs about 3x tokens (Jina dashboard; unverified).
  - `X-Target-Selector`, `X-Retain-Images` (`none`, `alt`), `X-With-Generated-Alt` (VLM captions), `X-Engine` (`browser`, `curl`, `auto`), `X-No-Cache`.
  - `X-Token-Budget` makes the request fail if the content exceeds the budget; it is ignored on Search.
  - Source: https://github.com/jina-ai/reader
- **Search params:** `site=` (repeatable); returns the top ~5 results, each read through Reader. Search-only mode is `X-Respond-With: no-content` (Elastic tutorial; unverified on Jina's own docs).
- **JSON shape:** `{code, status, data{title,url,description,content,usage{tokens}}, meta{usage{tokens}}}`. Unverified: the official pages do not document it. Jina says JSON includes a token usage summary.
- **Crawl and map:** none.
- **Token pricing** (https://jina.ai/reader/, https://jina.ai/api-dashboard/pricing/)
  - Reader is billed on output tokens.
  - Search is a **fixed ≥10,000 tokens per request**.
  - DeepSearch is billed on all tokens across the run. A single call can use up to ~300k tokens (https://jina.ai/deepsearch/).
  - The OCR option costs 40x tokens. Failed requests are not charged.
  - New keys get 10M free tokens, which are non-commercial.
- **Package prices:** $50 per 1B tokens ($0.05/1M) and $500 per 11B ($0.045/1M). Source is Jina's guide, https://jina.ai/news/a-practical-guide-to-deploying-search-foundation-models-in-production/. The live dashboard is JS-rendered and did not confirm them, so treat these as **unverified current**. Another Jina post cites $0.02/1M.
- **Rate limits** (free key / paid key / premium key)
  - Reader: 500 / 500 / 5,000 RPM.
  - Search: 100 / 100 / 1,000 RPM.
  - DeepSearch: 100 RPM and 100k TPM (free), 500 RPM and 2M TPM (paid), 5,000 RPM and 50M TPM (premium). The DeepSearch figures are from an older page and are unverified.
  - Limits are tracked per key.
- **Errors:** 429 on rate limit. The insufficient-balance code (likely 402) is unverified.
- **Internal LLM:** DeepSearch, ReaderLM-v2 and generated alt text all bill as tokens at the same per-token rate.

## Implementation notes for DocSlurp

- To record actual cost:
  - Tavily: always send `include_usage: true`.
  - Exa: read `costDollars.total`.
  - Firecrawl: use `creditsUsed` for search and crawl, and fall back to rate-card credits for scrape and map.
  - Jina: read `usage.tokens` with `Accept: application/json`, then multiply by the configured $/1M.
- Tavily extract and map billing is amortized: usage can read 0 for the first <5 URLs or <10 pages. Record the reported value and keep a rate-card estimate alongside it.
