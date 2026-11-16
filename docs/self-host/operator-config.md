# Operator config file

One versioned JSON file holds a deployment's extraction tuning knobs and its deploy-wide model overrides. Point
`DOCSLURP_OPERATOR_CONFIG` at it, with the same file on the API and every worker:

```bash
DOCSLURP_OPERATOR_CONFIG=/etc/docslurp/operator.json
```

```json
{
  "version": 1,
  "ocr": { "maxConcurrent": 2, "pageReader": { "mode": "off" } },
  "ai": { "escalation": { "enabled": true, "maxPagesPerDocument": 25 } },
  "charts": { "originDefaults": { "app": "figures", "machine": "figures" }, "explicitFree": "auto" }
}
```

Keep the file in version control with the rest of your deployment and ship it inside the image or a read-only mount.
Nothing edits it at runtime.

## Startup rules

| Situation | Result |
|---|---|
| `DOCSLURP_OPERATOR_CONFIG` unset or empty | Code defaults, and each environment variable below keeps working as before. |
| Set, but not an absolute path, missing, unreadable (permissions), a directory, larger than 256 KiB or not JSON | The process refuses to start. |
| An unknown key at any level, a missing or unknown `version`, or a value outside its range | The process refuses to start. |
| A refused model override, `parsing.local` outside development, the page reader on without its daily cap | The process refuses to start. |
| A field also set as an environment variable with a different meaning | The process refuses to start. |
| A field also set as an environment variable with the same meaning | Starts, and logs the variable names. |

Every field sets the environment variable its reader has always used, before anything reads it. The readers, their
defaults and their own validation are unchanged, so a deployment can move one knob at a time from its environment into
the file, and a rollback to a release that reads only the environment keeps the same behaviour as long as the
environment still carries the values. The environment names will be retired in a later release; until then a variable
and a field may both be set only when they agree.

The API applies only the fields it reads (marked "API and worker" below); the worker applies all of them. Both log the
file's path and digest at startup:

```text
[operator-config] loaded role=worker path=/etc/docslurp/operator.json version=1 digest=sha256:… applied=…
```

## What the file cannot do

- **Lower the isolation floor.** Outside development (`NODE_ENV` other than empty, `development` or `test`, or a
  `service` profile), `parsing.local` is refused whatever it contains, and so is `router.preferNativeMarkdown: true`.
  No other field chooses where customer files are parsed: OCR mode, the PDF extractor, the parser sandbox, the service
  profile and quarantine stay environment settings with their own startup checks.
- **Raise a spend bound past its schema limit.** Every cap has a maximum below, and a value above it refuses startup
  instead of being clamped.
- **Remove the page reader's spend bound.** With `ocr.pageReader.mode` or `vision.pageReader.mode` on,
  `ocr.pageReader.orgDailyMaxCostCents` must be stated. Reader usage is not billed to customers, so this per-organization
  daily cap is its only spend bound.
