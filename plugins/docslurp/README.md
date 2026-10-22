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

The first tool call opens a browser to sign in to DocSlurp and approve access (OAuth 2.1 with PKCE). No API key is stored in the plugin. You need a DocSlurp account; sign up at [docslurp.io](https://docslurp.io).

## What the plugin sends, and where

Everything goes to `docslurp.io` and nowhere else:

- **Search and chat** send your query text and any filters you set.
- **Upload** sends file metadata (name, size, type) to the MCP server, which returns short-lived presigned URLs. Claude then uploads the file bytes directly to DocSlurp's object storage with those URLs. URL ingestion sends the URLs, and DocSlurp fetches them.
- Uploaded documents are stored in your DocSlurp organization until you delete them. See the [privacy policy](https://docslurp.io/privacy) and [terms](https://docslurp.io/terms).

The plugin contains no scripts or hooks and runs nothing on your machine.

## Costs

Search uses embedding credits. `chat` also runs your workspace's configured model, and uploads run the ingestion pipeline; both spend credits on your DocSlurp plan. Estimate tools such as `uploadEstimate` price an operation before you start it.

## License

MIT. See [LICENSE](LICENSE).
