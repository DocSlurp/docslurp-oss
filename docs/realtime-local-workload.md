# Frozen local realtime workload (2026-11-03)

Frozen before candidate measurement. No model/provider calls, no production, no canary.
Run `pnpm -C server exec vitest run src/realtime/load.db.test.ts`.

## Workload and boundaries

Use the fully migrated local PostgreSQL-compatible test database (PGlite through
postgres.js, one connection), one organization, owner, workspace, ten processing
runs, ten observers per run. Measure actual production `realtimeBackend` run
projection and `RealtimeBroker`, using explicit one-second logical ticks to
remove scheduler variance. No real-time sleep or performance claim about Fly.
Stub only LISTEN registration (reconciliation must work with all notifications
lost). Count every SQL statement through postgres.js debug, including resource
authorization, projection and revision reads; exclude fixture writes. Record
process CPU, elapsed time, peak sampled RSS, snapshot deliveries and serialized
bytes. These are process measurements, not remote DB CPU or browser telemetry.

Baseline is the existing SSE scheduler policy (run-progress-stream.ts): initial
snapshot, dirty snapshots at most once/second, authoritative refresh every ten
seconds. Replay that schedule with the SAME production read-only projection,
one stream per run and shared local fan-out. This deliberately avoids inventing
per-consumer baseline reads. It isolates broker scheduling; it is not a full
historical application benchmark. Transport handshake, periodic socket session
checks, Temporal reconciliation, activity/docs/billing and browser rendering are
outside this experiment and must not be inferred from its results.

Each scenario uses 20 logical seconds after bootstrap: idle (one run), burst
(100 committed updates at second 5, one run), ten-run (ten runs updated at seconds
5 and 15), reconnect (ten runs, observer detach at 5, ten offline updates at 6,
reattach at 8). Bootstrap and reattachment costs are included. Same fixture and
mutations in both arms. Run arms sequentially; no paid network access.

## Budgets fixed before measurement

- No missed final state, no extra projection on unchanged revisions.
- At most one projection per run per tick; 100-write burst yields one projection.
- Candidate idle SQL must be below baseline at 20 seconds; ten-run/reconnect
  total SQL must not exceed baseline by more than 20%. Report failures unchanged.
- Local p95 change-to-delivery work (excluding logical waiting) <= 2 seconds;
  total propagation includes up to one logical second reconciliation delay.
- Peak sampled RSS <= 1 GiB; output <= 2 MiB/scenario. CPU/time recorded without
  a comparative pass threshold because JIT/embedded DB share the process.

Results are emitted as JSON and recorded below after the frozen run. No budget
will be relaxed to make the candidate pass.

## Recorded result (local, 2026-11-03 14:28; before native-runtime reassessment)

| Scenario | Baseline SQL / broker SQL | Baseline projections / broker | Baseline CPU / broker CPU (ms) | Broker peak RSS (MiB) | Broker p95 work (ms) | Query budget |
|---|---:|---:|---:|---:|---:|---|
| idle | 24 / 51 | 3 / 1 | 90 / 101 | 672 | 0 (no changes) | FAIL |
| 100-write burst | 24 / 61 | 3 / 2 | 302 / 276 | 680 | 15 | FAIL |
| ten-run | 240 / 521 | 30 / 30 | 333 / 452 | 692 | 83 | FAIL |
| reconnect | 240 / 618 | 30 / 20 | 284 / 517 | 709 | 68 | FAIL |

All arms reconstructed the final authoritative state. Both ten-run arms exceeded
the frozen 2 MiB aggregate serialization budget (2,414,100 bytes); baseline
reconnect also exceeded it, while broker reconnect used 1,609,400 bytes. This is
aggregate observer delivery, not peak buffer or measured network bytes. Idle
broker used 80,470 bytes; burst 161,220. CPU includes fixture mutations, whose
SQL statements are excluded from the read counts. No tuning or budget relaxation
has been applied. The benchmark test passes correctness; emitted
`queryBudgetPassed`/`resourceBudgetPassed` are separate performance gates and are
not all green. Initial harness runs failed on an invalid fixture stage and then
stopped at the first byte-budget failure; the final run fixes the fixture and
reports every original budget rather than suppressing later arms.

This experiment does **not** establish issue319 performance acceptance. Shared
projection caching reduces repeated reads, but subscription authorization and
one-second revision reconciliation outweigh savings in these small workloads.
Production canary, actual mounted browser traffic and proxy idle/drain behavior
remain separate manual gates. Native execution migration must retain this
baseline and repeat the same workload; HTTP-count reduction alone is insufficient.

## Matched application workload: batched authorization (2026-11-03)

The independent application harness froze its workload before this change
(budget SHA256 9c02e1b143adc171002728e1801d8ad710d70b8700bccc4971db94db9bf81218).
A copy ran against this core without modifying the application checkout.
Instrumentation added SQL fingerprints/counts, without parameter values.
Raw candidate and matched legacy measurements are retained in
[realtime-matched-load-20261103.json](realtime-matched-load-20261103.json).
The source core HEAD in that file is the parent merge commit; the candidate also
included the batch authorization changes recorded with this report.

| Phase | Legacy SQL reads | Prior socket reads | Batched socket reads |
| --- | ---: | ---: | ---: |
| Idle, 32 seconds | 89 | 896 | 64 |
| Ten-run progress | 722 | 1220 | 694 |
| 100 completion events | 1215 | 250 | 280 |
| Offline completion/reconnect | 100 | 211 | 155 |

Idle attribution is exactly 32 revision reads and 32 authorization batches.
The old sweep separately resolved each of 17 resources every second; run
authorization also read its workspace identity. The replacement uses one fresh
statement for the bounded subscription set. There is no grant cache to invalidate.
Delivery reauthorization and activity constituent authorization remain fresh.
Generation checks and the independent resource-verification timeout remain.

This harness injects session authentication, so it cannot attribute BetterAuth,
MFA or administrator queries. The first-party adapter now validates an already
authenticated socket's session with one live query checking owner, expiry,
deleted user, second factor and current organization MFA enforcement. Upgrade
continues through BetterAuth. Per-socket overlapping checks share only the
in-flight promise; no settled session grant is cached. Separate migrated database
tests exercise expiry, wrong owner, MFA changes and deletion.

Candidate p95 propagation was 795 ms for progress, 646 ms for burst and 1427 ms
for reconnect. Idle CPU was 267 ms versus legacy 601 ms. Reconnect SQL remains
above legacy and is an open capacity gate; this run does not establish production
acceptance. No paid provider, production workload or deployment was used.
