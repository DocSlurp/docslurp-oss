# Embedding route audit and bounded comparison

Verified 2026-10-16 from live official pages and this checkout; research only, no provider calls or infrastructure created. This is a capability/price forecast, not a quality result. No held-out extraction inputs or gold labels were read.

## Provider evidence

| Candidate and exact route | Dimensions / MRL | Retrieval input and context | Live input USD / million tokens | Decision |
| --- | --- | --- | --- | --- |
| DeepInfra `BAAI/bge-large-en-v1.5`, `https://api.deepinfra.com/v1/openai/embeddings` | Native 1024; no verified MRL or resize parameter | English; 512 tokens; query instruction below, plain passages | 0.010 | Valid full-size candidate; do not truncate |
| DeepInfra `BAAI/bge-m3`, same endpoint | Native 1024; no verified MRL or resize parameter | Multilingual; 8192 tokens; no query instruction needed | 0.010 | Prefer for larger chunks; dense vectors only in current product |
| Jina `jina-embeddings-v3` on Jina API | Native 1024; MRL supports reduced sizes including 256/512/768 | `retrieval.query` / `retrieval.passage`; 8192 tokens | Not verified on requested DeepInfra route | Deferred: model not found on inspected DeepInfra embedding catalog |
| “Omni” | Ambiguous user name | Jina official site has `jina-embeddings-v5-omni-small`, but this does not establish that this is the user's intended model or a DeepInfra route | Unverified | Deferred; never invent a model ID |
| Google `gemini-embedding-2`, native Gemini API | Default 3072; MRL 128–3072, recommended 768/1536/3072; provider normalizes reduced output | Text up to 8192 tokens; do not assume 001's task-type contract applies | 0.20 standard text; 0.10 batch | Verified default-size fallback; requires native adapter and actual usage validation |
| Google `gemini-embedding-001` | Default 3072; MRL 128–3072; manually normalize reduced output | 2048 tokens; `RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT` | 0.15 shown in official localized pricing; absent from inspected current English price table | Prefer current fully priced embedding-2 fallback until route availability and current price confirmed |

Use BGE large's documented query prefix `Represent this sentence for searching relevant passages: ` exactly once, with unprefixed document inputs. Check whether the serving route already inserts a prefix before implementing one. Normalize dense vectors consistently for cosine retrieval and reject unexpected lengths/nonfinite values; model-level guidance is not evidence of the server's actual output normalization. BGE-M3 sparse/multivector capabilities are not a drop-in dense-index comparison.

