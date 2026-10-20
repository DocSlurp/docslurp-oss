# LanceDB search: which S3 reads make up the latency (October 2026)

Answers [issue 58](https://github.com/DocSlurp/docslurp-oss/issues/58) from existing storage-provider burn data, and
describes the counters added so production keeps showing the answer. Method and limits come first because they bound
every number below.

## Data and method

- Source: round 2 of the storage-provider burn on Fly `lax` (one `performance-8x` machine per arm, 5 users x 5 concurrent
  ingests of large PDFs, one chat per user every 20 s, 60 min + drain, `LANCEDB_S3_TRACE=1`, default Lance knobs). Five
  arms: Tigris, AWS S3 (us-west-1), B2 + Tigris index, B2 + DynamoDB commits (`b2ddb`), R2.
- Spans: `lancedb.search` (adapter span around `query.toArray()`), `lancedb.s3.*` (proxied native Lance requests) and
  `openrouter.embedding`. The `svc` field separates the API process (`-app`: searches and their reads) from the worker
  process (`-worker`: ingest writes and reads), so server-side search reads are not mixed with worker reads.
- Correlation: the spans carry no trace or parent IDs (native threads lose async context), so an app `lancedb.s3.*`
  request is attributed to a search when it starts inside the search's `[start, start + duration]` window (+/- 5 ms).
  Only **isolated** searches are used (no other search span overlapping): 74-79% of searches on the four fast arms,
  58% on R2 (its searches are longer, so they overlap more). A request that lands in two overlapping windows would
  otherwise be counted twice. 27-43% of app Lance requests fall outside isolated searches (overlapped searches,
  `openTable` probes); they are not in the tables.
- **Object classes are inferred.** The exported spans dropped the object key and range header, so requests are grouped
  by operation and response size (`bytes`; for ranged reads this equals the range length). `LIST` is
  `ListObjectsV2`; on the DynamoDB arm Lance does a `HeadObject` instead. Reading the sizes: tiny reads (<= 512 B) are
  file footers or lookups, 4-64 KiB reads are metadata and page tables, reads over 1 MiB (typically 3-5 MiB) are index
  partitions. This is a reading of the sizes, not a measurement; the counters below replace it with key classes.
- Load: every arm ran under constant ingest. "Ingest-quiet" means no worker Lance write (`PutObject`, `UploadPart`,
  `CompleteMultipartUpload`, `CopyObject`) within 5 s of the search. That is the closest thing to idle in this data;
  there was **no truly idle arm**.
- "Storage" is the union of in-flight request time inside the search window; the remainder is compute and scheduling.
- Reproduce: `node scripts/analyze-lancedb-search-reads.mjs <spans.jsonl.gz>` (the span exports are outside this repo).

## Result: a search is about three serial storage round trips, and storage is 83-98% of it

Isolated searches, all load levels:

| arm | searches | search p50 / p95 (ms) | reads per search p50 / mean / p95 | serial rounds p50 | storage busy p50 (ms) | storage share of p50 |
|---|---|---|---|---|---|---|
| Tigris | 1004 | 140 / 630 | 6 / 9.4 / 27 | 3 | 128 | 93% |
| AWS S3 | 984 | 149 / 438 | 6 / 10.3 / 36 | 3 | 137 | 93% |
| B2 + Tigris index | 943 | 151 / 690 | 5 / 11.7 / 54 | 3 | 131 | 88% |
| B2 + DynamoDB | 869 | 187 / 572 | 5 / 12.2 / 71 | 3 | 155 | 83% |
| R2 | 786 | 514 / 1018 | 5 / 5.2 / 8 | 3 | 501 | 98% |

The three rounds (Tigris, p50 duration in ms): round 1 28 (a `LIST` in 69% of searches, 15 ms HEAD on the DynamoDB arm),
round 2 43 (index metadata and small reads), round 3 50 (the final data or index read). Time between rounds is 3-5 ms and
the search span starts its first request within 1 ms, so the search is a chain of waits on storage. A search adds
no meaningful compute on this hardware: about 10 ms of the 140 ms p50.

Per-class requests per search (Tigris; the other fast arms are within about +/- 1 request per class):

| class (inferred) | requests / search | searches containing it | latency p50 / p95 (ms) | MB / search |
|---|---|---|---|---|
| LIST (version lookup) | 0.77 | 69% | 21 / 65 | 0 |
| GET <= 512 B | 2.09 | 95% | 30 / 97 | 0.00 |
| GET <= 8 KiB | 2.50 | 51% | 36 / 116 | 0.01 |
| GET <= 64 KiB | 1.76 | 67% | 36 / 157 | 0.06 |
| GET <= 1 MiB | 1.96 | 75% | 40 / 159 | 0.35 |
| GET > 1 MiB | 0.37 | 18% | 142 / 562 | 3.12 |

Other arms, requests per search for the same classes (LIST / <=512 B / <=8 KiB / <=64 KiB / <=1 MiB / >1 MiB):
AWS 0.78 / 1.46 / 3.16 / 2.29 / 1.99 / 0.64; B2 + Tigris 0.80 / 0.81 / 4.49 / 2.68 / 2.21 / 0.73;
b2ddb (HEAD 0.72, LIST 0.10) 0.86 / 4.83 / 2.73 / 2.37 / 0.56; R2 0.75 / 0.87 / 0.22 / 1.41 / 0.54 / 1.45
(R2 reads fewer, larger pieces: 9.4 MB per search, with 233 ms p50 for the large ones).

Idle versus under ingest (Tigris / AWS / B2 / b2ddb / R2):

| metric | ingest-quiet | under ingest |
|---|---|---|
| searches | 810 / 713 / 717 / 651 / 653 | 194 / 271 / 226 / 218 / 133 |
| search p50 (ms) | 136 / 141 / 138 / 187 / 514 | 170 / 172 / 207 / 192 / 510 |
| reads per search, mean | 7.9 / 8.7 / 9.5 / 10.7 / 5.2 | 16.0 / 14.6 / 18.7 / 16.7 / 5.4 |
| reads per search, p95 | 13 / 23 / 40 / 63 / 8 | 73 / 65 / 73 / 109 / 9 |
| serial rounds p95 | 3 / 4 / 3 / 4 / 3 | 7 / 7 / 5 / 8 / 5 |

During ingest the median barely moves but the tail grows: p95 reads rise from 13-63 to 65-109 and the chain grows from 3 to
5-8 rounds. That is consistent with searches also reading recently appended, not yet indexed data (bursts of 20+ small
ranged reads, p95), but the spans cannot confirm it.

### Cache evidence: most large reads repeat

Index-partition-sized reads (>= 64 KiB) repeat constantly. Counting a read as a repeat when a read of the same size
occurred in an earlier search in the previous 10 minutes (a proxy for the same range of the same immutable file;
identical sizes of 3-5 MiB are unlikely to collide by chance, small sizes can):

| arm | GET >= 64 KiB | repeat share by count | repeat share by bytes | repeat share by time | total MB | first-seen MB |
|---|---|---|---|---|---|---|
| Tigris | 2515 | 68% | 83% | 71% | 3491 | about 590 |
| AWS S3 | 2822 | 74% | 87% | 77% | 5146 | about 670 |
| B2 + Tigris | 2997 | 74% | 89% | 81% | 5782 | about 640 |
| B2 + DynamoDB | 2790 | 75% | 89% | 82% | 4965 | about 545 |
| R2 | 1593 | 97% | 97% | 96% | 7522 | about 225 |

Only 5 `openTable` calls succeeded per arm (one per org), so table handles are reused. The repeated reads therefore
happen on live handles: the default in-memory cache is not holding these ranges between searches (evicted, or
invalidated when ingest creates new versions). The new counters should confirm which class repeats.

## Where the time goes outside the Lance call

`lancedb.search` covers only the vector query. The API also embeds the query first (`openrouter.embedding`, app process):

| arm | query embeddings | p50 / p95 (ms) |
|---|---|---|
| Tigris | 1281 | 328 / 523 |
| AWS S3 | 1245 | 325 / 501 |
| B2 + Tigris | 1215 | 326 / 501 |
| B2 + DynamoDB | 1189 | 333 / 546 |
| R2 | 1367 | 329 / 558 |

So retrieval is about 470 ms p50 on a fast arm (328 embedding + 140 search): the query embedding is about 70% of it and
storage about 27%. Neither is large against chat: `/v1/chat` total p50 was 7.4-7.9 s and stream time-to-first-token
4.7-6.0 s on every arm (round 2 report), so retrieval is about 6% of a chat turn and the model call dominates. Search
matters most for search-only clients (REST, SDK, MCP, drop-in clients), where it is the whole response.

Also outside the search span: `getTable` probes for missing legacy tables (about 110 failed `openTable` calls per arm,
each 23-30 ms on Tigris/AWS/B2, 100-146 ms on b2ddb/R2) re-run every 5 minutes per org and target on the request path.

## Expected savings for the follow-up issues

Savings are upper bounds from removing the named requests from each isolated search and re-summing the serial rounds
(`scenarios()` in the analysis script), applied to the measured search p50. "Repeat" uses the size proxy above.

| scenario | Tigris p50 saved (ms) | AWS | B2 + Tigris | b2ddb | R2 |
|---|---|---|---|---|---|
| skip the version `LIST`/`HEAD` | 18 (13%) | 26 (17%) | 17 (11%) | 12 (6%) | 85 (17%) |
| cache repeated reads >= 64 KiB | 1 (mean 41) | 11 (mean 38) | 10 (mean 61) | 15 (mean 58) | 167 (33%) |
| cache all repeated GETs | 80 (57%) | 78 (52%) | 74 (49%) | 72 (39%) | 396 (77%) |
| both | 100 (71%) | 103 (69%) | 96 (64%) | 101 (54%) | 475 (92%) |
| search p50 after "both" (ms) | 26 | 38 | 34 | 46 | 9 |

- **#59 (Session, prewarm, read consistency).** Each org is searched about every 20 s in this load, longer than the 10 s
  `READ_CONSISTENCY_SECONDS`, so about 70% of searches pay a version lookup as their first serial round. Moving it off the
  path (background refresh or prewarm) saves one round: 12-26 ms p50 (6-17%) on the fast arms, 85 ms on R2. A larger Session
  cache that keeps index partitions and metadata is worth more: caching repeats removes 7-10 requests and about 75 ms p50
  (40-57%) per search, and trims p95 (Tigris 630 to about 340 ms, AWS 438 to about 310 ms). The large-read-only
  variant moves the mean (-38 to -61 ms) much more than the median because large reads occur in 18-34% of searches
  (96% on R2).
- **#60 (disk cache for immutable files).** The same repeated set. The working set is small: about 0.5-0.7 GB of
  first-seen >= 64 KiB ranges per arm over 70 minutes for 5 orgs, so a few GB of disk holds it. Compared with an effective
  in-memory Session cache it adds survival across restarts and deploys and a warm start for new machines; it saves
  the same requests, not more. If #59 fixes the in-memory misses, #60's marginal gain is the cold-start search, which
  these spans do not measure. R2 gains most (97% of large reads repeat, 396-475 ms p50).
- **#61 (embedding and result cache).** A query-embedding hit saves about 328 ms p50 (500-560 ms p95), more than any
  storage change here. A search-result hit saves embedding + search, about 470 ms p50 on a fast arm. The hit rate is
  unknown: spans carry no query text, and the burn's questions are not a model of real repeat rates. Against chat the
  saving is about 4-6% of a 7.5 s turn, so the case is strongest for search-only traffic and for a cache keyed on
  (org, workspace, query, filters, index version) with a short TTL.

Order by measured payoff, assuming repeats are real: cache repeated index/metadata reads (#59 session sizing, then #60),
then take the version lookup off the path, then #61 if search-only traffic repeats queries.

## Caveats

- One run, five orgs, a synthetic chat cadence; ingest ran the whole time. Treat ratios as indicative.
- Object classes are inferred from size; "repeat" is a size proxy, so cached-read savings are upper bounds. Small reads
  (4096 B) match by chance more often than large ones, which inflates the "all repeated GETs" row.
- Time-window attribution drops overlapped searches (21-42% of searches); if overlapped searches differ (more
  concurrency, more cold reads), the isolated numbers understate the tail.
- The storage share counts every second a request was in flight, which includes Lance deserialization waiting on the
  response; it is an upper bound on pure network time.

## What production now reports

With `LANCEDB_S3_TRACE=1` the proxy classifies every request (`list`, `latest`, `versions`, `transactions`, `indices`,
`data`, `deletions`, `other`) and its range size (`full`, `le4k`, `le64k`, `le1m`, `gt1m`):

- `lancedb.s3.*` spans carry `docslurp.lancedb.object_class`.
- Each `lancedb.search` span carries `docslurp.lancedb.s3.requests`, `.bytes`, `.request_ms`, `.overlapped`, one
  `docslurp.lancedb.s3.requests.<class>` per class seen and `docslurp.lancedb.s3.range.<bucket>`. Attribution is by
  time window (an in-process scope around the call); when searches overlap, each counts the shared requests and the span
  is marked `overlapped=true`. Spans are untouched when tracing is off.
- The 60 s `[lancedb-s3]` line gains `searches=`, `search_overlapped=`, `search_requests=` and `search_by_class=`
  (divide by `searches` for per-search averages), and `getLanceS3TraceStats()` returns the cumulative values.

Next measurement: rerun a short burn with these counters to replace the size-based classes with key classes and to
verify which class repeats before implementing #59 and #60.
