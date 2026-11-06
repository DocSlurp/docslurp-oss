#!/usr/bin/env node
// Builds the GIN expression index behind the folded keyword leg (migration 0121, docs/rollout-0121-0127.md):
//
//   node server/db/folded-search-index.mjs [--status] [--dry-run]
//
// CREATE INDEX CONCURRENTLY cannot run inside the migrator's transaction, and a plain CREATE INDEX would block every
// chunk insert for the whole build, so the index is built here, after the migration and while traffic flows. The build
// takes only SHARE UPDATE EXCLUSIVE on document_chunks: reads and writes continue. Idempotent and safe to repeat or
// run during a deploy:
//   - a session advisory lock keeps two builds from running at once (the second exits 0);
//   - a valid index is left alone; an INVALID one (an interrupted build) is dropped concurrently and rebuilt;
//   - the short lock_timeout bounds only the initial lock acquire: each attempt first takes SHARE UPDATE EXCLUSIVE on
//     document_chunks in a probe transaction under FOLDED_INDEX_LOCK_TIMEOUT_MS and releases it at once, so a table busy
//     with DDL or a manual VACUUM is retried later instead of queueing. The build itself then runs with lock_timeout = 0:
//     CREATE INDEX CONCURRENTLY waits for every transaction older than each of its phases, and those waits are lock waits
//     too, so a short timeout there would fail a long build at its end and leave an INVALID index. Its SHARE UPDATE
//     EXCLUSIVE lock never blocks reads or writes. A timed-out probe is retried, then the script fails (exit 1) without
//     leaving a lock behind. Postgres may leave an INVALID index after an interruption; the next run cleans it up;
//   - maintenance_work_mem (FOLDED_INDEX_MAINTENANCE_WORK_MEM, default 128MB) is the build's sort memory on the database
//     server. Size it to the compute: up to about a quarter of its RAM while nothing else heavy runs (Neon: 0.25 CU has
//     1 GB). Too large risks the server's memory; too small only makes the build slower.
// Keyword search works without the index (slower, bounded by a short statement timeout; search/folded-index.ts).
import { createRequire } from "node:module";

export const INDEX_NAME = "document_chunks_ts_folded_expr_idx";
// Must stay character-identical to the expression in services/search.ts, or the planner cannot use the index.
export const INDEX_EXPRESSION = "to_tsvector('simple'::regconfig, docslurp_fold_text(text))";
const BUILD_LOCK_KEY = 7_142_771_002; // distinct from the migrator's key (migrate.mjs)

/** Pure: build lock and wait settings, from env. */
export function buildSettings(env = process.env) {
  const int = (value, fallback) => (Number.isFinite(Number.parseInt(value ?? "", 10)) ? Number.parseInt(value, 10) : fallback);
  return {
    lockTimeoutMs: int(env.FOLDED_INDEX_LOCK_TIMEOUT_MS, 5_000),
    attempts: Math.max(1, int(env.FOLDED_INDEX_ATTEMPTS, 6)),
    retryDelayMs: int(env.FOLDED_INDEX_RETRY_DELAY_MS, 10_000),
    maintenanceWorkMem: memorySetting(env.FOLDED_INDEX_MAINTENANCE_WORK_MEM, "128MB"),
  };
}

/** Pure: a Postgres memory setting such as 128MB or 1GB (unset: the fallback). Anything else is refused, so a typo cannot ask for unbounded memory. */
function memorySetting(value, fallback) {
  const text = value?.trim();
  if (!text) return fallback;
  if (!/^\d{1,6}(kB|MB|GB)$/.test(text)) throw new Error(`FOLDED_INDEX_MAINTENANCE_WORK_MEM must look like 128MB or 1GB, got ${JSON.stringify(text)}`);
  return text;
}

/** Pure: migrate.mjs's direct-connection rule (session settings and advisory locks need one backend, not a pooler). */
export function directDatabaseUrl(url, env = process.env) {
  if (env.MIGRATION_DATABASE_URL?.trim()) return env.MIGRATION_DATABASE_URL.trim();
  try {
    const parsed = new URL(url);
    if (/-pooler\./.test(parsed.hostname)) parsed.hostname = parsed.hostname.replace("-pooler.", ".");
    return parsed.toString();
  } catch {
    return url;
  }
}