Official sources: [DeepInfra embedding catalog](https://deepinfra.com/models/embeddings), [BGE large route and price](https://deepinfra.com/BAAI/bge-large-en-v1.5/api), [BGE-M3 route and price](https://deepinfra.com/BAAI/bge-m3/api), [BAAI dimension/context table](https://huggingface.co/BAAI/bge-m3), [BAAI query guidance](https://huggingface.co/BAAI/bge-large-en-v1.5), [Jina v3 model](https://jina.ai/en-US/models/jina-embeddings-v3/), [Jina task API](https://api.jina.ai/docs), [Jina Omni listing](https://jina.ai/?model=jina-embeddings-v5-omni-small&sui=), [Google embedding API](https://ai.google.dev/gemini-api/docs/embeddings), [Google current pricing](https://ai.google.dev/gemini-api/docs/pricing), [Google localized 001 pricing](https://ai.google.dev/gemini-api/docs/pricing?authuser=0000&hl=ja).

## Existing product contract and missing wiring

- `packages/shared/src/embedding.ts` registers hosted `text-embedding-3-small` at **1536**, supports explicit output dimensions, and has local BGE/Jina entries. Existing benchmark's claimed full dimension must be checked against stored artifacts/runtime; a schema default alone is not measured evidence. There is no basis to call the current benchmark a 256-dimensional index.
- `worker/src/stages/embedding-runtime.ts:createRemoteEmbeddingModel` implements OpenAI and local OpenAI-compatible routes, plus separately authorized private endpoints; Jina/nomic/mixedbread explicitly throw. DeepInfra and Google have no embedding implementation. OpenAI's worker base URL comes from process config, so disguising DeepInfra as OpenAI would apply process-wide credentials/URL and is unsafe for an isolated comparison.
- `server/src/lib/ai.ts:embedConfiguredText` dispatches OpenAI, local, private, Ollama/vLLM/LM Studio. `server/src/search/session-planner.ts:embedQuery` only selects `OPENAI_API_KEY` for hosted OpenAI. It forces normalization and catches provider failures into `null`; a screening harness must fail loudly if a candidate falls back to lexical search.
- `worker/src/embeddings/embedding-reuse.ts:embeddingVectorFingerprint` includes runtime/provider/model/base URL/dimensions/custom-dimension flag/task/normalization/dtype. Good reuse isolation exists, but adding distinct query/document tasks requires preserving both in experiment identity and the applicable document task in vector fingerprints.
- `packages/shared/src/vector-namespace.ts` physically separates model and vector dimensions, but does not encode provider URL/task/normalization. Therefore separate candidate organizations/storage roots or an expanded full route identity are necessary, especially for equal-dimension models on different routes.
- Worker batches already report actual remote tokens through `onRemoteUsage` to `state.usageLedger`; query embeddings use the search session recorder. Add provider/model token prices to shared pricing before new routes: otherwise worker fallback prices and server inferred prices can produce misleading spend. Reject absent provider usage rather than replacing paid token counts with estimates. Keep `assertCanSpend`, scope attribution and successful persistence before a subsequent paid batch.
- Root production environment was checked with Node for key presence only: `DEEPINFRA_API_KEY` present, `GOOGLE_GENERATIVE_AI_API_KEY` present; `GOOGLE_API_KEY` and `GEMINI_API_KEY` absent. No values were printed. Presence does not establish authorization, quota or working credentials.

Minimal product wiring, before paid comparison: (1) explicit hosted provider routes/catalog with immutable dimensions/capabilities and per-provider credentials; (2) same request transformations in document/query adapters, including task/prefix and normalization; (3) exact returned-size/finite/nonzero checks, no arbitrary `fitEmbeddingDimensions` for non-MRL models; (4) provider price and actual usage recorder integration; (5) isolated route fingerprints/index roots and fixture-free request/usage/failure tests. Google must demonstrate usage metadata on the chosen embedding endpoint before paid corpus runs. No product edits were made as part of this audit.

## Six-arm screen and forecast

Keep retrieval configuration, chunks, source corpus, query set and ranking fixed. Six includes the retained baseline, not six fresh reingestions. This allocation establishes a real 256 control without pretending it was the historical index.

| Arm | Route / dimensions | Provider dollars for one million document-plus-query tokens | Added work |
| --- | --- | --- | --- |
| A | Retained OpenAI small, observed full-size 1536 | 0 if reused, queries extra | Verify actual artifact dimensions |
| B | OpenAI small / 256 | 0.02 | Explicit provider dimensions; separate index |
| C | OpenAI small / 512 | 0.02 | Same |
| D | OpenAI small / 768 | 0.02 | Same |
| E | DeepInfra BGE-M3 / native 1024 | 0.01 | Explicit provider wiring first |
| F | Google embedding-2 / default 3072 | 0.20 | Native adapter and actual usage contract first |

OpenAI small price should be rechecked by the coordinator before execution; shared catalog currently records $0.02/M. Formula for five fresh arms above: `0.27 * corpus_million_tokens + query_tokens_by_route_cost`; baseline queries, retry allowances and customer-ledger charges are additional. At 1M tokens the illustrative provider subtotal is $0.27; at 5M it is $1.35. These are algebraic scenarios, not a corpus-size measurement. Reserve >=20% of the $3 phase cap for query calls/failures and honor the smaller remaining prior $10 cap including customer-ledger charges. Do not begin before measuring reusable extracted input tokens and remaining ledger allowance. Dimension reduction changes storage/compute, not token price.

If English chunks all fit 512 tokens, replace E with BGE large to address that specific larger-BGE request; do not silently compare truncation of long chunks. Otherwise BGE large is a seventh follow-up requiring reassessment after the six-arm gate. Jina/Omni cannot safely be included on DeepInfra until official route and price are available. A verified direct Jina route could replace a deferred arm only after price/credential/task wiring checks, without expanding six arms.

Decision: perform A–D with supported existing wiring and isolated indexes first; implement E/F only if the first screen and exact cost forecast justify them. If the coordinator chooses to prioritize cross-model differences instead, freeze and publish a replacement six-arm matrix before spending. No quality winner can be selected from documentation or vector dimension alone.

## Historical runtime check

The retained completed ASU run's embed-stage statistics (`/tmp/docslurp-large-docs/runs/e2-hosted-asu/final-progress.json`, run `60d446ca-aff3-4f50-a2d8-172663c01a0c`) report `dimensions: 1536`, 8,816 provider inputs and zero reuse hits. This establishes the pipeline-reported runtime baseline, rather than inferring it from a schema default. A direct vector-artifact length check remains desirable for candidate-index validation; the original run was not a 256-dimensional experiment.

## Implemented follow-up: explicit DeepInfra BGE-M3

The audit above records the pre-change state. A subsequent implementation adds the exact hosted `llm://deepinfra/BAAI/bge-m3` route with native 1024 dimensions, the fixed official URL, separate `DEEPINFRA_API_KEY` configuration, shared token pricing, and matching worker/query normalization. No query or passage prefix is added for M3. The adapters reject wrong-size, nonfinite and zero vectors instead of truncating. Actual provider token usage is required; paid usage reaches the existing worker ledger/search journal before vector validation so malformed vector responses still count. DeepInfra query failures propagate rather than silently changing the experiment to lexical-only retrieval. Existing namespace model `BAAI/bge-m3` differs from local `Xenova/bge-m3`; still isolate candidate indexes/organizations as frozen above. No defaults, deployed configuration or existing indexes changed; no paid calls in implementation verification. Historical baseline's 1536 dimensions were independently verified by coordinator from the retained embed-stage artifact.
