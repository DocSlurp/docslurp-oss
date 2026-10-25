# Performance tuning (2026-10-25)

Scope: page load and API response times, ingest latency and cost, from production
telemetry (SigNoz traces, Fly Prometheus) and read-only production database
queries (`default_transaction_read_only=on`, statement timeout). Code changes are
reviewed, merged and deployed through the normal manual workflow. Worker sizing and
rate-card changes are proposals only (they need `pnpm pricing:validate` and a
load-test comparison first).

## Where time goes (production, 24 h to 2026-10-25 19:30Z)

| Route | Calls | p50 | p95 | Dominant cost |
| --- | ---: | ---: | ---: | --- |
| `POST /v1/chat` | 475 | 12.9 s | 36.4 s | LLM (owned by chat-cost work) |
| `GET /v1/workspaces/:id` | 596 | 215 ms | 4.0 s | Postgres SELECTs (2.5 s of 5.1 s in slow traces) |
| `GET /v1/runs/:id/progress` | 1,060 | 200 ms | 436 ms | 12 sequential SELECTs (not tuned here) |
| `GET /v1/documents/:id` | 588 | 214 ms | 424 ms | ~6 SELECTs (not tuned here) |
| `GET /dashboard/bootstrap` | 13 | 797 ms | 5.4 s | 2 SELECTs ≈ 1.8 s/trace |

Worker: `worker.embedding.local` (bge-m3 on CPU) dominates ingest; ~102k `s3.HeadObject`/day in bursts.

## Experiments

| Candidate | Evidence | Result | Decision |
| --- | --- | --- | --- |
| Expression index `search_sessions ((metadata->>'workspaceId'), created_at)` | Prod EXPLAIN ANALYZE (18-workspace user): `listWorkspaces` 2.59–2.67 s; 47 ms Seq Scan on search_sessions × 18 loops × ≥2 subplans (15,664 rows, 35 MB) | Local 600k-session copy, 15 runs each: listWorkspaces p50 11,183 → 208 ms, p95 11,859 → 330 ms; getWorkspace 330 → 7.7 ms; output byte-identical | KEEP (migration 0087) |
| `jit = off` | Local: −64% / −12% in two interleaved pairs (noisy host); prod `EXPLAIN` 2,592/2,667 ms on vs 2,634/2,530 ms off | No production effect | REJECT |
| Integrity sweep: existence from the bucket listing | ~102k HeadObject/day in bursts at worker restarts (10–28k/h), 11,000 span-seconds; sweep HEADs every referenced key (≤20,000) after already listing the bucket | Exact (binary-order) classification; HEAD only for keys past a truncated listing | KEEP |
| Floor/burst CPU throttling | Fly Prometheus: floor `fly_instance_cpu_balance` 100,000 → 1, throttle ≈100, steal ≈105 during a 1,208 s embed; fleet 7 d: ≈104k s throttled vs ≈55k s CPU used; floor embeds 5 tokens/s vs 399 on burst | Shared-cpu baseline 12.5 %/vCPU: a drained shared-cpu-8x sustains ≈1 vCPU for $0.1691/h vs performance-1x $0.0550/h per dedicated vCPU | PROPOSE (sizing change needs pricing:validate + load test) |

## Rerun

```bash
# throwaway Postgres with the migrations, then seed 2,025 workspaces / 600k search sessions
docker run -d --name perf-pg -p 127.0.0.1:55433:5432 -e POSTGRES_PASSWORD=perf pgvector/pgvector:pg17
DATABASE_URL=postgres://postgres:perf@127.0.0.1:55433/perf node server/db/migrate.mjs
DATABASE_URL=... OTEL_ENABLED=false pnpm -C server exec tsx scripts/perf-workspace-reads.ts <label> 15
DATABASE_URL=... pnpm -C server exec tsx scripts/perf-workspace-dump.ts out.json   # parity between arms
```

Seed SQL and raw outputs: `/home/dan/tmp/agents/zip-mem/` (scratch, not committed).

## Open

- Worker CPU class (biggest ingest-latency lever): compare shared-cpu-8x vs performance classes with the load-test harness; floor as performance-2x/4 GB or keep CPU-heavy activities off the floor.
- `GET /v1/runs/:id/progress` (12 SELECTs per poll) and `GET /v1/documents/:id` (changelog computed on every open): trace with the new `db.query.summary` spans (oss#174) after deploy.