/** The index's state: "missing", "valid" or "invalid" (an interrupted build), plus its size. */
export async function indexState(client) {
  const { rows } = await client.query(
    `select i.indisvalid and i.indisready as valid, pg_relation_size(i.indexrelid) as bytes
     from pg_index i where i.indexrelid = to_regclass($1)`,
    [`public.${INDEX_NAME}`],
  );
  if (rows.length === 0) return { state: "missing", bytes: 0 };
  return { state: rows[0].valid ? "valid" : "invalid", bytes: Number(rows[0].bytes) };
}

export async function ensureFoldedIndex(client, { settings = buildSettings(), log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), dryRun = false } = {}) {
  const { rows: [fn] } = await client.query("select to_regprocedure('public.docslurp_fold_text(text)') is not null as present");
  if (!fn.present) throw new Error("docslurp_fold_text() does not exist: apply migration 0121 first (pnpm db:migrate)");
  const { rows: [{ locked }] } = await client.query("select pg_try_advisory_lock($1) as locked", [BUILD_LOCK_KEY]);
  if (!locked) {
    log("[folded-index] another build holds the lock; nothing to do");
    return { action: "busy" };
  }
  try {
    for (let attempt = 1; ; attempt += 1) {
      const before = await indexState(client);
      if (before.state === "valid") {
        log(`[folded-index] ${INDEX_NAME} is valid (${before.bytes} bytes); nothing to do`);
        return { action: "present", bytes: before.bytes };
      }
      if (dryRun) {
        log(`[folded-index] dry run: ${INDEX_NAME} is ${before.state}; would ${before.state === "invalid" ? "drop and " : ""}build it`);
        return { action: "dry-run", state: before.state };
      }
      try {
        // Initial acquire, bounded: can this session get the build's lock now? Released at once (CONCURRENTLY cannot run
        // inside a transaction, so the lock cannot be carried into the build).
        await client.query("begin");
        try {
          await client.query(`set local lock_timeout = '${settings.lockTimeoutMs}ms'`);
          await client.query("lock table public.document_chunks in share update exclusive mode");
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
        // The build: wait as long as older transactions need (they are not blocked by it).
        await client.query("set lock_timeout = 0");
        await client.query("set statement_timeout = 0");
        await client.query("select set_config('maintenance_work_mem', $1, false)", [settings.maintenanceWorkMem]);
        if (before.state === "invalid") {
          log(`[folded-index] dropping the invalid ${INDEX_NAME} left by an interrupted build`);
          await client.query(`drop index concurrently if exists public.${INDEX_NAME}`);
        }
        const started = Date.now();
        log(`[folded-index] building ${INDEX_NAME} concurrently (attempt ${attempt}/${settings.attempts})`);
        await client.query(`create index concurrently if not exists ${INDEX_NAME} on public.document_chunks using gin ((${INDEX_EXPRESSION}))`);
        const after = await indexState(client);
        if (after.state !== "valid") throw new Error(`${INDEX_NAME} is ${after.state} after the build`);
        log(`[folded-index] built ${INDEX_NAME}: ${after.bytes} bytes in ${Date.now() - started}ms`);
        return { action: "built", bytes: after.bytes, ms: Date.now() - started };
      } catch (error) {
        // 55P03 lock_not_available (lock_timeout), 40P01 deadlock_detected: wait for the blocking transaction and retry.
        const retryable = error?.code === "55P03" || error?.code === "40P01";
        log(`[folded-index] attempt ${attempt} failed: ${error?.message ?? error}`);
        if (!retryable || attempt >= settings.attempts) throw error;
        await sleep(settings.retryDelayMs);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [BUILD_LOCK_KEY]).catch(() => {});
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const require = createRequire(import.meta.url);
  const { Client } = require("pg");
  const client = new Client({ connectionString: directDatabaseUrl(url) });
  await client.connect();
  try {
    if (process.argv.includes("--status")) {
      const state = await indexState(client);
      console.log(`[folded-index] ${INDEX_NAME}: ${state.state}${state.state === "missing" ? "" : ` (${state.bytes} bytes)`}`);
      return;
    }
    await ensureFoldedIndex(client, { dryRun: process.argv.includes("--dry-run") });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(`[folded-index] failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
