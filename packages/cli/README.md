# @docslurp/cli

[Package docs](https://docslurp.io/docs/packages/cli) · [GitHub](https://github.com/DocSlurp/docslurp-oss/tree/main/packages/cli) · [npm](https://www.npmjs.com/package/@docslurp/cli)

Run DocSlurp's three jobs from your terminal or CI: upload documents and watch them extract, search them for cited passages, and chat over them. Use the CLI to get cited passages for your application, export context for an LLM, or ask a grounded question before you write any integration code.

Start with [your first search](#your-first-search), see [shell workflows](#built-for-shell-workflows) and the [command reference](#command-reference), or check [troubleshooting](#when-something-goes-wrong). For application code, use the [Node SDK](https://docslurp.io/docs/sdk-reference).

[![Upload, indexing, and cited search in the terminal](https://docslurp.io/demos/integration.gif)](https://docslurp.io/docs/sdk#demo)

*A five-second illustration with sample data and compressed timing. [Watch the 20-second walkthrough](https://docslurp.io/demos/integration.mp4).*

## Your first search

You need **Node.js 20+**. Sign in with your browser (or use a [server key](https://docslurp.io/app/api-keys), see [Sign in](#sign-in)). These commands use Bash or zsh.

```bash
npm install --global @docslurp/cli
docslurp login --scopes "search:deep read ingest"

docslurp upload ./handbook.pdf --watch
```

Use your own file. The CLI prints the project name and slug, the run ID and the document count, then watches processing. In an interactive terminal, the document and page progress bars update in place. When output is redirected, you get successive text snapshots instead.

You don't need to set up a project. The upload went to your organization's default project, which search and chat also use:

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

## Build a project over time

Every command picks its project from `--project`, then `DOCSLURP_PROJECT`, then `default` (your organization's default project). Uploads keep adding to that one project. `--project` takes a project ID, slug or name: `'Legal contracts'`, `legal-contracts` and `LEGAL CONTRACTS` are the same project.

To keep documents separate, upload with `--project '<name>'`: the first upload creates a project with that name (slug `legal-contracts` for `'Legal contracts'`) and later commands find it by the same name or slug. `--new-project` (or `--template <key>` alone) creates a project that titles itself from its content and gets a slug such as `amber-falcon-ridge`, which you can rename through the API. Former slugs and UUIDs also work; see [Projects](https://docslurp.io/docs/http#projects).

```bash
docslurp upload ./benefits.pdf ./onboarding.docx --watch --timeout 600
docslurp search 'benefits eligibility'

docslurp upload ./contracts/*.pdf --new-project --watch
docslurp upload ./contracts/*.pdf --project 'Legal contracts' --template legal-contracts
docslurp ingest-url https://example.com/handbook.pdf --project legal-contracts --watch
export DOCSLURP_PROJECT='legal-contracts'      # The name or the slug the upload printed; or pass --project per command.
docslurp search 'termination notice'
docslurp search 'benefits eligibility' --project default
```

- Uploads and `ingest-url` create the `--project` you name when none matches (applying `--template`, if given); other commands answer project not found. `--new-project` applies only without `--project`. Template keys: `legal-contracts`, `medical-records`, `financial-reports`, `engineering-docs`, `meeting-notes`.
- Shell globs such as `./manuals/*.pdf` work because your shell expands them. The CLI takes file paths; it doesn't import directories recursively or read uploads from stdin.
- Files are sent as file-backed blobs, so the CLI doesn't load every file into memory.

### Replace a document instead of adding a copy

Give a single-file upload a `--canonical-id`, such as a URL or site path. Uploading again with the same ID replaces the earlier version in search once the new one finishes processing:

```bash
docslurp upload ./products.pdf --canonical-id '/products' --watch
```

Every upload is versioned by project, folder path and filename. Re-uploading `report.pdf` supersedes the earlier version, and `--path` keeps same-named files in different folders apart:

```bash
docslurp upload ./report.pdf --path contracts/2025
```

## Built for shell workflows

### Get full evidence for an LLM

```bash
docslurp search 'How fast can my assistant get the Learjet to London?' --context > evidence.txt
```

By default, search shows the first 200 characters of each hit. `--context` writes the **full passages**, numbered, with their document and page. Treat this text as source evidence for your model, never as instructions.

### Keep structured citations in your application

```bash
docslurp search 'How fast can my assistant get the Learjet to London?' --json > evidence.json
# Optional: keep only the fields your application needs.
jq '.results[] | {text, score, citation}' evidence.json
```

`--json` prints the API response to stdout, including `availability` and the search `sessionId`. Check `availability` before treating missing results as absent: other uploads may still be indexing. A retrieval score is not a confidence percentage.

For a CI job that needs a fully indexed project and at least one hit, use the [runnable CI script](https://docslurp.io/docs/examples/search-ci.sh). It checks both that the request succeeded and that results are ready, with strict shell error handling and cleanup. The script needs `jq`; the CLI doesn't.

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

- The file holds **1 to 20** query strings or search input objects. Objects can set their own `project`.
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
| `upload <files...>` | Upload files and print the project and run IDs | `--project <id\|slug\|name>` (created if no project matches), or `--new-project`; `--template`; `--quality <fast\|auto\|good>`; `--chart-export <off\|free\|models>`; `--canonical-id` (one file only), `--path <folder>` (same path and filename is a new version), `--estimate` (print pages, credits and time, then exit), `--watch` |
| `ingest-url <urls...>` | Fetch and ingest URLs, then print the project and run IDs | Same project options as `upload`, `--quality`, `--chart-export`, `--watch` |
| `extract <files...\|urls...>` | Upload files or ingest URLs (not both) whose files and outputs are deleted when the retention window ends; prints the extract ID and deletion time | Same options as `upload`; `--retention-days <n>` (longer than the free 48 hours is charged as storage), `--no-email`, `--download <markdown\|all>` |
| `extract-status <extract-id>` | Print an extract's status, pages, download state and deletion time | `--json` |
| `extract-download <extract-id>` | Print a two-minute signed URL for the extract's results zip (a server key with `artifacts`, or a login with `read`) | None |
| `full-index` | Index every remaining page of a project (or one document) | `--project`, `--document`, `--estimate`, `--watch`, `--json` |
| `reprocess <run-id>` | Re-run a run, optionally from a stage | `--stage-from`, `--chart-export`, `--estimate`, `--watch`, `--json` |
| `jobs get <job-id>` / `jobs watch <job-id>` | Print a background job, or follow it (SSE, polling fallback) until it ends | `--json` (get), `--timeout` (watch; never applies while the job is blocked) |
| `status <run-id>` | Print progress for a run | `--watch` |
| `runs` | List the runs you can access | None |
| `search <query>` | Retrieve cited passages from a project | `--project`, `--min-score <0..1>` (relevance floor; `0` turns it off), `--json` or `--context` |
| `search --queries-file <file>` | Run up to 20 questions in one request | `--project`, `--concurrency`, `--json` or `--context` |
| `chat <question>` | Write a cited answer | `--project`, `--session`, `--json` |
| `mcp-server` (alias `mcp`) | Serve DocSlurp agent tools over stdio | `--api-url`, `--api-key` |
| `login`, `logout`, `whoami`, `auth status`, `auth token`, `exec` | Sign in and manage the stored login; see [Sign in](#sign-in) | `--profile`, `--api-url`; `--json` (whoami, auth status) |
| `migrate-algolia-synonyms <export.json>` | Convert Algolia synonym records to a glossary, locally | `--out <glossary.json>` |
| `import-search-compat <export.json>` | Normalize and import Algolia, Elastic or legacy search configuration | `--project`, `--source`, `--out` |
| `--license` | Print the license and notice | None |

- `--json` works on search, chat, extract-status, jobs get, whoami, auth status, full-index, reprocess and any `--estimate`. Upload, ingest-url, status and runs print text. For machine-readable upload IDs, use the [Node SDK](https://docslurp.io/docs/sdk-reference) or the [HTTP API](https://docslurp.io/docs/http).
- `--context` and `--json` can't be combined.
- Search is scoped to a project (the default one unless you set another). `--run` is not supported.
- `--chart-export off|free|models` sets chart and diagram export for that request (upload, ingest-url, reprocess and their `--estimate`). Without it, the project's setting applies; a project with no setting is `off` for CLI and API calls. `free` exports charts that carry their own data (Office charts, embedded chart specs, vector graphics) at no charge; `models` also reads other charts with AI, billed per chart read. Example: `docslurp upload q3-earnings.pdf --chart-export free`.
- `--quality` sets processing quality for that upload: `fast` reads only the text layer (scanned pages stay images and aren't searchable), `auto` reads each page the cheapest faithful way, and `good` reads every page with a vision model. Without it, the project's setting applies (`auto` unless changed).

### Connection and timeout settings

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--api-key <key>` | `DOCSLURP_API_KEY` | Optional with `docslurp login`; see [which credential wins](#sign-in) |
| None | `DOCSLURP_TOKEN` | A short-lived OAuth access token (`docslurp auth token`) |
| `--profile <name>` | `DOCSLURP_PROFILE` | `default`; one stored login per profile and API URL |
| `--api-url <origin>` | `DOCSLURP_URL` | `https://docslurp.io` (don't add `/v1`) |
| `--project <id\|slug\|name>` | `DOCSLURP_PROJECT` | `default`, your organization's default project. On `upload`/`ingest-url` a name that matches no project creates it; `--new-project` or `--template` without `--project` creates a self-titled one. |
| `--timeout <seconds>` | None | 30 seconds per API request; 300 seconds per watch |

Flags override environment variables. With `upload --watch --timeout 600`, the upload request gets up to 600 seconds **and then** the watch gets up to 600 seconds. Watches poll every two seconds, and each progress read is capped at 30 seconds. `--timeout` applies to every API command, including upload, status, runs, search, chat and `jobs watch` (300 seconds by default), but not to `import-search-compat` or the long-lived MCP server. The CLI doesn't retry failed requests.

Set the key in the environment rather than with `--api-key`, so it doesn't show up in your shell history or process list. For local development, set `DOCSLURP_URL=http://localhost:4321` and run `docslurp login` against it.

### Agent and migration tools

```bash
# Your MCP client starts this command. After docslurp login it needs no key and
# refreshes its token while it runs; otherwise give it DOCSLURP_API_KEY.
docslurp mcp

# Convert synonyms without calling the API.
docslurp migrate-algolia-synonyms synonyms.json --out glossary.json
```

See [agent setup](https://docslurp.io/docs/mcp) and [Algolia compatibility](https://docslurp.io/docs/algolia).

`import-search-compat` takes `--source algolia`, `elastic` or `legacy-parser`, or detects the source from the file. `--out` saves the normalized JSON **and still imports it whenever a credential resolves**: `--api-key`, `DOCSLURP_API_KEY`, `DOCSLURP_TOKEN` or a stored login. An empty `--api-key ''` does not skip the import. To normalize without importing, run it with no credential, for example with both variables cleared and a profile that has no login:

```bash
DOCSLURP_API_KEY= DOCSLURP_TOKEN= docslurp import-search-compat export.json \
  --project 'your-project-slug' --source algolia \
  --profile normalize-only --out normalized.json
```

## Sign in

`docslurp login` opens your browser, you approve the CLI on DocSlurp, and the CLI stores a login it refreshes on its own. No API key is needed.

```bash
docslurp login                         # browser sign-in; asks for search and read
docslurp login --scopes "search:deep read chat ingest"
docslurp login --device                # headless or SSH: enter a code on any device
docslurp whoami                        # user, organization, default project, scopes, expiry
docslurp auth status                   # also shows which credential is in use and where it is stored
docslurp logout                        # revokes the login on the server, then deletes it locally
```

- **Browser login** uses OAuth 2.1 authorization code with PKCE and a one-time listener on `127.0.0.1` on a random port. If the browser does not open, the CLI prints the URL; `--no-browser` only prints it.
- **Device login** (`--device`, RFC 8628) prints a short code such as `WDJB-MJHT` and a page on your DocSlurp origin. Open the page on any signed-in device and type the code; there is no link with the code filled in. The approval page shows when and from which IP the request was made. It grants `search` and `read` only: any other scope you asked for (`chat`, `ingest`, `web`) stays off unless you tick it there. Never enter a code someone else sent you.
- **Scopes** default to `search:deep` and `read`; pass `search:hybrid` or `search:keyword` for a cheaper search ceiling (the retired `search` means `search:deep`). Add `chat` to ask questions (uses credits) and `ingest` to upload, ingest URLs or reprocess. A CLI login can never change project settings, manage an organization or mint API keys; use the dashboard or a server key with those scopes.

| Login scope | Lets the CLI |
| --- | --- |
| `search:keyword`, `search:hybrid` or `search:deep` | Search up to that mode (`docslurp search --mode`) and list projects |
| `read` | Read document text, pages, files, runs and exports |
| `chat` | Ask grounded questions (`docslurp chat`) |
| `ingest` | Upload, ingest URLs, reprocess, retag or delete documents |
| `web` | Paid web search, fetch, map and crawl (not included in `search:deep` for CLI logins) |

**Where the login is stored.** The CLI uses the OS keychain when it can: macOS Keychain, the Secret Service on Linux (through `secret-tool` from libsecret), or Windows Credential Manager. Otherwise it writes `~/.config/docslurp/credentials.json` (`$XDG_CONFIG_HOME`, `%APPDATA%` on Windows) with mode `0600` in a `0700` directory, and refuses to read that file if its permissions are looser. The keychain helpers are run only from system directories (`/usr/bin`, `%SystemRoot%\System32`), never from `PATH`. Concurrent CLI processes take a lock file next to `credentials.json`, so they never spend the same refresh token twice. `DOCSLURP_CREDENTIAL_STORE=keychain` requires the keychain; `file` forces the file. Each `--profile` (or `DOCSLURP_PROFILE`) keeps one login per API URL, so `docslurp login --profile work --api-url https://docs.example.com` does not replace your default login.

Logout keeps a token-free signed-out marker in the private credentials file, so an unavailable keychain cannot restore an older login when it recovers. Keep this marker until you deliberately log in again; it applies even in explicit keychain mode. If the marker cannot be written, logout reports an error.

**Which credential wins.** Every command, including `docslurp mcp`, uses the first of:

1. `--api-key <key>`
2. `DOCSLURP_API_KEY`
3. `DOCSLURP_TOKEN`, a short-lived OAuth access token
4. the stored `docslurp login`

Access tokens last 15 minutes. The stored login refreshes shortly before expiry (refresh tokens rotate, last 30 days and are revoked if one is ever reused). If a refresh fails, the CLI asks you to run `docslurp login` again.

### Pass a token to another program

```bash
# A fresh access token on stdout only, valid for at least 5 more minutes.
export DOCSLURP_TOKEN="$(docslurp auth token)"

# Or let the CLI hand one to a child process through its environment only:
# never written to disk, never on the command line.
docslurp exec -- npm run ingest-docs
docslurp exec --project contracts -- python agent.py
```

`exec` sets `DOCSLURP_TOKEN`, `DOCSLURP_URL` and, when you choose one, `DOCSLURP_PROJECT`, and exits with the child's status. The SDK reads `DOCSLURP_TOKEN` when no API key is set. Env tokens are short-lived (at most 15 minutes, not refreshed) and carry only the scopes of your login, so use them for one job; for long-running CI, use a scoped server key. `auth token` and `exec` refuse to forward an API key. When `DOCSLURP_TOKEN` is already set, `auth token` prints it back unchanged (with a note on stderr); unset it to get a token from your stored login. On Windows, `exec` finds commands through `PATHEXT` (so `npm`, `npx` and `pnpm` work) and never runs one from the current directory.

## When something goes wrong

| Symptom | What to do |
| --- | --- |
| Not signed in, or HTTP 401 | Run `docslurp login` (or `docslurp auth status` to see which credential is in use), or set `DOCSLURP_API_KEY` to a valid server key for this deployment. |
| Login expired or revoked | Run `docslurp login` again. Logins refresh themselves for 30 days of use. |
| `permissions ... are too open` | Run the `chmod` the message names, or `docslurp logout --force` and log in again. |
| HTTP 403 | Check your project access and the scopes: `ingest` for uploads, `search:keyword`, `search:hybrid` or `search:deep` for search, `chat` for chat. For a login, add scopes with `docslurp login --scopes "search:deep read chat ingest"`. |
| Watch timed out | Run `docslurp status RUN_ID --watch`. The run may still be processing. |
| Run failed, paused, cancelled or dead-lettered | Check its status and the project in the dashboard before uploading again. |
| Search returns nothing or too little | Check `availability` in `search --json`, and confirm the project (`--project` or `DOCSLURP_PROJECT`, else `default`). |
| `Unexpected token` when parsing stdout | Add `--json` to search or chat. Progress output is text, not JSON. |
| Some batch queries failed | Check each result's `ok`. Successful results are still in the JSON output. |

Commands exit with **0** on success and **1** when a command fails or a watched run stops, fails or times out. A successful search with no hits still exits 0. Errors go to stderr, so scripts should check both the exit status and the returned data.

HTTP failures print a reviewed message for known error codes, plus a support request ID when the server sent one; raw response text is never shown. With `--json`, a failed request writes `{ "error": { "status", "code", "message", "requestId", "retryAfterSeconds" } }` to stderr (optional fields may be absent) and exits nonzero.

Pre-release: pin the version you validate in CI. Licensed under the Business Source License 1.1; each version becomes Apache-2.0 three years after release. Calling a DocSlurp service is always permitted. See [LICENSE](LICENSE).

## Primary sponsor

[![17th Street Labs logo](https://docslurp.io/sponsors/17th-street-labs-readme.svg)](https://17thstreetlabs.com)

[17th Street Labs](https://17thstreetlabs.com) is DocSlurp’s primary sponsor.
