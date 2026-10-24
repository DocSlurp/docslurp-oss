# Track B: search latency tuning (2026-10-23)

Branch `perf/search-2026-10-23` in the core repo (worktree `/home/dan/worktrees/docslurp-oss/perf-search`), base core `62abb757` plus a clean merge of deployed `ecc94a48`. Nothing pushed or deployed.

## Method
- Corpus: 383 markdown docs from node_modules (READMEs/docs), 8,005 chunks, one org/workspace. LanceDB table on minio with HNSW_SQ vector index, FTS and btree indexes built as maintenance does. Postgres `docslurp_perf_search`. Embeddings are a deterministic feature-hashing model (384-d) served by an OpenAI-compatible stub with a fixed 150 ms delay, standing in for a remote embedder (transformers.js was unusable: host load 20-40). Quality numbers are therefore relative (config vs config), not an absolute quality claim.
- Latency realism: +24 ms RTT TCP proxy in front of minio, +4 ms in front of Postgres, disk read-through cache on (as prod `LANCEDB_S3_CACHE_DIR`), `SEARCH_EARLY_LEXICAL=on`.
- Queries: 949 source-derived (sentence / keywords / question-ish prefix of a chunk; label = that chunk). Frozen dev (672) / held-out (277) split by sha256 of the id; hashes in `query-split.sha256`, written before tuning. Held-out used once, for the final candidate.
- Quality gate: chunk recall@5/10, MRR, nDCG@10 and exact result-list identity per query (`compare.py`).
- Pairs are interleaved session by session (A,B,A,B). A session is one fresh process (cold first query recorded separately) plus 80-277 sequential warm queries. Bench `scripts/bench.ts`, runner `scripts/run.sh`, raw per-query JSON in `runs/`.
- Noise: quiet-period identical-config sessions differ up to +-10% in p50 (467/483/491, 397/428/443); across load swings the same baseline moved 363 to 680 ms. Only interleaved pairs are compared; every decision resting on wall time is PROVISIONAL.

## Where the time goes locally (conc=1, warm, p50 ms)
setup 15 | embed 160 (stub 150) | vector leg 75-115 (ANN ~22 CPU ms measured directly; the rest is proxy/disk cache/hydration/contention; 0 S3 requests when warm) | lexical leg 80-130 (parallel with vector) | fuse 18-40 | finalize 43 (persist 14) | total 410-460. A warm search makes 0 S3 requests; only a stale version check (30 s consistency) costs a LIST. CPU ~155-177 ms per query. The query embedding is the largest block and sits serially in front of the vector leg.

## Experiments
| # | change | result | decision |
|---|---|---|---|
| 01 | phrase relevance tokenizes each chunk once (relevance.ts) | p50 474 to 453 ms (-4.5%), p95 -5.3%, results identical 0/99; CPU/query 174.9 to 177.1 (+1.2%) | REJECTED, reverted |
| 02 | start lexical/page legs and a Lance table warm (open, version refresh, schema/capabilities) while the query embeds; the vector leg awaits the embedding promise (`SEARCH_LANCE_WARM=0` disables the warm) | dev p50 -8.7 / -8.1 / -15.6 / -11.7% over four ABAB sessions (n~300 each); held-out (277 q, 2 pairs) p50 377 to 340 (-9.8%), p95 550 to 492 (-10.6%), mean -10.3%; cold first query -12% median over 14 pairs; recall@10, nDCG identical, result lists identical 0/276; CPU/query +5% held-out (+0.9% dev). One conc=6 session was +12% (inside noise) | KEPT, provisional (wall time on a loaded host, right at the 10% bar) |
| 03 | rerankBM25 builds tf once, pair scan only if both words present (bit-identical on 200 random pools) | rerank CPU 11.6 to 9.3 ms at 200 chunks (-20%), under 2% of query CPU | REJECTED, reverted. The cpu-prof "11.8 s in rerank.ts" was wall sampling inflated by contention |
| micro | HNSW ef 100..1500, whole-workspace (383-doc) and 8-doc filters, direct to minio | p50 17-25 ms regardless of ef; recall@10 0.94 (ef 100) to 0.96 (ef 800+); 8-doc scope 1.00 everywhere | no lever locally, unchanged |
| micro | disk cache on vs off (2 pairs) | p50 383 vs 457 ms (+19% without cache); vector leg 73 vs 139 ms | existing prod setting confirmed |

