# Content-safety Langfuse integration verification

Verified 2026-10-20 MDT against the existing private Langfuse v4.59.0 host through
an authorized temporary SSH tunnel. [Asset readback](content-safety-langfuse-sync.json)
and [provider readback](langfuse-model-defaults.json).

The project default and versioned advisory safety judge now use
`openrouter/google/gemini-3.1-flash-lite`. Native judge creation passed provider
validation and readback reports `active`. Published text prices verified against
[OpenRouter's live catalog](https://openrouter.ai/api/v1/models) are $0.25 input and
$1.50 output per million tokens. This is a working economical starting model, not
a measured safety-quality winner.

The user explicitly authorized storing both existing production provider keys in
self-hosted Langfuse. OpenRouter credential authentication succeeded. Connections
use explicit lists with `withDefaultModels: false`:

- OpenRouter: `openai/gpt-6-luna`, `google/gemini-3.1-flash-lite`, via its OpenAI-compatible endpoint.
- OpenAI: `gpt-6-luna`, via Chat Completions. Luna appears in the authenticated
  account catalog, but native evaluator validation failed through both Responses
  and Chat Completions. It is available as a candidate, **not the project default**.
  OpenRouter Luna has not been inference-tested. Standard Luna pricing is $0.10
  input / $0.50 output per million tokens, verified against
  [official pricing](https://developers.openai.com/api/docs/models/gpt-6-luna).

No automatic catalogs, Pro/Ultra models, or models priced at $50/M output or above
were enabled. The former GPT-4.1-mini evaluator is retained as historical versioned
configuration, not the current manifest or project default. No automatic evaluation
rules or dataset evaluation batches were started.

The native default-model setting is not exposed in the public API of this deployed
version. Its existing configuration row was set through the installed Prisma client,
scoped to project `docslurp`, and read back. No schema changes or restarts were made.
The selected Gemini model separately passed native evaluator validation.

## Validation accounting correction

Native evaluator creation performs server-managed provider validation calls. Earlier
reports claiming `llmCalls: 0` for native judge writes are invalid: the API does not
return actual usage. This session made three failed Luna validation attempts and
one successful Gemini evaluator creation/validation. Token counts, internal retries,
and billed cost are unknown, not zero. No quality scores or benchmark results follow
from these connectivity checks. The sync reporter now records unknown usage rather
than fabricating a zero. Capturing these server-managed calls in the application
usage ledger remains an integration gap before paid evaluation batches.

Prompts/source archive remain at version 1; all seven synthetic development items
were unchanged. Native code evaluation still returns HTTP 412 because its dispatcher
is disabled, so overall runtime readiness remains false. The source archive is not
an executable native evaluator.

Focused asset-sync tests pass. A human-adjudicated holdout, Mastra comparison runner,
linked experiment traces/scores and runtime enforcement remain outstanding. No >90%
or >98% result is claimed. No application deployment or app core-pin update occurred.
