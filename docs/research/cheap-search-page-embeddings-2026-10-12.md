# Page-image embeddings for deferred ("cheap") search: CPU vs GPU vs hosted

Campaign date: 2026-10-12 UTC. Question: for a search mode that embeds page
images up front and defers OCR/parsing until a query needs a page, which
embedding route gives usable retrieval at the lowest cost, with highly
compressible vectors (target ~256 dims or equivalent bytes)?

Corpus: the same pinned public ViDoRe DocVQA subset as the 2026-10-01 pilot
(`vidore/docvqa_test_subsampled@49bf8f13`, 500 pages, 500 original
question-to-page labels; other relevant pages may be unlabelled). "1024px" means
RGB downscaled to max edge 1024, JPEG q85 (mean 0.78 MP), roughly a 100 dpi
letter page. Artifacts, vectors, rankings and usage logs live outside the repo in
`~/data/docslurp-evals/cheap-search-embed-20261012/`. No model was tuned on these
questions. Jina weights are CC-BY-NC; runs used research/eval mode only.

## Quality and cost (full 500-page corpus)

| Model / route | Input | Recall@5 full | Recall@10 | Docs pages/min | Pages per $1 (embedding only) |
| --- | --- | ---: | ---: | ---: | ---: |
| Voyage multimodal-3.5 via OpenRouter (2048-d) | 1024px | **61.8%** | 68.6% | API | 2,149 (actual billed) |
| Jina v5 omni nano (768-d), RTX 5090 bf16 | 1024px | 54.4% | 61.8% | 1,771 | 115,400 at $0.921/h whole host |
| Gemini Embedding 2, PDF page, no query prefix (3072-d) | native | 51.8% | 60.4% | API | 8,613 standard; ~17,200 Batch API (50% list discount, not run) |
| Gemini Embedding 2, image, no query prefix (3072-d) | native | 50.8% | 59.0% | API | 8,613 |
| Jina v5 omni small (1024-d), RTX 5090 bf16 | 1024px | 50.8% | 57.8% | 845 | 55,100 |
| Qwen3-VL-Embedding-2B (2048-d), RTX 5090 bf16 | 1024px | 44.4% | 50.6% | 1,006 | 65,500 |

Gemini bills a flat 258 tokens per image or PDF page ($0.45/M → $0.000116/page);
the PDF route billed no extra OCR text tokens here. Gemini's documented
`task: search result | query:` prefix **hurts** image retrieval: 35.2% vs 50.8%
without it (`task: question answering` 37.4%). Downscaling to 1024px cost Gemini
1.2 points and Jina nano 1.8 points (vs the 2026-10-01 native 56.2%).

## CPU throughput (Jina/Qwen, AMD EPYC 9654 Genoa, AVX-512 BF16, cgroup 46 vCPU)

48-page 1024px subset, warm, batch 8 (Qwen batch 4). Quality on this subset is
easier and not comparable to the table above.

| Model | dtype | Threads | Pages/min | Pages/min per vCPU | Pages per $1 on Fly performance vCPU ($33/mo ≈ $0.0452/h) |
| --- | --- | ---: | ---: | ---: | ---: |
| Jina nano | bf16 | 16 | 76.9 | 4.81 | ~6,400 |
| Jina nano | bf16 | 44 | 146.4 | 3.33 | ~4,400 |
| Jina nano | fp32 | 44 | 81.4 | 1.85 | ~2,500 |
| Jina small | bf16 | 44 | 49.6 | 1.13 | ~1,500 |
| Qwen3-VL-2B | bf16 | 44 | 35.1 | 0.80 | ~1,060 |

CPU embedding works only with BF16-capable CPUs (AVX-512 BF16 / AMX); fp32 halves
throughput. On Fly performance pricing even the best CPU case (~6.4k pages/$) is
**below Gemini standard (8.6k) and well below a rented GPU (~115k at $0.92/h; a
$0.30/h RTX 3090 should be higher, estimate only)**. A contended i7-7700K
(AVX2, 8 threads, load avg 40) managed ~2.7 native pages/min — unusable.
Cheaper dedicated CPU providers were not priced live; verify before relying on them.

## Compressibility: bytes per page, not dimensions

`scripts/multimodal-eval/quantization_sweep.py` truncates (Matryoshka) and
quantizes saved vectors. Binary = sign bits, scored against the float query;
"+int8@50" re-scores the top 50 binary candidates with int8 document vectors.

| Model | 256-d float32 (1024 B) | Best ≤ 128 B | Best ≤ 400 B | Full float |
| --- | ---: | ---: | ---: | ---: |
| Voyage mm-3.5 | 54.2% | 59.2% (1024-bit, 128 B) | 60.2% (2048-bit, 256 B) | 61.8% |
| Jina nano | 42.6% | 49.2% (768-bit, 96 B) | 49.2% | 54.4% |
| Gemini Embedding 2 | 36.2% | 46.8% (1024-bit PDF, 128 B) | 51.0% (3072-bit, 384 B) | 50.8–51.8% |
| Jina small | 36.8% | 47.2% (1024-bit, 128 B) | 47.2% | 50.8% |
| Qwen3-VL-2B | 32.4% | 40.0% (1024-bit) | 42.8% (2048-bit, 256 B) | 44.4% |

Truncating to 256 dimensions loses 8–15 points on every model. Keeping full
dimensions and storing **sign bits** keeps nearly all quality at 96–384 bytes per
page, 3–10× smaller than a 256-d float32 vector. Binary first stage plus int8
re-scoring of the top 50 recovers float quality (e.g. nano 54.6%, Voyage 62.0%).
Gemini at 256-d is not viable for this task.

## Spend

Vast RTX 5090 + EPYC 9654 host, 17 minutes billable: $0.44 (credit delta),
destroyed and verified absent. Hosted embedding API calls: $0.48. Nemotron VL
(fixed 2048-d, free on OpenRouter) was dropped after the research showed no
Matryoshka support.

## Recommendation for the multimodal deferred-search mode

1. **Default route:** Jina v5 omni nano on the GPU backfill lane, 1024px pages,
   768-bit binary vectors (96 B/page) for first-stage search with int8 re-scoring.
   Needs a commercial Jina licence before production.
2. **No-GPU / no-licence fallback:** Gemini Embedding 2 through the Batch API on
   PDF pages with no query prefix, stored as 3072-bit binary (384 B/page).
3. **Quality tier:** Voyage multimodal-3.5, 2048-bit binary (256 B/page), at
   about 4× Gemini's per-page price.
4. Do not embed page images on Fly performance CPUs; it costs more than the
   hosted API.
