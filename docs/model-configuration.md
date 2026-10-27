# Model configuration

Hosted evaluation judges default to `z-ai/glm-5.3-flash` with low reasoning,
independently of the pipeline models below. Override `DOCSLURP_JUDGE_MODEL` and
`DOCSLURP_JUDGE_REASONING` for judge campaigns. The extraction judge verifies live
pricing, logs actual usage, and persists provider charges in its scoped SQLite
evidence store. See the judge calibration and adoption tickets.

Workspace pipeline settings own ingestion model choices. Configure them when
creating or updating a workspace through the API/SDK; runs snapshot those settings.
Workspace changes affect new runs, while existing runs retain their captured
workspace configuration. Inherited deployment defaults resolve when the worker
executes each task.

```json
{
  "pipeline": {
    "textGeneration": {
      "model": "provider/model-id",
      "models": {
        "document-summary": "provider/summary-model-id",
        "graph-extraction": "provider/graph-model-id"
      }
    }
  }
}
```

Text-generation tasks use OpenRouter model IDs. Supported task override keys are
`document-summary`, `proposition-extraction`, `structured-extraction`,
`graph-extraction`, `community-summary`, and `contextual-chunk-preamble`.

Resolution order is a task override, `textGeneration.model`, the worker's
`DOCSLURP_TEXT_MODEL`, then `DEFAULT_PIPELINE_TEXT_MODEL` in shared configuration.
Use `null` for the workspace default and omit task overrides to inherit deployment
settings. Blank IDs and unknown task keys are rejected. An explicit
`structuredExtraction.model` takes precedence for structured extraction; its
default is now `null`, so it inherits this same chain.

API search and helper calls use `DOCSLURP_SEARCH_MODEL`, falling back to the
workspace chat catalog's default. The environment override must be one of the
allowed workspace chat models. Explicit request model selections still win.

Vision uses `pipeline.vision.modelUri` and its configured fallback; embeddings
use `pipeline.embedding.modelUri`. Chat uses its existing model selector.
Catalog IDs and built-in defaults remain centralized configuration values;
individual text stages no longer choose a fixed model.

The default vision route is `llm://openrouter/deepseek/deepseek-v4.1-flash-1017`
(profile `good-fast-hosted`), tuned as described below. On the 2026-10-22 vision
holdout it was in the best quality tier, the fastest (p50 2.5 s) and cheaper per
page than the previous default, `google/gemini-3.1-flash-lite`, which stays in the
catalog. The default is one constant,
`DEFAULT_OPENROUTER_VISION_MODEL` in `packages/shared/src/embedding.ts`; the
profile label, description and default config are derived from its catalog entry.
NVIDIA Nemotron 3.5 Super VL is an opt-in hosted
route: set `pipeline.vision.modelUri` to
`llm://openrouter/nvidia/nemotron-3.5-super-vl` or `pipeline.vision.profile` to
`open-weights-hosted`. Its OpenRouter list price, verified on 2026-10-20, is
$0.15 per million input tokens and $0.50 per million output tokens (individual
OpenRouter providers range from $0.10 to $0.25 input and $0.40 to $1.25 output).
Page transcription sends it `reasoning: { enabled: false }`. The provider-reported
charge is recorded when present. Otherwise cataloged hosted vision models fall back
to their own list price instead of the generic `COST_PER_1K_*` rates.

### Tuned vision models

The default and these opt-in hosted models are in the vision catalog (OpenRouter list prices checked
2026-10-22) and can be selected per workspace with `pipeline.vision.modelUri`.
Per-model prompt, output cap, routing and reasoning settings live in
`worker/src/tools/vision-model-profiles.ts`; an explicit prompt other than
`<OCR>` is kept. Costs are per page.

