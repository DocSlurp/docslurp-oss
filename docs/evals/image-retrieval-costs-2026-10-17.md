# Image-page retrieval embeddings: cost and model evidence

Checked 2026-10-17. Pricing research followed by the bounded OpenRouter diagnostic below. Prices below are embedding supplier prices, not complete ingestion, storage, retrieval, OCR, or answer-generation costs. The measured diagnostic is small and exposed; it does not establish general model quality.

## Decision

Test Gemini Embedding 2 as the simplest priced image-only baseline, Voyage multimodal 3.5 as a document-oriented hosted comparison, and Qwen3-VL-Embedding-2B or NVIDIA llama-nemotron-embed-vl-1b-v2 for self-hosting. Test ColQwen separately if dense table retrieval warrants a larger multivector index. Keep native text and lexical retrieval alongside visual retrieval: an image embedding does not supply readable evidence to the answer model. These are engineering recommendations inferred from the capabilities below, not a measured ranking.

## Google: current multimodal support, with an important PDF distinction

`gemini-embedding-2` supports images, PDFs, text, audio and video; `gemini-embedding-001` is text-only. Version 2 returns a single vector, with 128–3072 dimensions (recommended 768/1536/3072), an 8192-token limit, and up to six images or six PDF pages per request. Multiple parts are aggregated; request pages separately for page retrieval. PDFs contribute 258 visual tokens/page plus extracted native/OCR text; Developer API cannot disable that OCR. Use rendered PNG/JPEG for the image-only experiment. Excess document tokens can be truncated. [Google embedding documentation](https://ai.google.dev/gemini-api/docs/embeddings)

GA was announced April 22, 2026. [Google announcement](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-embedding-2-generally-available/)

Paid standard rates: $0.45/million image tokens, advertised approximately $0.00012/image; text $0.20/million tokens. Batch halves these rates. Limited standard free access is available, but batch is paid. DOCUMENT tokens are billed at image rates. [Google pricing, updated October 16](https://ai.google.dev/gemini-api/docs/pricing)

Derived embedding-only scenarios:

| Input to Gemini 2 | Standard per 1,000 pages | Batch per 1,000 pages |
|---|---:|---:|
| One image/page, vendor rounded image estimate | ~$0.120 | ~$0.060 |
| Exactly 258 billed image tokens/page | $0.11610 | $0.05805 |
| PDF with 258 visual + 500 extracted tokens/page, all billed DOCUMENT | $0.34110 | $0.17055 |
| PDF with 258 visual + 1,000 extracted tokens/page, all billed DOCUMENT | $0.56610 | $0.28305 |

The last two are explicit token-accounting scenarios, not observed bills; verify modality usage in actual receipts. At 50 text tokens/query, 1,000 standard query embeddings cost $0.010. Image resolution/cropping and actual billing should be logged before a production cost claim.

## NVIDIA: distinguish visual models from cheap text models

| Exact model | Image-page suitability and output | Availability/licensing/cost |
|---|---|---|
| `nvidia/llama-nemotron-embed-vl-1b-v2` | Image, text or image+text documents; text queries. Single 2048-dimensional vector. Roughly 1.7B parameters including vision encoder. High-resolution images use up to six tiles plus thumbnail, approximately 1792 visual tokens. | Released December 18, 2025. NVIDIA Open Model License plus Llama 3.2 terms; no verified sustained hosted per-image price. [Official card](https://huggingface.co/nvidia/llama-nemotron-embed-vl-1b-v2) |
| `nvidia/Nemotron-3.5-Embed-1B-BF16` | Image/text documents, text queries; single 2048 vector, truncatable to 1024/512 with normalization; 32k context. | Public card states October 20, 2026 release, **later than this audit**. Treat current availability as unresolved. OpenMDW 1.1; no verified hosted price. [Official card](https://huggingface.co/nvidia/Nemotron-3.5-Embed-1B-BF16) |
| `nvidia/Nemotron-3.5-Embed-8B-BF16` | Multimodal, single 4096 vector, 32k context. | Same new-family availability caution; no verified image API rate. [Official card](https://huggingface.co/nvidia/Nemotron-3.5-Embed-8B-BF16) |
| `nvidia/Nemotron-3-Embed-1B-BF16` | **Text-only**, 2048 vector. | Existing cheap text benchmark cannot price the visual models. [Official card](https://huggingface.co/nvidia/Nemotron-3-Embed-1B-BF16) |
| `nvidia/NV-Embed-v2` | Text embedding, not an image-page encoder. | CC-BY-NC-4.0; not a permissive commercial alternative. [Official card](https://huggingface.co/nvidia/NV-Embed-v2) |

NVIDIA's [VL trial endpoint](https://build.nvidia.com/nvidia/llama-nemotron-embed-vl-1b-v2) establishes an API demonstration, not a sustained production unit price. Do not substitute trial credits for operating cost.

## Open-weight visual retrieval choices

| Model | Representation | Fit and constraints |
|---|---|---|
| `Qwen/Qwen3-VL-Embedding-2B` | Single 2048 vector, flexible dimensions, 32k context | Text, images, video and mixed inputs; Apache 2.0. Strong practical self-host candidate, but no measured course-table score here. [Card](https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B) |
| `Qwen/Qwen3-VL-Embedding-8B` | Single vector up to 4096 dimensions, 32k | Larger multimodal candidate; compare throughput and recall before choosing size. [Card](https://huggingface.co/Qwen/Qwen3-VL-Embedding-8B) |
| `vidore/colpali-v1.3` | Multivectors; card example 1030 × 128 per page, MaxSim late interaction | Purpose-built visual document retrieval. Adapter MIT, underlying Gemma terms apply. [Card](https://huggingface.co/vidore/colpali-v1.3) |
| `vidore/colqwen2-v1.0` | Dynamic-resolution page multivectors and late interaction | Qwen2-VL-2B base Apache 2.0, adapter MIT. Default maximum 768 image patches; resolution changes compute/memory. [Card](https://huggingface.co/vidore/colqwen2-v1.0) |
| `vidore/colqwen2.5-v0.2` | Visual document multivectors | Base is under Qwen Research License despite MIT adapters; do not assume commercial terms match ColQwen2. [Card](https://huggingface.co/vidore/colqwen2.5-v0.2) |
| `google/siglip2-so400m-patch14-384` | Single 1152-dimensional image/text vector; 384-pixel image input | Apache 2.0. General image semantics; small dense text is a likely weakness, an inference requiring testing. [Card](https://huggingface.co/google/siglip2-so400m-patch14-384), [configuration](https://huggingface.co/google/siglip2-so400m-patch14-384/blob/main/config.json) |

Self-hosting has no fixed per-page price. Calculate **1,000 × total billed GPU dollars / successful pages**, including startup, idle time, retries and rendering, then add storage/query costs. A $0.50/hour GPU sustaining 10 pages/second would cost $0.01389/1,000 pages for active GPU time; at 1 page/second, $0.13889. These are illustrative assumptions, not measured performance or quoted GPU prices.

Derived raw float32 vector storage: one 3072-vector is 12,288 bytes/page; 1030 × 128 multivectors are 527,360 bytes/page, about 43 times larger. At one million pages that is 12.3 GB versus 527 GB before indexes, metadata, replicas and images. Float16 halves raw bytes. Late-interaction quality must justify its storage and query work.

## Hosted alternative with explicit pixel pricing

`voyage-multimodal-3.5` accepts text, document screenshots and video in a shared space; single-vector dimensions 256/512/1024/2048, 32k context. Requests allow multiple inputs, but context tokens are computed using 560 image pixels/token; a page is not one token. [Voyage multimodal API](https://docs.voyageai.com/docs/multimodal-embeddings)

Paid multimodal 3.5/3 pricing is $0.60/billion image pixels and $0.12/million text tokens. Billing floors images at 50,000 pixels and caps at 2 million after resizing. First 150 billion image pixels and 200 million text tokens are introductory free allowances. Generic batch pricing is discounted, but multimodal endpoint eligibility was not verified; no discount assumed here. [Voyage pricing](https://docs.voyageai.com/docs/pricing), [batch documentation](https://docs.voyageai.com/docs/batch-inference)

Derived per 1,000 one-image pages: 768×1024 pixels **$0.4718592**; 1 megapixel **$0.60**; 2 megapixels **$1.20**; billing-floor tiny images **$0.03** (not a credible dense-table quality setting). At 50 text tokens/query, 1,000 query embeddings cost **$0.006**. Pixel cost makes resolution an explicit quality/cost variable.

Jina's current v5-omni-small/nano also supports images/PDFs and reports image token usage, but no reliable fixed paid image unit price was established here. Its v4 API is research-only; do not market it as a free commercial substitute. [Jina official embedding page](https://jina.ai/embeddings/)

## Implication for the measured DocSlurp cohort

Parent-supplied measured baseline: 14,780 pages, API $0.08885726 + scoped VM $0.0622821225 = **$0.1511393825**, or **$0.010225939/1,000 pages**. Customer charge $4.55522048 is a different quantity. This scope excludes other infrastructure and answer-time expense; it is not a complete operating margin.

Applying Google's rounded image estimate to every page would add approximately **$1.77360 standard** or **$0.88680 batch** in embedding charges alone. Those additions are approximately 11.7× or 5.9× the existing scoped text-pipeline cost, while still small absolute amounts. A selective visual index for 10% of pages would reduce those additions proportionally, subject to selecting the right pages. These are arithmetic projections, not completed experiments.

## Evaluation gate for dense course tables

Use the existing failed course questions and held-out tables, with exact target pages and required cells. Compare text+lexical baseline, image-only retrieval, and merged text/visual candidates at the same top-k and answer budget. Record page Recall@5/10, exact course-code/abbreviation matches, grounded answer correctness, p95 latency, resolution, billed units, retry cost, vector bytes and query cost. Separate retrieval failure from answer-reading failure: correctly retrieving a table does not prove the generator can read its cells. Require quality improvement before claiming visual indexing solves the current failure cohort.

## Scale comparison requested for the planned 50,000-page dataset

Linear projections below assume identical page mix, no free credits, one image/page, and no retries. Current text rows project observed scoped costs/customer charge; image rows are supplier embedding fees only, so they are not equivalent service bundles.

| Route and unit assumption | 1,000 pages | 10,000 pages | 50,000 pages |
|---|---:|---:|---:|
| Current text pipeline: measured API + scoped VM | $0.010226 | $0.102259 | $0.511297 |
| Current customer charge: observed cohort average | $0.308202 | $3.082017 | $15.410083 |
| Gemini 2: exactly 258 billed image tokens/page, standard | $0.116100 | $1.161000 | $5.805000 |
| Gemini 2: same assumption, batch | $0.058050 | $0.580500 | $2.902500 |
| Gemini 2: rounded vendor per-image estimate, standard | ~$0.120000 | ~$1.200000 | ~$6.000000 |
| Legacy Vertex multimodalembedding@001: one image/page | $0.100000 | $1.000000 | $5.000000 |
| Voyage multimodal 3.5/3: 768×1024 image/page | $0.471859 | $4.718592 | $23.592960 |
| Voyage multimodal 3.5/3: 1 megapixel/page | $0.600000 | $6.000000 | $30.000000 |
| Voyage multimodal 3.5/3: 2 megapixels/page | $1.200000 | $12.000000 | $60.000000 |
| Cohere Embed 4 | Unverified current rate | Unverified | Unverified |

The legacy Google price is verified at $0.0001/image in the [current Cloud price table](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing). Its single vectors support 128/256/512/1408 dimensions, but images resize to 512×512 and text queries truncate at 32 tokens, English only. That makes it a low-price comparison, not a presumed equivalent for dense course tables. [Legacy multimodal documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-multimodal-embeddings)

Cohere's current primary pricing page now features Embed 5 Fast/Pro ($3/hour Small, $5/hour Medium dedicated Model Vault). It did not expose a current Embed 4 image-token price in the retrieved official content. Therefore secondary claims of $0.47/million image tokens are **not accepted as verified current pricing in this report**; image token accounting would still be necessary to translate them into pages. Trial keys are not for production. [Cohere pricing](https://cohere.com/pricing), [current Embed 5 announcement](https://cohere.com/blog/embed-5)

## Self-host break-even, with utilization explicit

Let H be dollars per billed GPU hour, r successful pages/second while actively processing, and u the active fraction of billed time. GPU cost/1,000 pages = H / (3.6 × r × u). This excludes CPU/rendering, storage, queries and engineering. At a **hypothetical $0.50/hour**, required active throughput to match these cost ceilings is:

| Cost ceiling | 100% utilization | 50% utilization | 25% utilization |
|---|---:|---:|---:|
| Current scoped text $0.010225939/1,000 | 13.58 pages/s | 27.16 pages/s | 54.33 pages/s |
| Gemini 2 batch $0.05805/1,000 | 2.39 pages/s | 4.79 pages/s | 9.57 pages/s |
| Legacy Vertex $0.10/1,000 | 1.39 pages/s | 2.78 pages/s | 5.56 pages/s |
| Gemini 2 standard $0.1161/1,000 | 1.20 pages/s | 2.39 pages/s | 4.79 pages/s |
| Voyage 1-megapixel $0.60/1,000 | 0.23 pages/s | 0.46 pages/s | 0.93 pages/s |

Throughput thresholds double at $1/hour. Utilization includes idle/startup time; retries lower successful-page throughput. Matching the existing scoped text-pipeline price is a stringent budget ceiling, not proof visual retrieval supplies the same quality or full functionality. The dedicated 50,000-page evaluation must measure these quantities rather than infer them from model size.


## Measured OpenRouter diagnostic

64 identical source pages and three known course questions, October 17. One vector per page; cosine retrieval. Strict semester-specific page ranks correct the older multi-semester support labels. All five routes placed each strict answer page in the top five. Native page-text embedding is not the production semantic-chunk pipeline.

| Model / input | Observed embedding USD / 1,000 pages | Strict page ranks (three queries) |
|---|---:|---|
| google/gemini-embedding-2 (image) | $0.116100 | 1, 2, 3 |
| google/gemini-embedding-2 (text) | $0.389481 | 1, 2, 2 |
| nvidia/llama-nemotron-embed-vl-1b-v2:free (image) | $0.000000 | 1, 3, 3 |
| perplexity/pplx-embed-v1-0.6b (text) | $0.006856 | 1, 3, 5 |
| voyageai/voyage-multimodal-3.5 (image) | $1.093939 | 1, 2, 1 |

NVIDIA was the OpenRouter free endpoint: zero recorded API price is promotional access, not a sustainable hosting estimate. One timed-out batch was retained and retried once; the retry succeeded. No invoice usage is available for the failed attempt. All 85 successful requests have persisted usage. Gemini used OpenRouter exclusively for this comparison; an earlier direct pilot failed HTTP 402 and produced no embedding. Do not use direct Google credits for follow-up runs. Official direct/batch list prices above are comparison references, not routes used here or promises of OpenRouter batch discounts.

Measured embedding/query provider total: $0.1028512408. Separate one-page OpenRouter pilot: $0.00012771. Retrieval-controls provider total: $0.014474866; customer ledger: $0.0173698392. Combined successful provider usage in this extension: $0.1174538168, below the $100 authorization. Reporting-agent costs and any unreturned timeout billing are not reconciled in this API subtotal.

## Retrieval tuning decision

208 production searches completed HTTP 200: 96 calls covering 16 arms, then 112 calls over 28 development queries and four arms. Baseline retrieved support for 24/28; rewrite 24/28; stepback 26/28; stepback plus rewrite 27/28. Combined helpers recovered all three course cases, with median latency 5.09 s versus baseline 3.32 s. MRR fell from .763 to .636, so improved recall did not imply better rank. This is a candidate preset, not a validated default: all queries were exposed, no randomized repeats or generated-answer scoring.

Candidate request: `{limit:10,minScore:0,parentRetrieval:true,rerank:true,stepback:true,queryRewrite:true,mmr:false}`. These are GET search parameters; the saved live harness explicitly disables the other helpers. Graph/community options lacked indexed graph capabilities and therefore have no measured graph-quality result. HyDE and compression did not improve the six-question pilot; compression increased median latency from 4.04 s to 6.97 s. Self-query misclassified quoted content as a filename and regressed one check.

The source changes expand explicit workspace/request abbreviations and translated aliases into both lexical and vector queries; they do not automatically learn terminology. MMR now preserves relevance when vectors are absent and reports the limitation. Parent-aware BM25 rescoring improved saved-pool recall from 23/28 to 25/28, but remains an offline experiment rather than a promoted pipeline change.

## Product and partner decision

Keep the inexpensive native-text hybrid route as the default. Offer image retrieval as an optional fallback for scanned pages, layouts and tables, with a vision-capable answer step or native-text evidence on demand. Cache page renders and embeddings by content hash/model/dimensions; batch offline ingestion when the selected gateway supports it; avoid embedding decorative images and repeated headers. Validate lower vector dimensions and route expensive query helpers only to low-confidence cases. These are proposed optimizations, not measured savings.

The measured ingestion cohort cost $0.1511393825 in supplier API plus allocated active-worker cost for 14,780 pages; customer ledger $4.5552204792. That is $0.010226 versus $0.308202 per 1,000 pages. Allocation excludes storage/database, idle fleet time, support and later searches/answers: it is not net profit or a universal 10× competitor claim.

The dedicated corpus contains 27 distinct PDFs / 58,378 pages and 66 questions, including 28 evidence-backed cross-college student scenarios. Actual scenario sizes are 12,824, 26,895 and 50,722 pages. Labels are provisional and recommendations require human review. The corpus has not been indexed or evaluated at 50k scale. See large-retrieval.md for reproducible loading and scoring.
