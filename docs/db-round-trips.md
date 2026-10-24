# Worker database round trips

The ingestion worker talks to Postgres with `postgres.js` using unnamed statements
(`prepare: false`), which is what a PgBouncer transaction pool requires. Every serial
network round trip costs the full RTT to the database (12 to 31 ms in production), so
round trips, not CPU, set the latency of small runs.

## What costs a round trip

- **A statement with parameters is two round trips** on an unnamed-statement connection
  (Parse/Describe/Flush, wait for the parameter types, then Bind/Execute/Sync) and cannot be
  pipelined. At 30 ms RTT a parameterized `select` takes 63 ms, an unparameterized one 32 ms, and
  three parameterized statements issued together 187 ms.
- `sql.begin` is BEGIN, each awaited statement and COMMIT, each its own round trip.

## What the worker does about it

- `patches/postgres@3.4.9.patch` remembers the parameter types the server reported for a
  statement text (bounded LRU, dropped again on a syntax, undefined-object or datatype error).
  Only the first use of a statement text pays the extra round trip; later uses send
  Parse/Describe/Bind/Execute/Sync in one burst. Nothing is kept server side, so it is valid
  behind a transaction pooler. `POSTGRES_PARAM_TYPE_CACHE=off` restores the old behaviour.
  `worker/src/db/postgres-param-type-cache.test.ts` fails if an upgrade drops the patch; after a
  `postgres` bump re-create the patch with `pnpm patch postgres@<version>`. Every Dockerfile that
  runs `pnpm install --frozen-lockfile` copies `patches/`.
- `pipelineTransaction` (`worker/src/db/transaction-pipeline.ts`) sends BEGIN, independent
  statements and COMMIT in one burst. Run checkpoints, the index-stage completion and the page
  base fee use it; documents' non-index stage completion is a single CTE statement.
- A stage group (adjacent light stages in one activity) reads the pause/cancel state and the next
  stage's opening reads (run, documents, checkpoints) inside the previous stage's completion
  checkpoint.

## Measuring

- `DOCSLURP_DB_TRACE_FILE=/path/trace.jsonl` appends one JSON line per statement the worker sends,
  labelled with its activity and stage.
- `node worker/scripts/pg-wire-proxy.mjs <listen> <host> <port> [oneWayDelayMs]` sits in front of
  Postgres, counts statements and serial round trips ("flights") on the wire and can add a fixed
  delay (15 ms each way is about 30 ms RTT). `GET :<listen+1000>/stats`, `POST /reset`.
- `worker/src/__tests__/db-statement-budget.test.ts` runs a 10-page document through the stage
  pipeline against an in-memory Postgres behind that counter and budgets statements and serial round
  trips per page (deterministic; independent of machine load).

Round trips per page are dominated by per-run and per-document-stage checkpoints, not pages:
statements per page fall from about 33 for a single 10-page document to about 5 for 40-page
documents.