| Model URI | List $/M in / out | Est. cost/page | Profile behaviour |
| --- | --- | --- | --- |
| `llm://openrouter/deepseek/deepseek-v4.1-flash-1017` (default) | 0.30 / 1.20 (US hosts) | 0.103 cents | Markdown + LaTeX prompt, 8,192 output cap, reasoning effort `none`. Together, Fireworks, Parasail (US), no other fallbacks, for every organization (DeepSeek's own China-hosted endpoint is cheaper but is not used: where page images go never depends on the account's balance) |
| `llm://openrouter/xiaomi/mimo-v2.6-flash` | 0.14 / 0.28 | 0.056 cents | Markdown transcription prompt, output cap ceiling 8,192, reasoning `none`, routed to Relace then DeepInfra with fallbacks, math delimiters normalized |
| `llm://openrouter/openai/gpt-6-luna` | 0.10 / 0.50 | 0.061 cents | Page Markdown + LaTeX prompt, image detail `high`, reasoning `none`, whole-page code fence removed, content-filter retry on Bedrock then Azure US |
| `llm://openrouter/z-ai/glm-5.3-flash` | 0.0113 / 0.1589 | 0.013 cents (computed from about 3,000 input and 560 output tokens) | Markdown transcription prompt, output cap ceiling 8,192, reasoning `minimal`, routed to Wafer, Friendli then InferenceNet with no other fallbacks, missing table delimiter rows repaired |

The first three per-page costs are measured; GLM's is computed from list price.
DeepSeek, MiMo and GLM weights are MIT; Luna is proprietary-hosted.

### Global default override and kill switch

`DOCSLURP_VISION_MODEL_URI` (for example
`llm://openrouter/google/gemini-3.1-flash-lite` to roll back to the previous default) replaces the built-in default
hosted vision model without a deploy of code. Set it on both the API/app and the
worker so the cost preview matches what the worker calls. It applies only to
pipelines whose vision config is still the default (profile `good-fast-hosted`
with its own model URI), is applied when a run or preview reads the pipeline,
and is never saved into workspace settings. So unsetting it restores the
built-in default for every workspace.

- Explicit `pipeline.vision.modelUri`, `model` or a non-default `profile` win.
  A stored config that is identical to the default cannot be told apart from
  an untouched workspace and follows the override.
- Pipelines with `privacyMode` other than `standard` are never changed.
- The value must be an `llm://` URI of a hosted model in the vision catalog, so
  spend is priced from list prices rather than the generic fallback. Anything
  else is logged once as an error (`[config] DOCSLURP_VISION_MODEL_URI=... ignored`)
  and ignored.

Text generation also accepts an optional `profile`, a common `reasoningEffort`,
per-task `reasoningEfforts`, and per-task `maxOutputTokens`. For the calibrated
GLM configuration:

```json
{
  "textGeneration": {
    "model": "z-ai/glm-5.3-flash",
    "profile": "grounded-low"
  }
}
```

`grounded-low` adds a general source-faithfulness instruction, requests low
reasoning, and uses 128 tokens for contextual preambles and 256 for community
summaries. It asks for a short complete preamble and one concise community
paragraph. Other task limits retain their existing stage settings. This is a
prompt policy, not a guarantee against unsupported claims; see the
GLM calibration report.

Haiku 5.5 also has a tested worker configuration:

```json
{
  "textGeneration": {
    "model": "anthropic/claude-haiku-5.5",
    "profile": "grounded-low",
    "reasoningEffort": "low"
  }
}
```

It is available in workspace chat/search model selection. The worker profile is
configured separately. The seven-model calibration report
compares required-fact recovery, complete-generation latency, actual provider
charges and unavailable-charge bounds. Haiku's four filtered empty responses
remain in those results; the profile does not guarantee provider reliability.

Set `DOCSLURP_TEXT_PROFILE=grounded-low` to inherit the profile across a deployment.
A workspace `profile` overrides the environment; `provider-default` preserves
the provider's reasoning defaults and the existing prompts/limits. A missing or
null profile inherits the deployment. Task reasoning overrides beat the common
reasoning setting, which beats the profile. Explicit task token limits beat the
profile limits and then the existing stage limit, including
`structuredExtraction.maxOutputTokens`. Token overrides must be integers from
1 through 16,384. Providers must support the selected reasoning effort; unsupported
settings are not silently replaced. Invalid deployment profile names fail startup.

For hosted models that support disabling thinking, `reasoningEffort: "none"`
keeps the selected prompt profile and sends OpenRouter's explicit
`reasoning.enabled: false` control. It does not send an effort named `none` to
Claude or Qwen, which expose thinking as a separate toggle. Models with mandatory
reasoning cannot use this setting. The comparison runner checks the live catalog
for both supported efforts and the ability to disable thinking before inference.

