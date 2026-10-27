# DocSlurp plugin for Claude

[Docs](https://docslurp.io/docs/mcp) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/plugins/docslurp) · [DocSlurp](https://docslurp.io)

DocSlurp turns PDFs, Word, Excel and PowerPoint files, EPUBs, HTML, images, audio and video into page-by-page Markdown, then indexes them for hybrid search. This plugin connects Claude to your DocSlurp workspaces so it can upload files, check how they processed, search them with page citations, and ask for grounded answers.

## What you get

- **The DocSlurp MCP server** at `https://docslurp.io/v1/mcp`, with tools to list workspaces, upload files or URLs, check processing status, search, chat, read video and audio evidence, and (when enabled on the server) search, read, map, crawl and ingest public websites.
- **A `docslurp` skill** that teaches Claude when to use `search` and when to use `chat`, how to run the upload flow, when to use the web tools, and how to cite pages.

## Install

In Claude Code:

```bash
claude plugin marketplace add DocSlurp/docslurp-oss
claude plugin install docslurp@docslurp
```

You need a [DocSlurp account](https://docslurp.io). Open `/mcp` in an interactive Claude Code session, select DocSlurp and complete browser sign-in and consent (OAuth with PKCE). Headless sessions need an already authorized connection. The plugin contains no API key or client secret; Claude Code manages the OAuth credentials.

Consent can include `search` and `read` for retrieval and workspace/document data, plus `ingest` for uploads. The connected account's organization and workspace permissions still apply. Review the permissions shown before authorizing.

## What the plugin sends, and where

MCP requests go to `https://docslurp.io/v1/mcp`:

- **Search and chat** send your query text and any filters you set.
- **Upload** sends file metadata (name, size, type) to the MCP server, which returns short-lived presigned URLs (one PUT URL for a small file, one URL per part for a large multipart file). Claude then uploads the file bytes directly to DocSlurp's object storage with those URLs, and DocSlurp starts ingestion automatically once every byte arrives. URL ingestion sends the URLs, and DocSlurp fetches them.
- **Web tools** send your web search text, URLs and crawl options. DocSlurp forwards them to a web provider listed below; `ingestWebsite` also stores the crawled pages in your workspace.
- **Processing** sends document content and queries to the third-party providers listed below. Storage and retention follow your workspace settings and the service's [privacy policy](https://docslurp.io/privacy) and [terms](https://docslurp.io/terms).

### Third-party data providers

On the hosted service, a workspace in the default `standard` privacy mode uses these providers:

| Provider | Data it receives | When |
| --- | --- | --- |
| [Fly.io](https://fly.io) | All service data: the API, workers, the Postgres database and backups | Always (hosting) |
| [Tigris](https://www.tigrisdata.com) | Uploaded files, extracted pages and artifacts, vector indexes, database backups | Always (object storage) |
| [OpenRouter](https://openrouter.ai) | Chunk and query text for embeddings; page images and text for vision extraction and page routing; queries for search rewriting; chat prompts with retrieved passages; workspace summaries and structured extraction; chat voice audio | Embeddings, extraction and search rewriting on every workspace; the other steps when used or enabled |
| Model hosts behind OpenRouter (currently Perplexity, Google, Z.ai and DeepSeek by default; Anthropic and OpenAI when you pick their chat models) | Whatever OpenRouter forwards for that model | Same as OpenRouter |
| [DeepInfra](https://deepinfra.com) | Audio for transcription and speaker diarization; video frames for description; query text and candidate passages for hosted reranking | Audio and video uploads; hosted reranking when enabled |
| [Jina](https://jina.ai), [Firecrawl](https://www.firecrawl.dev), [Exa](https://exa.ai), [Tavily](https://www.tavily.com) | Web search queries, URLs to fetch, map or crawl | Only when you use a web tool; DocSlurp routes each call to one configured provider |
| [Google Gemini API](https://ai.google.dev) | Page images and query text for page-image search | Only when deferred page-image indexing is enabled |
| [PostHog](https://posthog.com) | AI call metadata and token counts, without prompts or outputs; dashboard analytics | Always |
| [Stripe](https://stripe.com), [Resend](https://resend.com) | Billing details and account email; no document content | Billing and email |

Workspaces in the `local-only` or `strict-privacy` mode make no hosted model calls: optional hosted steps are skipped and required ones fail. `strict-privacy` also logs every blocked call. Self-hosted deployments use only the providers their operator configures.

The bundle contains no executable scripts, hooks or local MCP server. File uploads can use a local HTTP client to transfer bytes to the returned object-storage host, which may differ from `docslurp.io`. A client without file-transfer capability can use URL ingestion or the DocSlurp upload UI.

## Costs

Search uses embedding credits. `chat` also runs your workspace's configured model, and uploads run the ingestion pipeline; both spend credits on your DocSlurp plan. Web tools spend credits per search, page read or mapped URL batch, and `ingestWebsite` adds normal ingestion. Estimate tools such as `uploadEstimate` price an operation before you start it.

## Try it and troubleshoot

- “List my DocSlurp workspaces and their processing status.”
- “Find the termination notice period in my contract and cite its page.”
- “Check whether my uploaded handbook is searchable yet.”

If the server needs authentication, open `/mcp` and sign in again. If credits are exhausted or a budget blocks the request, use the recovery link returned by the tool. An empty search result is not evidence that processing has completed; check `getUploadStatus` first. No document deletion or billing-management tools are bundled.

Support: [MCP docs](https://docslurp.io/docs/mcp), [GitHub issues](https://github.com/DocSlurp/docslurp-oss/issues), or `support@docslurp.io`.

## Compatibility and maintenance

The shared `skills/docslurp/SKILL.md` is portable between Claude and Codex/ChatGPT. The OpenAI submission package is assembled in the private app repository from this skill and manifest, with its own listing/review fields and Streamable HTTP transport declaration. Keep shared behavior here so the packages do not diverge. Marketplace installation and directory approval are separate steps.

Guidance checked using [Context7's Claude Code index](https://context7.com/anthropics/claude-code) and the linked [Anthropic MCP guidance](https://code.claude.com/docs/en/mcp), plus [OpenAI's skill workflow](https://developers.openai.com/plugins/build/skills) and [portable packaging guide](https://developers.openai.com/plugins/build/plugins).

## License

MIT. See [LICENSE](LICENSE).
