# Pipeline metrics

DocSlurp emits product-level metrics on the OpenTelemetry meter `docslurp.pipeline`, next to the operation, dependency and HTTP histograms. They are exported whenever OTLP metrics are configured (`OTEL_EXPORTER_OTLP_*`), need no extra setup, and never carry organization, project, document or run identifiers: every label is a bounded category.

Durations are histograms in seconds with boundaries from 0.5 s to 4 h, so quantiles are usable for both a one-page upload and a 10,000-page document.

## Run milestones

`docslurp.run.milestone.duration` is the time from run acceptance (`project_runs.created_at`) to the first time something happens in that run. Queue wait is inside the number.

| `milestone` | Meaning | Extra label |
| --- | --- | --- |
| `worker_started` | A worker picked the run up for the first time | `start`: `cold` when the worker process was younger than two minutes, else `warm` |
| `first_page_extracted` | The first page has extracted content, by any method | |
| `first_page_completed` | The first page finished every page-level stage of the run's plan | |

Each milestone is stamped once on `project_runs` (`worker_started_at`, `first_page_extracted_at`, `first_page_completed_at`) by a conditional update, so the metric is recorded at most once across workers, retries and resumes. The columns are the source of truth: a worker that stops before its next metric export loses the sample but not the timestamp. `worker_started` carries no `pages` label, because the page count is rarely measured that early.

`first_page_completed` follows the plan: it fires on the last stage that checkpoints pages one by one (for a default run, `embed`). Document-level stages such as `index` have no per-page completion; a document that never checkpoints pages closes both page milestones when it is indexed.

## Document milestones

`docslurp.document.milestone.duration` is the time from run acceptance to a document reaching a state:

| `milestone` | Meaning |
| --- | --- |
| `lexical_searchable` | Every chunk is written; keyword (BM25) search can serve the document |
| `embedded` | The `embed` stage completed: embeddings are written |
| `indexed` | The `index` stage completed: the document is fully searchable |

## Run outcomes and throughput

| Metric | Kind | Labels |
| --- | --- | --- |
| `docslurp.run.outcomes` | counter | `outcome` (`completed`, `completed_with_failures`, `failed`), `pages`, and `stage` for failures |
| `docslurp.run.duration` | histogram, s | `outcome`, `pages` |
| `docslurp.run.pages_per_minute` | histogram | `pages`; full-pipeline throughput of a run that completed, measured from acceptance |
| `docslurp.document.stage.failures` | counter | `stage`, `code` (the public document failure code) |
| `docslurp.document.stage.retries` | counter | `stage`, `reason` (`error`, `low-plausibility`) |

Run outcomes are recorded once per run (`project_runs.outcome_recorded_at`), so a retried terminal step does not count twice. Cancelled runs are not counted.

`pages` is the run's or document's page-count bucket: `1`, `2-10`, `11-100`, `101-1000`, `1001+`, or `unknown` before the count is measured.

## Page routing

| Metric | Kind | Labels |
| --- | --- | --- |
| `docslurp.pages.routed` | counter of pages | `route` (`text`, `read`, `blank`), `reason` (why a page was sent to a read: `raster`, `garbled`, `drawn`, `yield-deficit`, `other`) |
| `docslurp.pages.escalation` | counter of pages | `route` (`ocr-hosted`, `vision`), `outcome` (`replaced`, `failed`, `skipped-<reason>`, or a vision page outcome) |
| `docslurp.pages.router_decisions` | counter of pages | `mode` (`shadow`, `active`), `pixels` (`yes`/`no`), `agrees` (`yes`/`no`/`unknown`, against the current routing) |

The share of pages escalated beyond fast extraction is `read / (text + read + blank)` over `docslurp.pages.routed`.

## Capability pools

Each billed page capability (`text`, `ocr`, `vision`) has an ordered pool of members with automatic failover (`packages/shared/src/capability-pools.ts`). The worker logs its resolved pools at startup (`[capability-pools] ...`), advertises them in its registry row, and `/ops/worker-fleet` shows them (`capabilityPools`).

| Metric | Kind | Labels |
| --- | --- | --- |
| `docslurp.capability_pool.served` | counter of pages | `capability`, `member` (the pool member id, such as `ocr.llm.glm-5.3-flash+wafer.us`) |
| `docslurp.capability_pool.failover` | counter | `capability`, `from`, `to` (`none` when nothing was left), `reason` (`margin`, `routing`, `unavailable`, `privacy`, `error`, `unsupported`) |

A `routing` failover is a request no host would serve under its constraints (nothing billed): it is handed back to the vision guard and never counts toward its breaker. The share of pages served by a pool's first member is `served{member=<first>} / sum(served)` per capability.

## Search and chat

| Metric | Kind | Labels |
| --- | --- | --- |
| `docslurp.search.requests` | counter | `results` (`zero`, `some`) |
| `docslurp.chat.agent.first_text` | histogram, s | `gen_ai.request.model`; request start to the first answer text, including tool calls before it |

Search latency is `docslurp.operation.duration` with `docslurp.operation.name="api.search"`; chat turn duration and stop reasons are `docslurp.chat.agent.duration`.

## Credits charged against provider cost

Where billing is enforced, the alert leader adds every newly settled item (a finished run, a chat turn, a charged search session) to counters labelled by `kind` (`run`, `chat-turn`, `search-session`):

| Metric | Meaning |
| --- | --- |
| `docslurp.billing.items` | Settled items |
| `docslurp.billing.loss_items` | Items whose provider cost exceeded the credits they charged |
| `docslurp.billing.credit_cents` | Credits charged (1 credit = 1 cent) |
| `docslurp.billing.provider_cost_cents` | What providers charged, or the list-price estimate where no receipt arrived |
| `docslurp.billing.estimated_cost_cents` | The estimated part of the provider cost |
| `docslurp.billing.pages` | Pages processed by the runs among the items |

Means and ratios are divisions of these counters over a window: mean cost per run is `provider_cost_cents / items`, mean margin `(credit_cents - provider_cost_cents) / items`, and pages per $1 of provider cost `pages / (provider_cost_cents / 100)`. Refunded chat turns are excluded. Each item is counted once, when it first settles: usage it receives afterwards is not added, a run longer than the six-hour lookback counts only its recent usage, and a change of alert leader can repeat or skip one interval. Treat the counters as operational trends, not accounting; `usage_events` remains the ledger.

## Stalled runs

The alert evaluator (`ALERTS_ENABLED`) adds `processing-run-stalled`: a warning when a processing run has written no run event (page, document or stage progress) for `ALERT_STALLED_RUN_SECONDS` (default 1800). It complements `stale-leases`, which only sees a worker that stopped heartbeating: a worker can stay alive and make no progress. Runs with an expired lease are left to `stale-leases`. The alert carries a count; while it fires, a second stalled run changes the count without a new notification until the repeat interval.