Interrupted text comparisons can resume with `--resume /path/to/run-evidence`.
The runner requires identical dataset bytes and experiment settings and preserves
attempted failures. It stops on unknown charges by default. Explicit
`--reserve-unknown-costs` continuation reserves the maximum estimated charge for
each unresolved attempt, including retries, against the same phase budget.
Reports must retain the unresolved charges and distinguish provider charges
from the usage ledger's customer billing markup.

The profile is optional and does not select a model. Workspace model overrides
and `DOCSLURP_TEXT_MODEL` still resolve independently. Generation metadata records
the effective profile, reasoning effort, and token limit for every worker text
task. Community summaries receive actual subject/predicate/object graph links
with weights, rather than predicates alone.

Generation spans, console usage logs, and usage-ledger records identify the
resolved model. GraphRAG uses the configured OpenRouter API key for its OpenRouter
calls. These settings do not change the provider adapter or credential type.

Local tooling defaults can be overridden with `DOCSLURP_LOCAL_OCR_MODEL` and
`DOCSLURP_CLIP_MODEL`. The command runner passes an explicit model to the Florence
and CLIP scripts; embedding pool requests must also name a model instead of
silently selecting one. Workspace vision selections take precedence over tooling
defaults for actual extraction.

## Non-free software opt-out

`DISABLE_NON_FREE_SOFTWARE` (worker, default `false`) removes every model or engine whose licence class is `non-free`
(custom addenda, non-commercial, research-only, undeclared) from the page router: target and decision-model catalogs,
the decision chain, executors and the Extract flat-tier OCR routes. It does not touch proprietary hosted APIs; those
stay under the privacy modes below. Classes, sources and the full table are in `docs/page-router.md` ("Licence classes").

## Hosted provider routing

OpenRouter serves many open-weight models from several hosts, at different
prices. DocSlurp adds routing preferences to each OpenRouter request:

- **Cheapest host first for GLM and DeepSeek.** Requests for `z-ai/glm-*` and
  `deepseek/deepseek-*` sort hosts by price (`provider.sort: "price"`) and only
  use hosts that serve FP8 or better weights. Fallbacks stay on. Keeping the same
  cheap host across chat steps also keeps prompt-cache reads working.
- **China-based providers, per organization.** These are on by default. Owners
  and admins can turn them off for the whole organization with
  `PATCH /v1/organizations/:orgId { "allowChinaProviders": false }`, or with the
  toggle in organization settings. When off, every OpenRouter request made for
  the organization excludes the China-based hosts. This covers chat, search
  helpers, ingestion text and vision, and embeddings. Hosted open models such as
  DeepSeek and GLM often cost about half as much on these hosts as on US-hosted
  ones, so turning them off can raise model costs. The setting picks hosts; it
  does not block models built by Chinese labs, which also run on hosts elsewhere.
  The current host list is `CHINA_PROVIDER_SLUGS` in
  `packages/shared/src/openrouter-routing.ts`: Alibaba, Baidu, DeepSeek, MiniMax,
  Moonshot AI, Nex AGI, SiliconFlow, StepFun, StreamLake, Tencent, Xiaomi and
  Z.AI.

A request knows its organization from its API key or from the workspace it
uses. A signed-in request without either applies the restriction when any of
the user's organizations has it on. Changes apply within 30 seconds.

## Privacy modes

`pipeline.privacyMode` controls whether workspace content may reach a hosted AI
provider. The rules live in `packages/shared/src/privacy.ts`.

| Mode | Hosted LLM, vision, embedding and speech-to-text calls | Audit |
| --- | --- | --- |
| `standard` (default) | Allowed | None |
| `local-only` | Blocked | Console line `[privacy] blocked ...` |
| `strict-privacy` | Blocked | Console line plus one `privacy_audit_log` row per blocked attempt |

