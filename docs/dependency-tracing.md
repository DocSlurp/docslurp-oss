# Dependency tracing

The API and worker share one OpenTelemetry tracer provider. When configured, both
SigNoz (OTLP) and Langfuse receive DocSlurp dependency spans, not just AI generations.
The Langfuse processor explicitly accepts the `docslurp.*` instrumentation scopes.
Existing AI SDK spans retain their normal export filter.

## Reading a request

Follow the same trace ID from the HTTP request or worker activity into observations
and dependency calls. Dependency spans inherit request, run, document, workspace,
organization, session and stage IDs when those are available in the observation
scope. Late-bound IDs apply to subsequent children; parent trace links remain the
primary correlation mechanism. Existing W3C context propagation connects services.

Background loops (timer ticks and LISTEN drains, such as the credit-debit flush,
graph-job poll, maintenance sweeps and alert evaluation) run each pass under
`withBackgroundSpan`, a root span named for the task (`worker.graph-jobs`,
`maintenance.webhook-outbox`, `api.db-watchdog`) with a `docslurp.background.task`
attribute. Their queries are its children instead of one-span traces, so filter
or group by that attribute to separate idle polling from request and run work.

- PostgreSQL spans cover query consumption, including pool wait, and transactions.
  They include the host, port, operation, returned row count and SQLSTATE on failure.
  Query values and connection credentials are excluded.
- S3 command spans cover retries and streamed download consumption. Attempt spans
  end at response headers. Bucket, object key, host, provider, request ID, status,
  declared content length and retry count support provider comparisons. Do not sum
  command and attempt durations: the attempts are nested within the command.
- LLM, embedding, speech and capacity-provider HTTP spans cover transport through
  response-body consumption. They retain host, operation, response status, actual
  body size and provider request IDs. Model and token details belong on their
  enclosing generation or embedding observations.
- LanceDB connection/open/search adapter spans distinguish native vector work
  from JavaScript S3 requests. Native LanceDB object-store requests do not pass
  through the AWS SDK middleware; adapter duration is not an S3 wire measurement.

### LanceDB native S3 requests (`LANCEDB_S3_TRACE=1`)

Lance's Rust object store has no request hooks and its `LANCE_LOG` output has no
per-request records, so without help S3 request counts and latency for index storage
are lower bounds (JavaScript SDK spans only). Set `LANCEDB_S3_TRACE=1` (default off,
`s3://` Lance roots only) to start an in-process localhost proxy per upstream endpoint
and point Lance at it with `allow_http`, path-style addressing. The proxy re-signs
each request with SigV4 for the real host, streams request and response bodies, and
forwards all other headers untouched, so `If-None-Match` / `If-Match` commit
semantics and 412 responses are unchanged. It needs explicit credentials (storage URI
userinfo or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`); session tokens are
supported. aws-chunked streaming payloads are rejected (object_store does not use them).

Each request becomes a `lancedb.s3.<Operation>` span (`GetObject`, `HeadObject`,
`PutObject`, `CopyObject`, `DeleteObject`, `DeleteObjects`, `ListObjectsV2`,
`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, and so on) with
`docslurp.storage.system=lancedb-s3`, `docslurp.dependency.type=s3`, phase `native`,
provider, `server.address`, `aws.s3.bucket`, a truncated key prefix
(`docslurp.s3.key_prefix`, first three segments), response status, request and
response body bytes, `docslurp.s3.ttfb_ms`, `docslurp.s3.duration_ms`, the `Range`
header and `docslurp.s3.condition`. Metrics stay on the shared bounded dimensions;
keys never become labels. Retries happen inside object_store and are invisible
except that a request identical to a recent 5xx/429/aborted one is marked
`docslurp.lancedb_s3.retry_suspected` (a heuristic).

Every 60 seconds the process logs one line, `[lancedb-s3] window=60s requests=...
errors=... retries=... bytes_in=... bytes_out=... avg_ms=... avg_ttfb_ms=... p50_ms=...
p95_ms=... p99_ms=... ops=Op=n,... statuses=Op:status=n,... total_requests=...`.
Percentiles are histogram bucket upper bounds. `getLanceS3TraceStats()` from
`@docslurp/shared/lancedb-s3-trace` returns the cumulative counters.

With `LANCEDB_S3_CACHE_DIR` set the proxy also serves cached reads (see
[Local disk cache for LanceDB](self-host/operations.md#local-disk-cache-for-lancedb)). The
summary line then ends with `upstream_requests=...` (requests actually sent to the
object store) and `cache_hits`, `cache_misses`, `cache_hit_ratio`, `cache_bypass`,
`cache_bytes_served`, `cache_bytes_filled`, `cache_fill_requests`, `cache_evictions`,
`cache_evicted_bytes`, `cache_size_bytes` and `cache_max_bytes`; spans carry
`docslurp.lancedb_s3.cache` (`hit`, `miss`, `upstream` for passed-through origin errors
and HEAD misses, `bypass`) and the bytes served, bytes filled and upstream requests
for that request. Cached responses also set `x-docslurp-cache`.

Caveats: the proxy is another hop. On loopback against MinIO it added about
0.2-0.5 ms per request and about 0.7 ms per MB streamed (roughly a 1.4 GB/s
ceiling); against a remote provider this is small next to network latency, but
confirm with `worker/scripts/lancedb-s3-trace-bench.ts` before trusting absolute
timings, and keep it off for headline throughput runs unless every compared
provider uses it. Spans are not linked to a workspace or run: requests arrive from a
native thread outside the async context, so correlate by time window and key prefix.
Upstream addressing is always path-style, and the proxy runs per process (API and
each worker log their own lines).

Metrics use bounded provider, operation, phase and error-type dimensions. IDs,
object keys and hosts remain trace attributes, not metric labels.

## Costs

`usage.receipt` spans link ledger events to a request chain. Use
`docslurp.usage.event_id` to deduplicate repeated receipts. `provider_cost_usd` is
supplier cost from the priced event metadata; missing cost remains unknown.
`billable_credits` is customer credits, never dollars. `cost_source` distinguishes
configured pricing from reported costs when the caller supplies that information.
The recorded source trace/span IDs survive deferred ledger flushes.

Receipts are diagnostic records, not proof of database commit. The usage ledger
and usage-attribution service remain authoritative for billing. Do not add receipts
to generation estimates or parent cost summaries: they describe the same spend.
Langfuse receives these explicit custom attributes; its model-price estimates are
not a replacement for the DocSlurp supplier-cost ledger.

## Configuration and verification

Configure `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and
`LANGFUSE_ENABLED=true` alongside the existing `OTEL_EXPORTER_OTLP_*` settings.
Startup logs name each active destination. Neither a successful local test nor a
Langfuse-only startup proves production SigNoz delivery.

Real local exporter tests exercise Langfuse's OTLP JSON payload and the SigNoz
protobuf path, including child relationships and cost/correlation attributes.
S3 tests use the actual AWS SDK against a local HTTP server. PostgreSQL integration
tests use `GRAPH_PURGE_TEST_DATABASE_URL` pointing at a disposable database.
Provider transport tests verify lazy streaming, cancellation and error identity.

During production testing or performance tuning, inspect errors and latency before,
during (at least every five minutes), and after the experiment. Record the time
window, deployment, sample count and p50/p95/p99, separating warm/cold requests,
retries, pool wait, response headers and body consumption. Compare storage providers
from the same host with the same objects and concurrency before recommending a
migration. No unattended recurring job is required.

Credentials and auth headers are excluded. Langfuse content capture continues to
use `LANGFUSE_CAPTURE_CONTENT`; dependency metadata does not require enabling it.
