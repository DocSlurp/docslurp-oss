# Content-safety Langfuse integration verification

Verified 2026-10-20 MDT against the existing private Langfuse v4.59.0 host, using
an authorized temporary SSH tunnel. [Machine-readable readback](content-safety-langfuse-sync.json).

The candidate Mastra judge prompt, deterministic evaluator source archive, native
advisory LLM judge and seven synthetic development items were synchronized. A
repeat run verified unchanged prompt versions and judge ID, plus zero dataset
creates or updates. The source archive is not a native executable evaluator.

Two deployment prerequisites remain explicit:

- Native code evaluator creation returns HTTP 412: “Code evaluations are not
  enabled for this deployment.” No dispatcher was deployed or insecure execution
  enabled. Local deterministic scoring is tested; native execution is unavailable.
- The native advisory judge is paused with `LLM_CONNECTION_MISSING`. Automatic
  approval review rejected persisting the production OpenAI credential in Langfuse
  without specific authorization to transfer that secret. No credential was copied.

The stored advisory judge names `openai/gpt-4.1-mini` with verified published pricing
of $0.40 input and $1.60 output per million tokens on 2026-10-20. It is a configurable
starting candidate, not a measured quality/cost winner. No provider calls, scores,
experiments, automatic rules or production policy enforcement were created.

The seven cases are agent-authored development plumbing checks. A human-adjudicated
heldout dataset, Mastra comparison runner, linked experiment traces/scores and
runtime guardrail integration remain outstanding. No >90% or >98% result is claimed.

Validation: focused sync/scoring tests cover idempotency, version drift, duplicate
remote identities, normalized judge responses, paused readiness, disabled runtime,
credential-safe errors, unsafe model defaults, holdout review gates and abstentions.
The script suite is wired into `test:scripts`; no runtime dependencies were added.