"Hosted" means any provider other than the local runtimes `transformers.js`,
`onnx`, `huggingface`, `local-cli` (Florence), loopback `ollama`, `vllm` or
`lmstudio`, and operator-registered [private model endpoints](#private-model-endpoints).
An unknown provider or an unknown mode is treated as hosted or blocked. DocSlurp
has no zero-data-retention provider tier, so `strict-privacy` allows no hosted
calls that `local-only` blocks.

Enforcement happens in two places. Every hosted client (worker OpenRouter and
Anthropic text, the vision runtime and its remote fallback, embeddings, the API's
OpenRouter helpers, query embeddings, the chat MCP agent, and voice
transcription) takes the workspace mode and throws `PrivacyModeViolationError`
before any request leaves the process. Callers also check the mode first, so
features handle a block in a predictable way:

- **Skipped:** document summaries, propositions, structured extraction, vision
  fallback, extraction self-critique, and the API's search strategies (HyDE,
  rewrite, stepback, self-query, compression, multi-hop bridging).
- **Local fallback:** graph extraction and community summaries use their
  heuristics. Contextual chunk preambles use the heuristic preamble. Chat
  returns the retrieval fallback with a warning.
- **Refused:** embeddings have no substitute. The pipeline schema rejects a
  hosted embedding profile, or a hosted `vision.remoteFallbackModelUri`, outside
  `standard`. Voice transcription returns HTTP 403.

Answers that combine several workspaces use the strictest mode among them. Chat
MCP tools refuse to fetch another workspace's content when that workspace forbids
hosted models. In `privacy_audit_log`, `endpoint` is `blocked:<operation>`, for
example `blocked:worker.text.document-summary`, and `model_id` is
`<provider>/<model>`. The `legal-contracts` and `medical-records` templates use
`strict-privacy` with local embedding and vision profiles. They turn off
summaries and propositions, because those stages need a hosted text model.

## Private model endpoints

Private endpoints let `local-only` and `strict-privacy` workspaces use
open-weight models that the operator runs on single-tenant hardware, such as
vLLM on a rented GPU. Only operators can declare them, through deployment
config. Workspaces and API callers can only name a registered alias. The
registry lives in `packages/shared/src/private-endpoints.ts`.

Set `DOCSLURP_PRIVATE_MODEL_ENDPOINTS` on both the worker and the app. Its
value is a JSON array:

```json
[
  {
    "alias": "gpu1",
    "baseUrl": "https://gpu1.example.com/v1",
    "auth": { "header": "Authorization", "scheme": "Bearer", "tokenEnv": "DOCSLURP_PRIVATE_GPU1_TOKEN" },
    "models": [
      { "id": "Qwen/Qwen3.6-35B-A3B-FP8", "capability": "text", "chatTemplateKwargs": { "enable_thinking": false } },
      { "id": "lightonai/LightOnOCR-3-0.8B", "capability": "vision" },
      { "id": "Qwen/Qwen3-Embedding-0.6B", "capability": "embedding", "dimensions": 1024 },
      { "id": "CohereLabs/cohere-transcribe-03-2026", "capability": "stt" }
    ],
    "attestation": { "tenancy": "single-tenant", "hostProvider": "runpod", "region": "us-east", "note": "pilot" },
    "pricing": { "usdPerHour": 1.99, "concurrency": 8 }
  }
]
```

The worker and the app validate the registry when they start. An invalid
registry stops startup, and every private route fails closed until it is fixed.
The rules are:

- `alias`: lowercase letters, digits and dashes. Each alias must be unique.
- `baseUrl`: the OpenAI-compatible root, usually ending in `/v1`. It must use
  `https`. Plain `http` is accepted only for hosts on a private network:
  loopback, RFC 1918, `100.64.0.0/10` (Tailscale/CGNAT), `fc00::/7`, and names
  ending in `.internal`, `.local` or `.ts.net`. Credentials, query strings and
  fragments are rejected.
- `auth.tokenEnv`: the name of the environment variable that holds the token.
  Tokens are never written inline. `header` defaults to `Authorization` and
  `scheme` defaults to `Bearer`. A token variable that is unset gets a warning
  at startup, and calls to that endpoint fail.
- `models`: each `id` is the exact id the server serves, and each `capability`
  is one of `text`, `vision`, `embedding`, `rerank` or `stt`. Embedding models
  must declare `dimensions`. To serve one id for two capabilities, list it twice.
