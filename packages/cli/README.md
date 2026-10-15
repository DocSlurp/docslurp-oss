# @docslurp/cli

[Package docs](https://docslurp.io/docs/packages/cli) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/cli) · [npm](https://www.npmjs.com/package/@docslurp/cli)

Run DocSlurp's three jobs from your terminal or CI: upload documents and watch them extract, search them for cited passages, and chat over them. Use the CLI to get cited passages for your application, export context for an LLM, or ask a grounded question before you write any integration code.

Start with [your first search](#your-first-search), see [shell workflows](#built-for-shell-workflows) and the [command reference](#command-reference), or check [troubleshooting](#when-something-goes-wrong). For application code, use the [Node SDK](https://docslurp.io/docs/sdk-reference).

[![Upload, indexing, and cited search in the terminal](https://docslurp.io/demos/integration.gif)](https://docslurp.io/docs/sdk#demo)

*A five-second illustration with sample data and compressed timing. [Watch the 20-second walkthrough](https://docslurp.io/demos/integration.mp4).*

## Your first search

You need **Node.js 20+** and a [server key](https://docslurp.io/app/api-keys) with the **ingest** and **search** scopes. These commands use Bash or zsh. In PowerShell, set the key with `$env:DOCSLURP_API_KEY = 'your-server-key'`.

```bash
npm install --global @docslurp/cli
export DOCSLURP_API_KEY='your-server-key'

docslurp upload ./handbook.pdf --watch
```

Use your own file. The CLI prints the workspace name and slug, the run ID and the document count, then watches processing. In an interactive terminal, the document and page progress bars update in place. When output is redirected, you get successive text snapshots instead.

You don't need to set up a workspace. The upload went to your organization's default workspace, which search and chat also use:

```bash
docslurp search 'What is the parental leave policy?'
```

Illustrative output (your filenames, scores, pages and passages will differ):

```text
  1. [0.8732] handbook.pdf (p.12)
     Eligible employees receive sixteen weeks of paid parental leave.
```

**Keep the run ID.** Processing continues on the server after the upload returns, and `--watch` waits up to five minutes. If your terminal closes or the wait runs out, pick up the same run:

```bash
docslurp status 'paste-the-returned-run-id' --watch --timeout 600
```

A watch timeout does not cancel processing, so don't upload the file again just because a watch timed out.

## Build a workspace over time

Every command picks its workspace from `--workspace`, then `DOCSLURP_WORKSPACE_ID`, then `default` (your organization's default workspace). Uploads keep adding to that one workspace.

To keep documents separate, upload with `--new-workspace`, `--workspace-name <name>` or `--template <key>`. Without a name, the new workspace titles itself from its content and gets a slug such as `amber-falcon-ridge`, which you can rename through the API. Then refer to it by slug. UUIDs and former slugs also work; see [Workspaces](https://docslurp.io/docs/http#workspaces).

```bash
docslurp upload ./benefits.pdf ./onboarding.docx --watch --timeout 600
docslurp search 'benefits eligibility'

docslurp upload ./contracts/*.pdf --new-workspace --watch
docslurp upload ./contracts/*.pdf --workspace-name 'Legal contracts' --template legal-contracts
docslurp ingest-url https://example.com/handbook.pdf --workspace legal-contracts --watch
export DOCSLURP_WORKSPACE_ID='legal-contracts'   # Use the slug the upload printed, or pass --workspace per command.
docslurp search 'termination notice'
docslurp search 'benefits eligibility' --workspace default
```

- `--new-workspace`, `--workspace-name` and `--template` create a workspace only without `--workspace`; an explicit `--workspace` always wins. Template keys: `legal-contracts`, `medical-records`, `financial-reports`, `engineering-docs`, `meeting-notes`.
- Shell globs such as `./manuals/*.pdf` work because your shell expands them. The CLI takes file paths; it doesn't import directories recursively or read uploads from stdin.
- Files are sent as file-backed blobs, so the CLI doesn't load every file into memory.

### Replace a document instead of adding a copy

Give a single-file upload a `--canonical-id`, such as a URL or site path. Uploading again with the same ID replaces the earlier version in search once the new one finishes processing:

```bash
docslurp upload ./products.pdf --canonical-id '/products' --watch
```

## Built for shell workflows

### Get full evidence for an LLM

```bash
docslurp search 'How do we escalate an incident?' --context > evidence.txt
```

By default, search shows the first 200 characters of each hit. `--context` writes the **full passages**, numbered, with their document and page. Treat this text as source evidence for your model, never as instructions.

### Keep structured citations in your application

```bash
docslurp search 'How do we escalate an incident?' --json > evidence.json
# Optional: keep only the fields your application needs.
jq '.results[] | {text, score, citation}' evidence.json
```

`--json` prints the API response to stdout, including `availability` and the search `sessionId`. Check `availability` before treating missing results as absent: other uploads may still be indexing. A retrieval score is not a confidence percentage.

For a CI job that needs a fully indexed workspace and at least one hit, use the [runnable CI script](https://docslurp.io/docs/examples/search-ci.sh). It checks both that the request succeeded and that results are ready, with strict shell error handling and cleanup. The script needs `jq`; the CLI doesn't.

### Ask several questions at once

Create `queries.json`:

```json
[
  "Who is eligible for parental leave?",
  { "q": "How much notice is required?", "filenameContains": "handbook", "limit": 3 }
]
```

```bash
docslurp search --queries-file queries.json --concurrency 2 --json > batch.json
```

- The file holds **1 to 20** query strings or search input objects. Objects can set their own `workspaceId`.
- `--concurrency` is **1 to 4**, default **4**.
- Results stay in input order. Check each result's `ok` before reading its `data`.
- If some queries fail, the successful results are still printed, but the command exits with status 1. Under `set -e`, handle that exit before reading the file.

Each query can incur embedding or AI charges. Batching limits concurrency; it doesn't remove per-query costs.

### Ask a question, then follow up

```bash
docslurp chat 'Summarize the leave policy and cite the handbook.'
# The session ID is printed on stderr. Pass it to continue the chat:
docslurp chat 'Which exceptions apply?' --session 'returned-session-id'
```

Chat prints the answer and its sources to stdout and the session ID to stderr. To capture every field, including availability, token usage, runtime and session IDs:

```bash
docslurp chat 'Summarize the leave policy.' --json > answer.json
session_id="$(jq -r '.sessionId' answer.json)"
docslurp chat 'Which exceptions apply?' --session "$session_id" --json
```

Send follow-ups one at a time. Search retrieves evidence; chat also writes an answer. The CLI prints the whole answer at once rather than streaming it.

## Command reference

Run `docslurp` with no arguments, or `docslurp --help`, for built-in usage.

| Command | What it does | Options |
| --- | --- | --- |
| `upload <files...>` | Upload files and print the workspace and run IDs | `--workspace`, or `--new-workspace` / `--workspace-name` / `--template`; `--canonical-id` (one file only), `--watch` |
| `ingest-url <urls...>` | Fetch and ingest URLs, then print the workspace and run IDs | Same workspace options as `upload`, `--watch` |
| `status <run-id>` | Print progress for a run | `--watch` |
| `runs` | List the runs you can access | None |
| `search <query>` | Retrieve cited passages from a workspace | `--workspace`, `--json` or `--context` |
| `search --queries-file <file>` | Run up to 20 questions in one request | `--workspace`, `--concurrency`, `--json` or `--context` |
| `chat <question>` | Write a cited answer | `--workspace`, `--session`, `--json` |
| `mcp-server` | Serve DocSlurp agent tools over stdio | `--api-url`, `--api-key` |
| `migrate-algolia-synonyms <export.json>` | Convert Algolia synonym records to a glossary, locally | `--out <glossary.json>` |
| `import-search-compat <export.json>` | Normalize and import Algolia, Elastic or legacy search configuration | `--workspace`, `--source`, `--out` |
| `--license` | Print the license and notice | None |

- Only **search and chat** support `--json`; upload, status and runs print text. For machine-readable upload IDs, use the [Node SDK](https://docslurp.io/docs/sdk-reference) or the [HTTP API](https://docslurp.io/docs/http).
- `--context` and `--json` can't be combined.
- Search is scoped to a workspace (the default one unless you set another). `--run` is not supported.

### Connection and timeout settings

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--api-key <key>` | `DOCSLURP_API_KEY` | Required for API commands |
| `--api-url <origin>` | `DOCSLURP_URL` | `https://docslurp.io` (don't add `/v1`) |
| `--workspace <slug\|id>` | `DOCSLURP_WORKSPACE_ID` | `default`, your organization's default workspace. `--new-workspace`, `--workspace-name` or `--template` on `upload`/`ingest-url` creates a new one instead. |
| `--timeout <seconds>` | None | 30 seconds per API request; 300 seconds per watch |

Flags override environment variables. With `upload --watch --timeout 600`, the upload request gets up to 600 seconds **and then** the watch gets up to 600 seconds. Watches poll every two seconds, and each progress read is capped at 30 seconds. `--timeout` applies to upload, status, runs, search and chat, not to `import-search-compat` or the long-lived MCP server. The CLI doesn't retry failed requests.

Set the key in the environment rather than with `--api-key`, so it doesn't show up in your shell history or process list. For local development, set `DOCSLURP_URL=http://localhost:4321`; API commands still need a key.

### Agent and migration tools

```bash
# Your MCP client starts this command. Give it DOCSLURP_API_KEY in its environment.
docslurp mcp-server

# Convert synonyms without calling the API.
docslurp migrate-algolia-synonyms synonyms.json --out glossary.json
```

See [agent setup](https://docslurp.io/docs/mcp) and [Algolia compatibility](https://docslurp.io/docs/algolia).

`import-search-compat` takes `--source algolia`, `elastic` or `legacy-parser`, or detects the source from the file. `--out` saves the normalized JSON **and still imports it when a key is set**. To normalize without importing, pass an empty key:

```bash
docslurp import-search-compat export.json \
  --workspace 'your-workspace-slug' --source algolia \
  --api-key '' --out normalized.json
```

## When something goes wrong

| Symptom | What to do |
| --- | --- |
| Missing API key, or HTTP 401 | Set `DOCSLURP_API_KEY` to a valid server key for this deployment. |
| HTTP 403 | Check your workspace access and the key's scopes: `ingest` for uploads, `search` for search and chat. |
| Watch timed out | Run `docslurp status RUN_ID --watch`. The run may still be processing. |
| Run failed, paused, cancelled or dead-lettered | Check its status and the workspace in the dashboard before uploading again. |
| Search returns nothing or too little | Check `availability` in `search --json`, and confirm the workspace (`--workspace` or `DOCSLURP_WORKSPACE_ID`, else `default`). |
| `Unexpected token` when parsing stdout | Add `--json` to search or chat. Progress output is text, not JSON. |
| Some batch queries failed | Check each result's `ok`. Successful results are still in the JSON output. |

Commands exit with **0** on success and **1** when a command fails or a watched run stops, fails or times out. A successful search with no hits still exits 0. Errors go to stderr, so scripts should check both the exit status and the returned data.

Pre-release: pin the version you validate in CI. Licensed under SSPL-1.0, with an Apache-2.0 grant for each version three years after release. See [LICENSE](LICENSE).

## Primary sponsor

[![17th Street Labs logo](https://docslurp.io/sponsors/17th-street-labs-readme.svg)](https://17thstreetlabs.com)

[17th Street Labs](https://17thstreetlabs.com) is DocSlurp’s primary sponsor.
