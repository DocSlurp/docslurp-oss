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
