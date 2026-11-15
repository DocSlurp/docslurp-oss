#!/usr/bin/env node
// Checks and repairs the per-project search and chat counters (project_activity_stats, migration 0165):
//
//   node server/db/project-activity-stats.mjs [--project <id>]...   compare counters with history (exit 1 on drift)
//   node server/db/project-activity-stats.mjs --rebuild             recompute every counter from history, then check
//
// The counters are kept exact by triggers on search_sessions, chat_turns and chat_sessions. They can only differ
// from history when those triggers were bypassed: session_replication_role = replica (logical replication apply,
// some restore tools), ALTER TABLE ... DISABLE TRIGGER, a manual fix of the counter table, or restoring some of
// these tables without the others. Nothing repairs that on its own.
//
// The check (project_activity_stats_drift()) is one read-only statement: it takes no lock that blocks anything and
// is exact while traffic flows, but without --project it reads all search and chat history (about a second per
// million search sessions), so run it off-peak on a large database.
//
// --rebuild (rebuild_project_activity_stats()) makes search and chat writes wait while it reads that history
// (SHARE ROW EXCLUSIVE on chat_sessions, chat_turns and search_sessions; reads are not blocked). It waits at most
// PROJECT_ACTIVITY_STATS_LOCK_TIMEOUT_MS (default 5000) for those locks, so it never queues traffic behind a
// long-open transaction; a timed-out or deadlocked attempt changes nothing and is retried
// (PROJECT_ACTIVITY_STATS_ATTEMPTS, default 6). Safe to repeat: a second run stores the same totals.
import { createRequire } from "node:module";
import { directDatabaseUrl } from "./folded-search-index.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pure: command line and env to settings. */
export function parseSettings(argv = process.argv.slice(2), env = process.env) {
  const int = (value, fallback) => (Number.isFinite(Number.parseInt(value ?? "", 10)) ? Number.parseInt(value, 10) : fallback);
  const projectIds = [];
  let rebuild = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--rebuild") rebuild = true;
    else if (argv[i] === "--project" && argv[i + 1]) projectIds.push(argv[++i]);
    else throw new Error(`unknown argument ${JSON.stringify(argv[i])}; usage: project-activity-stats.mjs [--project <id>]... | --rebuild`);
  }
  if (rebuild && projectIds.length > 0) throw new Error("--rebuild recomputes every project; it does not take --project");
  return {
    rebuild,
    projectIds,
    lockTimeoutMs: Math.max(1, int(env.PROJECT_ACTIVITY_STATS_LOCK_TIMEOUT_MS, 5_000)),
    attempts: Math.max(1, int(env.PROJECT_ACTIVITY_STATS_ATTEMPTS, 6)),
    retryDelayMs: Math.max(0, int(env.PROJECT_ACTIVITY_STATS_RETRY_DELAY_MS, 10_000)),
  };
}

/** Projects whose counters differ from history ([] when exact). `projectIds` empty: every project. */
export async function findDrift(client, projectIds = []) {
  const { rows } = await client.query(
    "select project_id, project_exists, stored, actual from public.project_activity_stats_drift($1::text[])",
    [projectIds.length > 0 ? projectIds : null],
  );
  return rows;
}

/** Recomputes every counter in one short transaction; returns the number of counter rows written. */
export async function rebuild(client, settings, log = console.log) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.query("begin");
      await client.query(`set local lock_timeout = '${settings.lockTimeoutMs}ms'`);
      const started = Date.now();
      const { rows } = await client.query("select public.rebuild_project_activity_stats() as written");
      await client.query("commit");
      log(`[project-activity-stats] rebuilt ${rows[0].written} counter rows in ${Date.now() - started}ms`);
      return Number(rows[0].written);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      // 55P03 lock_not_available (lock_timeout), 40P01 deadlock_detected: nothing changed; wait and retry.
      const retryable = error?.code === "55P03" || error?.code === "40P01";
      log(`[project-activity-stats] rebuild attempt ${attempt}/${settings.attempts} failed: ${error?.message ?? error}`);
      if (!retryable || attempt >= settings.attempts) throw error;
      await sleep(settings.retryDelayMs);
    }
  }
}

async function main() {
  const settings = parseSettings();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const require = createRequire(import.meta.url);
  const { Client } = require("pg");
  const client = new Client({ connectionString: directDatabaseUrl(url) });
  await client.connect();
  try {
    if (settings.rebuild) await rebuild(client, settings);
    const drift = await findDrift(client, settings.projectIds);
    if (drift.length === 0) {
      console.log(`[project-activity-stats] counters match history (${settings.projectIds.length > 0 ? `${settings.projectIds.length} projects` : "all projects"})`);
      return;
    }
    for (const row of drift) {
      console.log(`[project-activity-stats] drift ${row.project_id}${row.project_exists ? "" : " (project no longer exists)"} stored=${JSON.stringify(row.stored)} actual=${JSON.stringify(row.actual)}`);
    }
    console.error(`[project-activity-stats] ${drift.length} project(s) differ from history${settings.rebuild ? " after the rebuild" : "; repair with --rebuild"}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(`[project-activity-stats] failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