The commit log is the experiment log (`git log perf/search-2026-10-23`): every experiment is committed with its result in the message, rejected ones undone by a forward revert.
Tests: `search-embedding-cache` (updated: the planner returns an in-flight embedding promise), `search-service`, `lancedb-prewarm`, `search-lancedb-native.db` and `relevance-floor` pass. `lancedb.test.ts` "preserves HNSW search breadth..." fails identically on the unmodified base (pre-existing). Server `tsc` reports no errors in touched files.

## Production telemetry (SigNoz, 7 d, read-only; aggregate numbers only, raw exports not published)
- Only spans are usable: `[search-timing]` and `[lancedb-s3]` log lines are not retained in SigNoz (0 matches in 7 d), so cache hit ratio and per-phase timings are unavailable from prod. This gap should be closed.
- 2,238 of ~2,540 `GET /v1/search` traces are the 2026-10-17 load test; organic traffic is a handful per day. The percentiles are load-test percentiles (queueing on shared CPUs), not user experience.
- `GET /v1/search` p50 2.29 s / p95 4.56 s / p99 9.3 s; `POST /v1/search` p50 1.54 s / p95 2.76 s. Inside, `api.search` p50 1.9 s on the same traces, so ~280-350 ms passes before search starts: Better Auth `get-session` (65 ms on those traces, two ~32 ms DB findOne calls) plus other pre-search work. Post-deploy `get-session` p50 is 15 ms (was 27).
- Query embedding: openai 207 ms p50 (p95 397), perplexity 113 (p95 440), openrouter 361 (p95 1,273; p99 2,448), local 55 ms warm but 10.7 s on the first post-deploy calls (model cold load). Embedding is serial before the vector leg: 100-360 ms of every uncached search.
- `lancedb.search` p50 259 ms / p95 2.8 s / p99 6.1 s; `lancedb.fts` p50 195 / p95 1.8 s. Post-deploy (n=31): search p50 299, fts 367, `lancedb.connect` 62 to 245 ms, `openTable` 58 to 210 ms: first use on a fresh machine costs ~450 ms before the first query.
- Query-time LLM strategies, when on, run serially before the embed: rewrite p50 514 ms, stepback 475, self-query ~450-500, HyDE 1.17 s, compression 661 ms.
- Postgres in 142 traces with DB spans: p50 13 statements, 228 ms total; p95 6.9 s (tail from single slow statements, e.g. 599 ms in the trace inspected). The earlier read-breakdown doc attributes 83-98% of the Lance span to ~3 serial storage round trips.

## Open ideas, ranked (untested)
1. Retain `[search-timing]` and `[lancedb-s3]` summaries in SigNoz (or emit them as span attributes); without per-phase prod data tuning rests on spans alone.
2. Cold start after resume/boot: pre-open and prewarm Lance tables for recently active orgs and load the local embedding model before taking traffic (10.7 s local-embed cold calls and ~450 ms connect+openTable observed).
3. ~280 ms before search starts in prod (session lookup, API key and rate-limit work at ~30 ms DB RTT): cache the session/user lookup for a few seconds and count statements per request.
4. Overlap query-strategy LLM calls (rewrite, self-query) with a speculative embed of the raw query and the lexical leg; reuse the vector when the rewrite returns the same text.
5. Provider connection keep-alive / shared embedding cache across processes for the 100-360 ms embed.
6. Version-check LIST off the request path (background refresh), only worth it for stale tables.

## Surprises
- Warm searches touch S3 zero times with the disk cache, so the S3-read breakdown from the burn report does not describe warm-cache searches; locally latency is embedding plus CPU.
- cpu-prof blamed `rerank.ts` for over half of self time; a CPU-time microbenchmark shows ~10 ms. Sampling profilers mislead on an oversubscribed host.
- ~160-175 ms CPU per query (JS, native Lance threads, in-process S3 proxy) caps a 2-vCPU machine near 10-12 searches/s; not investigated.

## AI spend and cleanup
Zero paid calls: embeddings were a local hash model and stub; no LLM or OpenRouter use. Prod: read-only SigNoz queries only, no search requests sent.