- **Select a prohibited or over-priced model.** See [model overrides](#model-overrides).

## Fields

All fields are optional except `version`. Ranges are inclusive.

### `ocr` (worker)

| Field | Variable | Values |
|---|---|---|
| `maxAttempts` | `DOCSLURP_OCR_MAX_ATTEMPTS` | 1–7 |
| `maxLongEdge` | `DOCSLURP_OCR_MAX_LONG_EDGE` | 640–4000 |
| `maxConcurrent` | `DOCSLURP_OCR_MAX_CONCURRENT` | 1–32 |
| `language` | `DOCSLURP_OCR_LANGUAGE` | `auto` or codes such as `eng+deu` |
| `pageReader.mode` | `DOCSLURP_OCR_PAGE_READER` | `off`, `escalation`, `all`, `fastest`, `balanced`, `smart` |
| `pageReader.maxPagesPerDocument` | `DOCSLURP_OCR_PAGE_READER_MAX_PAGES` | 0–20000 |
| `pageReader.orgDailyMaxCostCents` | `DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS` | 0–10000000; required when a reader mode is on |

The page reader still refuses to start when it is on without a ready page image reader plugin.

### `vision` (worker)

| Field | Variable | Values |
|---|---|---|
| `pageReader.mode` | `DOCSLURP_VISION_PAGE_READER` | `off`, `all`, `fastest`, `balanced`, `smart` |
| `guards.pageAttempts` | `VISION_PAGE_ATTEMPTS` | 1–4 |
| `guards.regionAttemptsPerPage` | `VISION_REGION_ATTEMPTS_PER_PAGE` | 0–64 |
| `guards.breakerMinFailures` | `VISION_BREAKER_MIN_FAILURES` | 1–10000 |
| `guards.breakerFailureRate` | `VISION_BREAKER_FAILURE_RATE` | 0.01–1 |
| `guards.orgUnchargedLimitCents` | `VISION_ORG_UNCHARGED_LIMIT_CENTS` | 1–1000000 |
| `guards.throttleAllowance` | `VISION_THROTTLE_ALLOWANCE` | 0–20 |
| `guards.routeOverrunLimit` | `VISION_ROUTE_OVERRUN_LIMIT` | 1–1000 |
| `guards.routeWeightCorrectionMax` | `VISION_ROUTE_WEIGHT_CORRECTION_MAX` | 1–100 |

### `ai.escalation` (worker)

| Field | Variable | Values |
|---|---|---|
| `enabled` | `DOCSLURP_OCR_ESCALATION` | `true`, `false` |
| `maxPagesPerDocument` | `DOCSLURP_OCR_ESCALATION_MAX_PAGES` | 0–10000 |
| `maxAttemptsPerDocument` | `DOCSLURP_OCR_ESCALATION_MAX_ATTEMPTS` | 0–20000 |

### `models.overrides`

Deploy-wide emergency switches for the model behind a reader, for every project that did not choose one. Per-project
model mappings stay an administrator setting.

| Field | Variable | Who reads it | Must be |
|---|---|---|---|
| `vision` | `DOCSLURP_VISION_MODEL_URI` | API and worker | a hosted entry of the vision model catalog |
| `ocrEscalation` | `DOCSLURP_OCR_ESCALATION_MODEL` | worker | a hosted vision catalog entry on a hosted OCR provider |
| `chartGenerator` | `CHART_EXPORT_GENERATOR_MODEL` | worker | an `llm://openrouter/` vision catalog entry that is one of the worker's chart generator candidates |

Every override must also have a verified catalog price with an output price under $50 per million tokens, must not be
an OpenAI Pro or Ultra model (checked after decoding, and with any query removed), must not be a model family that is
never selected automatically, and must not be a catalog entry the catalog itself refuses. A refused override stops
startup; it never falls back silently.

### `router` (worker)

| Field | Variable | Values |
|---|---|---|
| `tableGate` | `PAGE_ROUTER_TABLE_GATE` | `off`, `shadow` |
| `preferNativeMarkdown` | `PAGE_ROUTER_PREFER_NATIVE_MARKDOWN` | `true` only in development |
| `decisionHealthHistory` | `DOCSLURP_DECISION_HEALTH_HISTORY` | an absolute path |

### `doppler` (worker)

PDF VM sharding and figure upload bounds.

| Field | Variable | Values |
|---|---|---|
| `shards` | `DOCSLURP_DOPPLER_SHARDS` | `true`, `false` |
| `maxShards` | `DOCSLURP_DOPPLER_MAX_SHARDS` | 1–128 |
| `vmMaxParallel` | `DOCSLURP_DOPPLER_VM_MAX_PARALLEL` | 1–64 |
| `vmGlobalParallel` | `DOCSLURP_DOPPLER_VM_GLOBAL_PARALLEL` | 1–256 |
| `shardTransferMb` | `DOCSLURP_DOPPLER_SHARD_TRANSFER_MB` | 1–8192 |
| `shardCostOverhead` | `DOCSLURP_DOPPLER_SHARD_COST_OVERHEAD` | 0–10 |
| `figureMibInFlight` | `DOCSLURP_DOPPLER_FIGURE_MIB_IN_FLIGHT` | 128–8192 |
| `figureUploadConcurrency` | `DOCSLURP_DOPPLER_FIGURE_UPLOAD_CONCURRENCY` | 1–64 |
| `figureBufferBytes` | `DOCSLURP_DOPPLER_FIGURE_BUFFER_BYTES` | 4 MiB–4 GiB |
| `figureWorkerBufferBytes` | `DOCSLURP_DOPPLER_FIGURE_WORKER_BUFFER_BYTES` | 4 MiB–4 GiB |

### `charts` (API and worker)

| Field | Variable | Values |
|---|---|---|
| `originDefaults.app` | `DOCSLURP_CHART_EXPORT_APP_DEFAULT` | `figures` (no chart export, the default) or `charts` (free chart steps) |
| `originDefaults.machine` | `DOCSLURP_CHART_EXPORT_API_DEFAULT` | same |
| `explicitFree` | `DOCSLURP_CHART_EXPORT_FREE_EXPLICIT` | `auto` (the variable stays unset: allowed exactly while `inline` is on), `on`, `off` |
| `inline` | `DOCSLURP_CHART_EXPORT_INLINE` | `true`, `false` |
| `freeVmBudget.runsPerOrgHour` | `DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR` | 0–10000 |

The chart export ceiling (`DOCSLURP_CHART_EXPORT`) stays an environment setting.

### `figureResume` (API and worker)

`enabled` (`DOCSLURP_FIGURE_RESUME`), `chat` (`DOCSLURP_FIGURE_RESUME_CHAT`), `audit` (`DOCSLURP_FIGURE_AUDIT`),
`gcDelete` (`DOCSLURP_FIGURE_GC_DELETE`), and the budgets `concurrency` (1–16), `globalMax` (1–256),
`orgDailyVmMinutes` (0–1440), `launchFloor` (1–64), `launchCeiling` (1–512), `vmMsPerPage` (1–2000),
`vmMsPerLaunch` (0–120000), `vmHeadroom` (1–16), `docVmSecondsFloor` (60–3600), `docVmSecondsCeiling` (60–43200),
`noProgressLimit` (1–32), `minProgressPercent` (0–50), `minProgressBytes` (0–1048576) and `maxGrants` (0–10), each
setting the `DOCSLURP_FIGURE_RESUME_*` variable of the same name.

### `raster` (worker)

| Field | Variable | Values |
|---|---|---|
| `pdftoppmLanes` | `PDF_PDFTOPPM_CONCURRENCY` | 1–4 |
| `pdftoppmProcesses` | `PDF_PDFTOPPM_PROCESS_CONCURRENCY` | 1–32 |

### `parsing.local` (worker, development only)

| Field | Variable | Values |
|---|---|---|
| `nativeEngine` | `DOCSLURP_PDF_ENGINE` | `off`, `shadow`, `native-pdf` |
| `rasterEngine` | `PDF_RASTER_ENGINE` | `pdftoppm`, `native-pdf` |

Refused, whatever the values, in every non-development environment.

### `rollout` (worker)

Flags for unfinished features. Each entry names its owner and the ticket that removes it:

```json
{ "rollout": { "layoutSource": { "value": "selective", "owner": "extraction", "removalTicket": "acme/docslurp#42" } } }
```

| Field | Variable | Values |
|---|---|---|
| `pageFacts` | `DOCSLURP_DOPPLER_PAGE_FACTS` | `off`, `store`, `use` |
| `layoutSource` | `DOCSLURP_DOPPLER_LAYOUT_SOURCE` | `walker`, `facts`, `both`, `selective` |

`removalTicket` is `#<n>`, `owner/repo#<n>` or an https issue link.

## Digest and skew

The digest is the sha-256 of the validated file in canonical form (sorted keys, no whitespace), so reformatting the file
does not change it and any value change does. Each worker reports its digest with its capability heartbeat
(`worker_capabilities.config_digests`, migration 0182). `GET /ops/worker-fleet` (the `METRICS_SECRET` bearer) returns
`operatorConfig`:

```json
{ "app": "sha256:…", "status": "ok", "workers": [{ "identity": "…", "digest": "sha256:…", "matches": true }] }
```

`status` is `ok` when every live worker runs the API's digest (or none of them, with the API, has a file), `skew` when
any live worker differs or reports no digest (an older build), and `unknown` when no live worker polls the task queue.
Deployments should fail their post-deploy check on anything but `ok`, after old workers have drained.
