# DocSlurp plugin for Claude

[Docs](https://docslurp.io/docs/mcp) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/plugins/docslurp) · [DocSlurp](https://docslurp.io)

DocSlurp turns PDFs, Word, Excel and PowerPoint files, EPUBs, HTML, images, audio and video into page-by-page Markdown, then indexes them for hybrid search. This plugin connects Claude to your DocSlurp workspaces so it can upload files, check how they processed, search them with page citations, and ask for grounded answers.

## What you get

- **The DocSlurp MCP server** at `https://docslurp.io/v1/mcp`, with tools to list workspaces, upload files or URLs, check processing status, search, and chat.
- **A `docslurp` skill** that teaches Claude when to use `search` and when to use `chat`, how to run the upload flow, and how to cite pages.

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
- **Upload** sends file metadata (name, size, type) to the MCP server, which returns short-lived presigned URLs. Claude then uploads the file bytes directly to DocSlurp's object storage with those URLs. URL ingestion sends the URLs, and DocSlurp fetches them.
- **Processing** may send document content or queries to the extraction, embedding and model providers selected by your workspace configuration. Storage and retention follow your workspace settings and the service's [privacy policy](https://docslurp.io/privacy) and [terms](https://docslurp.io/terms).

The bundle contains no executable scripts, hooks or local MCP server. File uploads can use a local HTTP client to transfer bytes to the returned object-storage host, which may differ from `docslurp.io`. A client without file-transfer capability can use URL ingestion or the DocSlurp upload UI.

## Costs

Search uses embedding credits. `chat` also runs your workspace's configured model, and uploads run the ingestion pipeline; both spend credits on your DocSlurp plan. Estimate tools such as `uploadEstimate` price an operation before you start it.

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