- `chatTemplateKwargs` (optional, per model): sent as `chat_template_kwargs` on
  every chat/completions request to that model. Qwen3-family models on vLLM
  reason by default and can spend a stage's whole output budget on reasoning,
  which returns empty summaries. Set `{ "enable_thinking": false }` for them, or
  start vLLM with `--default-chat-template-kwargs '{"enable_thinking":false}'`.
- `attestation`: `tenancy` must be `"single-tenant"`. `hostProvider` and
  `region` are required, and `note` is optional. These values appear in usage
  metadata.
- `pricing` (optional, per endpoint or per model): `usdPerMTokInput` and
  `usdPerMTokOutput` take precedence. Otherwise each call is charged its request
  wall time × `usdPerHour` ÷ `concurrency` (default 1). Without pricing, usage is
  recorded at 0 with `costSource: "private-endpoint-unpriced"`. When several
  entries (separate vLLM ports) share one GPU host, split the host's hourly
  price across them, or raise `concurrency`. Each entry is charged its own
  `usdPerHour`, so giving every entry the full host price overstates cost.

### Routing

A workspace refers to a private model as `llm://private/<alias>/<model-id>`.
The model id can contain `/`. Private routes take no `?baseUrl=` parameter,
because the registry supplies the URL and credentials.

```json
{
  "pipeline": {
    "privacyMode": "strict-privacy",
    "embedding": { "modelUri": "llm://private/gpu1/Qwen/Qwen3-Embedding-0.6B" },
    "vision": { "modelUri": "llm://private/gpu1/lightonai/LightOnOCR-3-0.8B", "prompt": "markdown" },
    "textGeneration": { "model": "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8" }
  }
}
```

The embedding and vision `target` is inferred as `private`. `textGeneration.model`
and its per-task overrides accept either an OpenRouter id or a private route.
Strict-privacy templates keep their local defaults. Point a template's
workspace at private profiles by overriding these fields. Summaries and
propositions can then be turned back on.

| Surface | Endpoint path | Notes |
| --- | --- | --- |
| Worker text stages (summary, propositions, structured extraction, graph, community summaries, chunk preambles) | `/chat/completions` | Structured extraction also sends `response_format: json_schema` built from the workspace schema, to private endpoints only. |
| Worker page vision and self-critique | `/chat/completions` with an image | |
| Worker and API embeddings (including query embeddings) | `/embeddings` | Dimensions come from the registry. |
| API grounded chat answers | `/chat/completions` (streamed) | Used when hosted chat is blocked. The workspace's `textGeneration.model` is tried first, then `DOCSLURP_PRIVATE_TEXT_MODEL`. |
| API voice input | `/audio/transcriptions` (multipart) | Used outside `standard` when `DOCSLURP_PRIVATE_STT_MODEL` names a registered `stt` model. |

Not routed yet: the API's optional search strategies, the chat MCP agent, and
reranking. They behave as they did before private routes existed (see TODO.md).
Standard workspaces keep their hosted routes, but they can also name a private
route explicitly.

### Privacy and audit

Every outbound request passes through `authorizePrivateModelCall`, which does
the following:

1. Resolves the alias, model and capability in the registry. Under a privacy
   mode, an unregistered alias, an unlisted model, a wrong capability, or a URL
   that differs from the registry throws `PrivacyModeViolationError`.
2. Reads the token and binds a `fetch` that adds the operator auth header and
   refuses any URL outside the registered base URL.
3. Under `strict-privacy`, writes one `privacy_audit_log` row *before* the
   request is sent: `model_id = private/<alias>/<model>`,
   `endpoint = private:<alias>:<operation>` (for example
   `private:gpu1:worker.embedding`), plus the workspace, run and document. If
   the row cannot be written, or there is no workspace scope, the call is
   refused. Worker runs, page tasks and graph jobs set the scope. API calls pass
   the workspace explicitly.
4. Logs `[privacy] private-call operation=… alias=… model=… privacy_mode=… workspace=…`.

`local-only` allows the same calls and writes no audit rows. Blocked hosted
calls keep the `blocked:<operation>` rows described above.

### Usage and health

Usage events record `provider = private` and `model = <alias>/<model-id>`,
with the token counts the response reports. Their metadata carries
`endpointAlias`, `endpointHost`, `endpointRegion`, `tenancy` and the cost
source. At startup, the worker and the app each call `GET <baseUrl>/models`
once per endpoint and log one line, for example
`[private-endpoints] probe alias=gpu1 ok=false served=… missing=…`. The probe
never blocks boot.

