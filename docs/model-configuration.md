# Model configuration

Hosted evaluation judges default to `z-ai/glm-5.3-flash` with low reasoning,
independently of the pipeline models below. Override `DOCSLURP_JUDGE_MODEL` and
`DOCSLURP_JUDGE_REASONING` for judge campaigns. The extraction judge verifies live
pricing, logs actual usage, and persists provider charges in its scoped SQLite
evidence store. See the judge calibration and adoption tickets.

## Model URIs (llm://)

Every managed setting that names a model takes an `llm://` model URI:

```text
llm://<provider>/<model-id>
```

| Form | Meaning | Example |
| --- | --- | --- |
| `llm://openrouter/<vendor>/<model>` | A hosted model routed through OpenRouter. Variant suffixes such as `:nitro` stay on the model id. | `llm://openrouter/anthropic/claude-haiku-5.5` |
| `llm://private/<alias>/<model>` | A model on an operator-registered private endpoint ([Private model endpoints](#private-model-endpoints)). Takes no query string; the registry supplies the URL and credentials. | `llm://private/gpu1/Qwen/Qwen3-Embedding-0.6B` |
| `llm://perplexity/<model>`, `llm://openai/<model>` | A native provider route, for the stages that support it (embeddings). | `llm://perplexity/pplx-embed-v1-0.6b` |
| `llm://transformers.js/<model>`, `llm://local-cli/<model>`, `llm://vllm/<model>` | A model running in-process, as a local command or on a loopback server (self-hosted deployments). | `llm://transformers.js/Xenova/bge-m3` |
| `<vendor>/<model>` | Shorthand for `llm://openrouter/<vendor>/<model>`, accepted wherever a hosted model is. | `anthropic/claude-haiku-5.5` |

## Managed models: callers choose categories

Programmatic callers (REST, OpenAI-compatible chat, MCP, SDK, CLI) never choose a backend model or provider. They choose DocSlurp categories:

| Surface | Category |
| --- | --- |
| Chat (`/v1/chat`, `/v1/chat/stream`, chat operations, MCP `chat`, `docslurp.tier` on `/v1/chat/completions`) | `tier`: `fastest`, `balanced`, `smart`; `reasoning`: `none` to `high` |
| Ingestion (`pipeline` on project create/update, uploads, extracts) | `quality` (`fast`, `auto`, `good`), `embedding.profile`, `vision.profile`, `inferenceLane` |
| Search settings | `retrievalDefaults.reranker`: `keyword` or `model` |

A request that names a backend model, provider or route (`model`, `docslurp.model`, `pipeline.textGeneration.model(s)`, `pipeline.structuredExtraction.model`, `pipeline.embedding.modelUri`/`target`, `pipeline.vision.modelUri`/`target`/`remoteFallbackModelUri`, a non-`auto` `pipeline.visualPages.route`, `retrievalDefaults.rerankProvider`/`rerankModel`) gets HTTP 400 `model_not_allowed` naming the fields and the categories to use. The refused value is logged, never echoed. A model URI equal to what the section's profile already implies (a pipeline read back and saved) is not a choice and passes. Project, pipeline and search-settings responses omit these fields; chat responses report the tier. Usage events (`usage_events`), traces and the `[ai-usage] ... model=<id>` logs keep the concrete model and provider.

The concrete models are managed settings:

- **Deployment defaults:** `CHAT_TIER_MODELS` in `packages/shared/src/project-chat-models.ts` (tier → reviewed catalog model, priced under the $50 per 1M output-token cap, never Pro/Ultra), the embedding and vision profile catalogs, and the environment variables below.
- **Per project (platform admins only):** `projects.managed_models` holds the only explicit choices, written only by `PUT /v1/admin/projects/:projectId/managed-models` (read with `GET` on the same path). Callers: a platform-admin browser session (`ADMIN_EMAILS`), or, for scripted and self-hosted setups, a server API key owned by a platform admin that carries the dedicated `admin:models` scope (client keys, OAuth tokens and keys without the scope are refused). Body: `{"chat": {"<tier>": "<catalog id>" | null}, "pipeline": {"textGeneration": {"model", "models"}, "structuredExtraction": {"model"}, "vision": {"modelUri", "remoteFallbackModelUri"}, "embedding": {"modelUri"}, "pageRouter": {"decisionModel"}} | null}`; `pipeline` replaces the overrides, `null` clears them. Every model must be outside the automatic-selection denylist, not Pro/Ultra and under the output-price cap; a hosted vision or embedding model must be a reviewed catalog entry and any other hosted model needs a verified price; operator `llm://private/...` routes are allowed. An override that conflicts with the project's pipeline (a hosted fallback under `local-only`, say) is refused. An embedding model change is refused once the project has documents; change the profile and re-index instead. Each change writes an `audit_log` row (`project.managed_models.updated`) with the before and after values. Clones copy the source's managed models.
- **Everything else is a default:** any model value stored in a project pipeline, a run snapshot or a version snapshot that is not an explicit override is dropped when it is read, saved, rolled back or reprocessed, so the current profile and deployment defaults apply, including after a default changes. Migration 0158 moved operator private routes and index-bound embedding URIs into explicit overrides and removed the rest.
- **At call time:** every text, structured-extraction and vision call in a run is checked again: an automatic-selection-denied, Pro/Ultra or over-cap model is refused and the stage fails loudly, whatever wrote the configuration.
- **Operator evaluations:** see [chat tiers](search-api.md#tier) for `DOCSLURP_CHAT_EVAL_MODELS` and `DOCSLURP_CHAT_EVAL_ORG_IDS`.

Where the managed and deployment settings accept URIs:

| Setting | Accepts | Notes |
| --- | --- | --- |
| Admin `chat.<tier>`; operator-eval `model` on chat requests | The bare OpenRouter id from the chat catalog (eval requests also take `llm://openrouter/...` with `?reasoning=`) | Customers get 400 `model_not_allowed`. |
| Admin `pipeline.textGeneration.model`, `.models.<task>`, `pipeline.structuredExtraction.model` | `llm://openrouter/...`, the bare id, or `llm://private/...` | Hosted URIs are stored as the bare OpenRouter id. |
| Admin `pipeline.vision.modelUri`, `.remoteFallbackModelUri` | An `llm://` URI from the vision catalog, or `llm://private/...` | Bare ids are not accepted. |
| Admin `pipeline.embedding.modelUri` | An `llm://` URI from the embedding catalog, or `llm://private/...` | Projects without documents only. |
| `DOCSLURP_SEARCH_MODEL`, `DOCSLURP_CHAT_EVAL_MODELS`, `CHAT_INSTRUCTIONS_IMPROVE_MODEL` | `llm://openrouter/...` or the bare id | |
| `DOCSLURP_TEXT_MODEL` | `llm://openrouter/...`, the bare id, or `llm://private/...` | The deployment default for text stages. |
| `DOCSLURP_VISION_MODEL_URI` | An `llm://` URI from the vision catalog | |
| `MEDIA_TRANSCRIPTION_MODEL` | `llm://<provider>/<model>` (e.g. `llm://deepinfra/openai/whisper-large-v3-turbo`) or the provider's model id | The URI's provider stands in for `MEDIA_PROVIDER`; a conflicting `MEDIA_PROVIDER` fails startup. |

Model URIs never carry credentials: a URI with a user name or password is
rejected.

Project pipeline settings own ingestion choices. Customers configure the
categories through the API/SDK; platform admins set the managed model fields
through the admin route above. Runs snapshot those settings.
Project changes affect new runs, while existing runs retain their captured
project configuration. Inherited deployment defaults resolve when the worker
executes each task.

```json
{
  "pipeline": {
    "textGeneration": {
      "model": "llm://openrouter/qwen/qwen3.5-flash-02-23",
      "models": {
        "document-summary": "llm://openrouter/z-ai/glm-5.3-flash",
        "graph-extraction": "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8"
      }
    }
  }
}
```

Text-generation tasks take `llm://openrouter/<vendor>/<model>` (or the bare
OpenRouter id) or `llm://private/<alias>/<model>`. Supported task override keys are
`document-summary`, `proposition-extraction`, `structured-extraction`,
`graph-extraction`, `community-summary`, and `contextual-chunk-preamble`.

Resolution order is a task override, `textGeneration.model`, the worker's
`DOCSLURP_TEXT_MODEL`, then `DEFAULT_PIPELINE_TEXT_MODEL` in shared configuration.
Use `null` for the project default and omit task overrides to inherit deployment
settings. Blank IDs and unknown task keys are rejected. An explicit
`structuredExtraction.model` takes precedence for structured extraction; its
default is now `null`, so it inherits this same chain.

API search and helper calls use `DOCSLURP_SEARCH_MODEL`, falling back to the
project chat catalog's default. The environment override must be one of the
allowed project chat models (bare id or `llm://openrouter/<id>`). A chat
request's tier picks the answering model.

Vision uses `pipeline.vision.modelUri` and its configured fallback; embeddings
use `pipeline.embedding.modelUri` (both managed settings). Chat uses the tier.
Catalog IDs and built-in defaults remain centralized configuration values;
individual text stages no longer choose a fixed model.

The default vision route is `llm://openrouter/openai/gpt-6-luna` (profile
`good-fast-hosted`, since 2026-11-13), tuned as described below. DeepSeek V4.1 Flash
is no longer the default; it stays in the catalog as an explicit choice, and automatic
calls on it pass the margin gate ([below](#automatic-calls-and-the-margin-gate)). On the 2026-10-22
vision holdout Luna had no significant deficit against DeepSeek V4.1 Flash 1017 on
content, reading order or math (math 0.994 against 0.982), a significant tolerant-table
deficit (-0.032), and a p50 of 8.1 s against 2.5 s. It is the cheapest allowed catalog
model per page at its most expensive host. The default is one constant,
`DEFAULT_OPENROUTER_VISION_MODEL` in `packages/shared/src/embedding.ts`; the
profile label, description and default config are derived from its catalog entry.
NVIDIA Nemotron 3.5 Super VL (`llm://openrouter/nvidia/nemotron-3.5-super-vl`) and MiMo V2.6 Flash are
in the catalog but refused: their per-image token maximum is a processor maximum, not a proven serving
maximum, so the vision guard cannot weigh their requests. Config validation and the runtime reject both
until serving-level evidence exists (`refusedReason` in `packages/shared/src/embedding.ts`). The
`open-weights-hosted` profile, formerly Nemotron, sends GLM 5.3 Flash (MIT weights,
`OPEN_WEIGHTS_OPENROUTER_VISION_MODEL`).
The provider-reported
charge is recorded when present. Otherwise cataloged hosted vision models fall back
to their own list price instead of the generic `COST_PER_1K_*` rates.

### Tuned vision models

The default and these opt-in hosted models are in the vision catalog (OpenRouter list prices checked
2026-10-22) and can be selected per project with `pipeline.vision.modelUri`.
Per-model prompt, output cap, routing and reasoning settings live in
`worker/src/tools/vision-model-profiles.ts`; an explicit prompt other than
`<OCR>` is kept. Costs are per page.

| Model URI | List $/M in / out | Est. cost/page | Profile behaviour |
| --- | --- | --- | --- |
| `llm://openrouter/deepseek/deepseek-v4.1-flash-1017` (explicit choice only) | 0.30 / 1.20 (route ceiling) | 0.103 cents (US route) | Markdown + LaTeX prompt, 8,192 output cap, reasoning effort `none`. Only Fireworks and Parasail (US), lowest latency first (Together omitted: it fabricated page bodies on 2026-11-12); new hosts stay gated pending disclosure and rollout ([provider regions](provider-regions.md)) |
| `llm://openrouter/xiaomi/mimo-v2.6-flash` (refused, see above) | 0.14 / 0.28 | 0.056 cents | Markdown transcription prompt, output cap ceiling 8,192, reasoning `none`, routed to Relace then DeepInfra with fallbacks, math delimiters normalized |
| `llm://openrouter/openai/gpt-6-luna` (default) | 0.11 / 0.55 (route ceiling) | 0.061 cents | Page Markdown + LaTeX prompt, image detail `high`, reasoning `none`, output cap ceiling 8,192, whole-page code fence removed. Routed to OpenAI (never its Flex tier), with Amazon Bedrock us-east-1 and Azure US as fallbacks and as the content-filter retry route; priced at those hosts' $0.11/$0.55 so `max_price` admits them |
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
and is never saved into project settings. So unsetting it restores the
built-in default for every project.

- Explicit `pipeline.vision.modelUri`, `model` or a non-default `profile` win.
  A stored config that is identical to the default cannot be told apart from
  an untouched project and follows the override.
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

It is available in project chat/search model selection. The worker profile is
configured separately. The seven-model calibration report
compares required-fact recovery, complete-generation latency, actual provider
charges and unavailable-charge bounds. Haiku's four filtered empty responses
remain in those results; the profile does not guarantee provider reliability.

Set `DOCSLURP_TEXT_PROFILE=grounded-low` to inherit the profile across a deployment.
A project `profile` overrides the environment; `provider-default` preserves
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

The profile is optional and does not select a model. Project model overrides
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
silently selecting one. Project vision selections take precedence over tooling
defaults for actual extraction.

## Non-free software opt-out

`DISABLE_NON_FREE_SOFTWARE` (worker, default `false`) removes every model or engine whose licence class is `non-free`
(custom addenda, non-commercial, research-only, undeclared) from the page router: target and decision-model catalogs,
the decision chain, executors and the Extract flat-tier OCR routes. It does not touch proprietary hosted APIs; those
stay under the privacy modes below. Classes, sources and the full table are in `docs/page-router.md` ("Licence classes").

## Automatic calls and the margin gate

A call the system makes on its own choice (a vision fallback, OCR escalation, a chart generator, a page-router target, a
route-tier pick, a chat failover or a Speed boost swap) is margin-checked at the moment it would be made
(`packages/shared/src/automatic-call-margin.ts`):

- **Worst-case cost:** the call kind's planning tokens (page transcription 1,500 in / 800 out, chart read 3,300 / 1,400,
  chat answer 8,000 / 600) times the highest price the route can reach now: each OpenRouter endpoint the route allows,
  at its listed time-of-day price, from OpenRouter's public per-endpoint listing, read at most
  `DOCSLURP_AUTOMATIC_PRICE_MAX_AGE_MINUTES` (default 60) ago. A request's enforced `max_price` bounds it (OpenRouter
  never routes above it). Verified host schedules are a floor: DeepSeek's own endpoint is priced at $0.30 / $1.20 per
  1M tokens at peak (01:00-04:00 and 06:00-10:00 UTC, Monday to Friday) and $0.15 / $0.60 otherwise
  ([DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing), checked 2026-11-15; Chinese public holidays,
  which DeepSeek prices off-peak, are treated as peak).
- **Billed value:** what the call bills, from the pricing provider (`automaticCallValueUsd`). The open default bills
  nothing per call and checks nothing. Where pricing is required, a provider without the hook does not install
  (startup fails) and a null answer refuses the call.
- **Rule:** allowed when billed value / worst-case cost is at least `DOCSLURP_AUTOMATIC_MIN_MARGIN` (default 1.3). A
  refused candidate is skipped (`[automatic-margin] skipped ... reason=...`) and the next one is tried. An unknown or
  stale price, or a deployment that must price but whose provider states no value, refuses the call (fail closed).
  Operator private routes (`llm://private/...`) are the operator's own cost and are not checked.
- **Inputs priced:** input at the higher of the prompt and prompt-cache write rate, output at the higher of completion
  and reasoning, plus any listed per-request and per-image fee. A vision call plans at least the model's own image
  tokens for a Letter page at 200 dpi plus its instructions; a chat failover at least the turn's own prompt size and
  output cap. A listing that cannot be read completely (an unknown fee or override condition, a missing host) is not
  used.
- **Billed value:** the provider is told why the call is made (`role`: `fallback`, `escalation`, `failover` or
  `pick`), so a retry of a unit already charged can be valued at what it adds.
- **After the call:** the provider-reported cost is compared with the estimate; a vision fallback, OCR escalation or
  chat failover that cost more than it billed logs `[automatic-margin] overrun ... loss=true`.
- **Price refresher:** the worker, API and chat executor read listings every 15 minutes, only with `OPENROUTER_API_KEY`
  set and `LIVE_MODEL_PRICES` not `off`. Without it, vision calls are priced at their `max_price` cap, and chat
  failover (which sends no cap) is refused.

A model the caller or an operator names explicitly (a project's chat or vision model, a platform admin's tier mapping,
`DOCSLURP_VISION_MODEL_URI`) is not margin-checked; it keeps the call-time policy (no Pro/Ultra, no output price at or
above $50 per 1M tokens).

`NO_AUTOMATIC_SELECTION_MODEL_FAMILIES` (`packages/shared/src/automatic-model-selection.ts`) remains for a model that
must never be picked automatically at any price; it is empty. DeepSeek V4.1 Flash was on it from 2026-11-13 to
2026-11-15. A listed family is matched across builds, variants, provider suffixes and spellings; provider aliases that do
not name the family (for example `deepseek/deepseek-chat`) are not caught.

Chat failover: a failed answer retries once, on the first of GPT-6 Luna, Claude Haiku 5.5 and GLM 5.3 Flash that is not
the project's own model (`PROJECT_CHAT_FAILOVER_MODELS`) and keeps the margin at that moment; a candidate that does not
is skipped for the next.
Speed boost and evaluation turns do not fail over.

## Hosted provider routing

OpenRouter serves many open-weight models from several hosts, at different
prices. DocSlurp adds routing preferences to each OpenRouter request:

- **Cheapest host first for GLM and DeepSeek.** Requests for `z-ai/glm-*` and
  `deepseek/deepseek-*` sort hosts by price (`provider.sort: "price"`) and only
  use hosts that serve FP8 or better weights. Fallbacks stay on. Keeping the same
  cheap host across chat steps also keeps prompt-cache reads working.
- **China-based providers, per organization and project.** These are on by
  default. Owners and admins can turn them off for the organization with
  `PATCH /v1/organizations/:orgId { "allowChinaProviders": false }`, and a
  project can turn them off for itself with
  `PATCH /v1/projects/:project { "allowChinaProviders": false }` (it can
  narrow, never widen, its organization). When off, every request carries an
  allowlist of providers with a known non-China headquarters (`provider.only`)
  plus the China-based ones on `provider.ignore`, on every path and every retry;
  providers of unknown region are excluded and a request with no allowed
  provider is refused. Unknown scope fails closed. The region table, its sources,
  the measured vision route and the costs are in
  [provider regions](provider-regions.md).

A request knows its organization from its API key or from the project it
uses, and its projects from the privacy check every hosted call makes. A
signed-in request without either applies the restriction when any of the
user's organizations has it on. Changes apply within 30 seconds.

## Privacy modes

`pipeline.privacyMode` controls whether project content may reach a hosted AI
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
transcription) takes the project mode and throws `PrivacyModeViolationError`
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

Answers that combine several projects use the strictest mode among them. Chat
MCP tools refuse to fetch another project's content when that project forbids
hosted models. In `privacy_audit_log`, `endpoint` is `blocked:<operation>`, for
example `blocked:worker.text.document-summary`, and `model_id` is
`<provider>/<model>`. The `legal-contracts` and `medical-records` templates use
`strict-privacy` with local embedding and vision profiles. They turn off
summaries and propositions, because those stages need a hosted text model.

## Private model endpoints

Private endpoints let `local-only` and `strict-privacy` projects (or, in
[private model mode](#private-model-mode-and-the-service-map), every project)
use open-weight models that the operator runs on single-tenant hardware, such
as vLLM on a rented GPU. Only operators can declare them, through deployment
config. Projects and API callers can only name a registered alias. The
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
- `systemMessage` (optional, text models): `false` for a model whose chat
  template rejects the system role. Its requests then carry no system message:
  the instructions open the user turn. Vision models set this in their
  `vision` profile.
- `vision` (optional, vision models only): how page requests to this model are
  shaped, applied over any built-in profile for the same model id
  (`packages/shared/src/vision-request-profile.ts`). Fields:
  - `promptMode`: `"template"` (default) or `"image-only"`.
  - `systemMessage`: send the worker's system message (default `true`). Turn it
    off only for OCR-specialist models trained on a single user turn; the
    worker logs every request that uses a profile.
  - `temperature`, `topP`: sampling.
  - `maxOutputTokens`: a number, or `"server"` to send no `max_tokens`
    (requires `contextTokens`, which then bounds admission). Set
    `contextTokens` to at least the server's `--max-model-len`: vLLM then
    rejects any request that could produce more. `"server"` applies to private
    models only; a hosted route always sends a concrete cap.
  - `maxLongEdgePx`: the longest page-image edge, 256 to 4000; PDF pages render
    no larger, by lowering each page's DPI.

  Profiles shape plain page transcription only. A request with a project output
  schema or a task prompt (form fields, map OCR) keeps the worker's generic
  request, so its instructions are never dropped. Built-in profiles apply to
  private-endpoint models only.

  LightOnOCR-3 (`lightonai/LightOnOCR-3-0.8B`, `-4B`, `-1B`) has built-in
  profiles copied from LightOn's own client: image only, no system message,
  temperature 0.2, top_p 1.0, no `max_tokens`, and 2048 px pages (1540 px for
  the 1B). Serve them as LightOn's README says: vLLM 0.30.0 with transformers
  5.16.1, `--limit-mm-per-prompt '{"image": 1}' --max-model-len 18000`
  (16384 for the 1B) `--default-chat-template-kwargs '{"enable_thinking": false}'
  --mm-processor-cache-gb 0 --no-enable-prefix-caching`. Raster uploads (PNG,
  JPEG and so on) are sent at their uploaded size: resizing them would decode
  customer pixels outside an isolated provider.
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

A project refers to a private model as `llm://private/<alias>/<model-id>`.
The model id can contain `/`. Private routes take no `?baseUrl=` parameter,
because the registry supplies the URL and credentials. Private models are
managed settings: set them with the platform-admin route (a session, or a
platform admin's server key with the `admin:models` scope), not the public
project API, which refuses model fields.

```bash
curl -X PUT "$DOCSLURP_URL/v1/admin/projects/$PROJECT_ID/managed-models" \
  -H "Authorization: Bearer $DOCSLURP_ADMIN_MODELS_KEY" -H "Content-Type: application/json" \
  -d '{"pipeline": {
        "embedding": { "modelUri": "llm://private/gpu1/Qwen/Qwen3-Embedding-0.6B" },
        "vision": { "modelUri": "llm://private/gpu1/lightonai/LightOnOCR-3-0.8B" },
        "textGeneration": { "model": "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8" }
      }}'
```

Set the project's categories (`privacyMode: strict-privacy`, `vision.prompt`,
the profiles) with the public `PATCH /v1/projects/:projectId` as usual; the
embedding override needs a project without documents. The embedding and vision
`target` is inferred as `private`. `textGeneration.model` and its per-task
overrides accept either an OpenRouter id or a private route.
Strict-privacy templates keep their local defaults. Point a template's
project at private models with the admin route. Summaries and
propositions can then be turned back on.

| Surface | Endpoint path | Notes |
| --- | --- | --- |
| Worker text stages (summary, propositions, structured extraction, graph, community summaries, chunk preambles) | `/chat/completions` | Structured extraction also sends `response_format: json_schema` built from the project schema, to private endpoints only. |
| Worker page vision and self-critique | `/chat/completions` with an image | |
| Worker and API embeddings (including query embeddings) | `/embeddings` | Dimensions come from the registry. |
| API grounded chat answers | `/chat/completions` (streamed) | `DOCSLURP_PRIVATE_TEXT_MODEL`, where hosted chat is not allowed. A model stored on the project is ignored. |
| API voice input | `/audio/transcriptions` (multipart) | `DOCSLURP_PRIVATE_STT_MODEL`, where hosted speech-to-text is not allowed. |
| API search reranking (`reranker: model`) | `/rerank` (`{model, query, documents}` → `results[].relevance_score`) | `DOCSLURP_PRIVATE_RERANK_MODEL`, where the hosted reranker is not allowed. Any failure falls back to keyword ranking. |

Not routed yet: the API's optional search strategies and the chat MCP agent.
Where hosted models are not allowed they are skipped, as before private routes
existed (see TODO.md).

### Private model mode and the service map

The operator maps each model service to one registered private model, with one
variable per service. Projects never choose these: they keep a level (quality,
profile, tier), and the base URL, credentials and model come only from the
operator's environment. Set the same values on the worker and the app.

| Variable | Service | Registry capability |
| --- | --- | --- |
| `DOCSLURP_PRIVATE_TEXT_MODEL` | Worker text stages, structured extraction, API chat answers | `text` |
| `DOCSLURP_PRIVATE_VISION_MODEL` | Worker page vision (replaces a vision route that would be hosted) | `vision` |
| `DOCSLURP_PRIVATE_EMBEDDING_MODEL` | Worker and query embeddings (replaces an embedding route that would be hosted) | `embedding` |
| `DOCSLURP_PRIVATE_RERANK_MODEL` | API search reranking | `rerank` |
| `DOCSLURP_PRIVATE_ROUTER_MODEL` | Reserved: page-router decisions (validated, not used yet; see below) | `text` or `vision` |
| `DOCSLURP_PRIVATE_STT_MODEL` | API voice input | `stt` |

Each value is an `llm://private/<alias>/<model-id>` that must resolve in
`DOCSLURP_PRIVATE_MODEL_ENDPOINTS` with that capability; the embedding model
must declare `dimensions`. In private mode an unknown alias, an unlisted model,
a wrong capability or any other URI stops the worker and the app at startup. In
hosted mode the same mistake logs a warning and the service counts as
unmapped, so a deployment that never used the map keeps starting. Both
processes log `[private-model-mode] mode=… map_digest=… mapped=…` at startup:
the API and the worker must show the same digest.

`DOCSLURP_MODEL_MODE` sets where model calls may go for the whole deployment:

- `hosted` (default): `standard` projects use the hosted providers. Projects
  whose privacy mode forbids hosted models (`local-only`, `strict-privacy`) use
  the mapped private model for each service.
- `private`: every project, whatever its level or privacy mode, uses the mapped
  private model for each service, and no hosted model provider is ever called.
  The privacy guard treats every project as one that forbids hosted models, so
  each hosted call is refused before it leaves the process
  (`PrivacyModeViolationError`, logged as `[privacy] blocked ...`). A service
  with no mapping is unavailable: optional features skip, required work fails,
  and nothing falls back to a hosted model. Startup logs one warning that lists
  the unmapped services. Steps that call no remote model stay allowed: local
  embeddings, the heuristic and baseline page routers, local OCR. Startup also
  refuses hosted credentials (below), so no hosted call could authenticate even
  where a code path missed the guard, and live price-list fetches from hosted
  providers are off. Any other value of `DOCSLURP_MODEL_MODE` stops startup.

Runs created in private mode are stamped `modelMode: "private"` in their
pipeline snapshot (`project_runs.pipeline`). A worker treats a stamped run as
private even if its own `DOCSLURP_MODEL_MODE` says hosted: the run's `standard`
privacy mode reads as `local-only`, so every hosted call is refused.

A stored private route (an admin model override, an old run snapshot) is used
only when it is the service's mapped URI. Any other alias is dropped with a
warning: replaced by the mapping, or, with the service unmapped, back to the
level's own route, which the guard refuses.

In private mode startup refuses these variables when set, and a registered
endpoint may not use one of their names as its `auth.tokenEnv`:

| Variable | What uses it in hosted mode |
| --- | --- |
| `OPENROUTER_API_KEY` | Text, chat, vision, embeddings, voice input, moderation, decision models, live prices |
| `OPENAI_API_KEY` | OpenAI embeddings and vision |
| `ANTHROPIC_API_KEY` | Anthropic text stages |
| `DEEPINFRA_API_KEY`, `DEEPINFRA_TOKEN` | Hosted reranker, embeddings, media transcription and vision, GPU capacity provider, balance alerts |
| `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY` | Page-image query embeddings, balance alerts |
| `JINA_API_KEY` | Jina web reader |
| `PERPLEXITYAI_API_KEY`, `PERPLEXITY_API_KEY`, `LIQUID_API_KEY` | Page-router decision models |
| `MISTRAL_API_KEY`, `COHERE_API_KEY`, `VOYAGE_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `GROQ_API_KEY` | Hosted providers (refused so none is added unnoticed) |
| `HF_TOKEN`, `HUGGINGFACE_API_KEY` | Hugging Face downloads and inference |
| `TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY` | Web search and crawl tools |

To keep one for a use that sends no project content to a model (for example
the DeepInfra GPU capacity provider, or balance alerts), name it in
`DOCSLURP_PRIVATE_MODE_ALLOW_KEYS` (comma-separated). Startup then logs a
warning instead of refusing; the privacy guard still refuses every hosted model
call.

The map applies where a run or search reads its pipeline, never to what a
project stores. Local routes are kept: a `local-only` project on local
embeddings stays on them, because switching to a remote endpoint would send
content somewhere it did not go before. `DOCSLURP_VISION_MODEL_URI` (a hosted
default) does not apply in private mode.

Embedding size comes from the mapped model's registered `dimensions`; the
hosted profile's settings do not carry over (vectors are normalized, no late
chunking). The index identity of a document (`documents.index_config_hash`)
names the full model URI, so vectors from the private model are never mixed
with those of a hosted model, even one serving the same model id. Settings
changes, re-index planning and the legacy-index count all use this effective
identity. Existing documents keep the index they were built with. After
switching a deployment to private mode, those built with a hosted model are
skipped by search (diagnostic `indexConfigUnavailable`) until they are
re-indexed; the search itself still answers. With the embedding service
unmapped, the vector leg skips (diagnostic `embeddingUnmapped`) and the lexical
legs answer.

`DOCSLURP_PRIVATE_ROUTER_MODEL` is reserved. Page-router decision models
speak a decisions protocol that private endpoints do not serve yet, so in
private mode the router uses its heuristic or baseline plan, and startup says
so. The variable is validated now so a mapping is ready when a private decision
adapter exists (TODO.md).

Usage events of private calls record `provider = private` and
`model = <alias>/<model-id>`; their `metadata.modelUri` is
`llm://private/<alias>/<model-id>`, never the base URL or the token.

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
   `private:gpu1:worker.embedding`), plus the project, run and document. If
   the row cannot be written, or there is no project scope, the call is
   refused. Worker runs, page tasks and graph jobs set the scope. API calls pass
   the project explicitly.
4. Logs `[privacy] private-call operation=… alias=… model=… privacy_mode=… project=…`.

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

New projects default to `llm://openrouter/perplexity/pplx-embed-v1-0.6b`
(native 1024 dimensions). Projects can also select `llm://openrouter/perplexity/pplx-embed-v1-4b`
(native 2560 dimensions). Set the embedding target to `hosted`; both ingestion
and search use `OPENROUTER_API_KEY` and the fixed official OpenRouter endpoint.
For example, use this embedding configuration in the project pipeline:

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
explicit project model URIs remain selected. The `cheapest-hosted` profile
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
Changing the project route requires reindexing, including when switching between
native Perplexity and OpenRouter. Privacy mode still rejects remote requests.

Requests are packed to at most 128 inputs and a conservative 120,000-token upper
bound without truncating inputs. Existing spend checks, provider admission limits,
retry handling and usage attribution apply. Verified native input prices on
2026-10-17 are $0.004 and $0.03 per million tokens, before applicable markup.
See the [native embedding documentation](https://docs.perplexity.ai/docs/embeddings/quickstart)
and [rate limits](https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers).
Embedding API burst throughput does not establish full ingestion throughput.
