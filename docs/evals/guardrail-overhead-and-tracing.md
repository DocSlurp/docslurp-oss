# Guardrail overhead and tracing

## Current evidence

The repository has synchronized policy/judge assets, but no runtime content-safety
screening in ingestion or chat. There is therefore no production on/off latency
measurement or measured safety pass rate. The Langfuse advisory judge is not an
inline guardrail. Free-account priority remains a pending enforcement requirement.

The reproducible [cost estimate](guardrail-cost-estimate.json) uses Gemini 3.1 Flash
Lite via OpenRouter at $0.25 input / $1.50 output per million tokens, verified in the
[live catalog](https://openrouter.ai/api/v1/models) on 2026-10-20. OpenAI's
[moderation endpoint](https://developers.openai.com/api/docs/guides/moderation)
has no model API fee. Provider cost and customer credits are different measures.

For 10,000 **screening checks**, each with 1,000 total input tokens (including policy)
and 100 billed output tokens (including reasoning), without retries or cache savings:

| Arm | Incremental provider fee | Extra calls per check | Added serial latency |
| --- | ---: | ---: | --- |
| Off baseline | $0 | 0 | 0 screening work |
| OpenAI moderation | $0 | 1 | One moderation request; unmeasured |
| Mastra LLM judge | $4.00 | 1 | One judge request plus orchestration; unmeasured |
| Moderation → judge on 10% | $0.40 | 1.1 average | Moderation plus judge on escalations; unmeasured |
| Moderation → judge on 25% | $1.00 | 1.25 average | Same path, more escalations; unmeasured |

These are model fees, not total platform costs. Compute, OCR/transcription, media
screening, storage/egress, telemetry ingestion, retries, gateway fees, and review
labor are excluded. Screening both input and output may double the number of checks;
long documents require multiple windows and repeated policy tokens. A 10,000-token
input plus 100-token output costs $26.50 per 10,000 judge checks. Actual escalation
rates are unknown. A rate is not a safety threshold; never reduce screening merely
to hit a cost estimate. Legitimate documentary exceptions must retain strict review.

Sequential screening adds to first-token latency. Output screening may require
buffering before release; speculative generation can consume spend even when input
is blocked. Summed span durations are not wall-clock overhead when calls overlap.
A cheaper rejected request is not evidence that accepted documents became faster.
Net provider spend = screening + downstream work actually performed + retries.

## Reproduce estimates and analyze paired observations

From `core/`:

```sh
node scripts/eval-sync/guardrail-overhead.mjs estimate docs/evals/guardrail-cost-assumptions.json docs/evals/guardrail-cost-estimate.json
node scripts/eval-sync/guardrail-overhead.mjs compare /path/observations.json /path/comparison.json
```

The comparison input contains `samples`, each with `pairId` (one repetition),
`workloadHash` (document/input plus relevant pipeline/config identity), `traceId`,
`mode` (`off`, `moderation`, `judge`, `cascade`), `outcome` (`allow`, `block`,
`review_required`, `error`), `elapsedMs`, and `providerCostUsd` (number or null).
Use end-to-end elapsed time and scoped, deduplicated ledger costs including retries;
never sum parent-span cost copies. Missing costs must be null. This tool analyzes
supplied observations; it does not claim their provenance or quality is verified.

Run paired arms in an isolated evaluation workspace with synthetic or approved
material, never disable production safeguards for benchmarking. Interleave/randomize
arm order, match worker size/concurrency, split cold/warm caches, retain failures and
all retries. Separate free/paid cohorts and document sizes/modalities. Capture request
first-token and total times, screening time, input/output coverage, downstream work
skipped, tokens, CPU/RSS, telemetry bytes and provider usage receipt IDs. Keep
provider-estimated, provider-actual and customer-ledger costs in separate series.

The analyzer rejects duplicate arms, mismatched workloads and missing baselines. It
reports p50/p95 and mean paired latency deltas only when both executions allowed the
work. Blocks/reviews/errors remain counted in all-outcome data; unknown costs remain
explicit. Quality (false negatives, documentary false positives, review rate) requires
an independently adjudicated holdout and the separate integrity gate before promotion.
No comparison result is supplied yet because runtime screening is absent.

## OTel changes and conventions

The shared SDK now applies allowlisted request/run/document/workspace/org/session
scope to all descendant spans, including third-party SDK spans, using a span
processor. Concurrent scopes stay isolated, explicit child attributes take priority,
and late-bound scope IDs reach later children. IDs belong on spans, not metric labels.
Each service resource includes `service.namespace=docslurp`, service name/version,
instance, environment and SDK language. Existing parent-based sampling and W3C trace
propagation remain in place.

The following optional custom attributes are propagated only when the caller provides
them; their presence must describe actual execution, not an intended configuration:

| Scope metadata | OTel attribute |
| --- | --- |
| guardrailMode | docslurp.guardrail.mode |
| guardrailPolicyVersion | docslurp.guardrail.policy.version |
| guardrailDecision | docslurp.guardrail.decision |
| guardrailStage | docslurp.guardrail.stage |
| accountTier | docslurp.account.tier |
| chatSessionId | gen_ai.conversation.id |

Use fixed span names (for example `guardrail.screen`) and bounded values for mode,
stage and decision. A policy rejection is a successful screening decision, not an
infrastructure error. Timeout/provider failures use error status and a bounded error
type. Successful duration metrics now omit `error.type`; server HTTP errors use the
status code consistently on spans and metrics. Non-Error throws no longer leak raw
text as error types. API embedding observations now explicitly name their provider.

GenAI operations retain `gen_ai.operation.name`, `gen_ai.request.model`, provider and
actual usage mappings; estimated local embedding tokens remain explicitly estimated.
The application ledger remains the billing source of truth. A native Langfuse
validation call is outside the application SDK and still needs usage reconciliation.

Sources checked 2026-10-20: [GenAI span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md),
[error recording](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/),
[HTTP spans](https://opentelemetry.io/docs/specs/semconv/http/http-spans/).
GenAI conventions remain evolving; preserve an intentional migration path instead
of changing dashboard keys on every dependency release.

## Verification limits

Local tests exercise real SDK propagation, concurrent tenant isolation, explicit
parent spans, Langfuse/OTLP export and content controls. This is not a production-wide
span completeness certification. Spans created before scope is known cannot inherit
future IDs; external services and separately configured tracer providers need their
own instrumentation. No production deployment, remote benchmark or paid model calls
were made for this change. Production SigNoz sampling, dashboards and trace coverage
must be checked after an authorized deployment and representative workload.