## Anthropic models

Only the Claude 5.5 generation is supported: `claude-opus-5-5` ($4/$20 per MTok), `claude-sonnet-5-5` ($2/$10) and `claude-haiku-5-5` ($0.10/$0.50, $0.50/$2.50 above 100K prompt tokens), or their OpenRouter ids `anthropic/claude-*-5.5`. The registry lives in `packages/shared/src/anthropic-models.ts`.

Every older Claude id (Haiku 4.5, Sonnet 4.x/5, Opus 4.x/5, Fable 5/5.1, Claude 3.x) is deprecated. Stored settings and API callers that still name one keep working: `resolveSupportedModelId` swaps in the same family's 5.5 model at call time (Fable and Mythos map to Opus 5.5) and logs `[ai-models] deprecated model=… replaced_by=…` once per process. Price entries for deprecated ids remain only to reprice historical usage. the internal pricing validation fails if a default or selectable route names a deprecated Claude model.

### Hosted Perplexity embeddings through OpenRouter

New workspaces default to `llm://openrouter/perplexity/pplx-embed-v1-0.6b`
(native 1024 dimensions). Workspaces can also select `llm://openrouter/perplexity/pplx-embed-v1-4b`
(native 2560 dimensions). Set the embedding target to `hosted`; both ingestion
and search use `OPENROUTER_API_KEY` and the fixed official OpenRouter endpoint.
For example, use this embedding configuration in the workspace pipeline:

```json
{
  "profile": "cheapest-hosted",
  "target": "hosted",
  "modelUri": "llm://openrouter/perplexity/pplx-embed-v1-0.6b",
  "task": "document",
  "normalize": true
}
```

These routes preserve the native embedding width and require actual token usage.
The worker splits requests by input count and a conservative UTF-8 token upper
bound so the provider's 120,000-token aggregate request limit cannot drop content.
They do not support dimension overrides. Reindex existing documents when changing
embedding models so document and query vectors use the same space. Provider errors
remain errors rather than silently switching retrieval to keywords. Existing
explicit workspace model URIs remain selected. The `cheapest-hosted` profile
and the default embedding configuration now select Perplexity 0.6B. Self-hosted
operators need `OPENROUTER_API_KEY` for this default or must explicitly choose a
local/private embedding route.

Verified OpenRouter list prices on 2026-10-17 are $0.004 and $0.03 per million
input tokens respectively, before DocSlurp's applicable AI markup. The shared
usage catalog prices both routes and the existing usage ledger persists calls.
See the [OpenRouter model catalog](https://openrouter.ai/api/v1/embeddings/models)
for current prices and the [Perplexity embedding paper](https://arxiv.org/abs/2602.11151)
for model details. These prices are not ingestion-throughput guarantees.


### Native Perplexity embedding endpoint

To use Perplexity directly, set `PERPLEXITY_API_KEY` in both the server and worker
(the legacy `PERPLEXITYAI_API_KEY` is accepted) and explicitly select
`llm://perplexity/pplx-embed-v1-0.6b` or `llm://perplexity/pplx-embed-v1-4b`
with embedding target `hosted`. The default remains the OpenRouter route above.

Document and query calls use the fixed `https://api.perplexity.ai/v1/embeddings`
endpoint. The adapter decodes signed INT8 responses into normalized vectors,
requires actual token usage, and records usage before validating paid responses.
Native widths are 1024 and 2560 respectively; dimension overrides are rejected.
Changing the workspace route requires reindexing, including when switching between
native Perplexity and OpenRouter. Privacy mode still rejects remote requests.

Requests are packed to at most 128 inputs and a conservative 120,000-token upper
bound without truncating inputs. Existing spend checks, provider admission limits,
retry handling and usage attribution apply. Verified native input prices on
2026-10-17 are $0.004 and $0.03 per million tokens, before applicable markup.
See the [native embedding documentation](https://docs.perplexity.ai/docs/embeddings/quickstart)
and [rate limits](https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers).
Embedding API burst throughput does not establish full ingestion throughput.
