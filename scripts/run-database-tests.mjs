#!/usr/bin/env node
// Run the env-gated real-Postgres and Redis tests (they skip without their URL)
// against service containers, one fresh copy of a migrated template database per
// file. Fails on any failed or skipped test, so a renamed variable cannot quietly
// turn a test off again, and on gated test files missing from GATED below.
//
//   DATABASE_TEST_ADMIN_URL=postgres://user:pw@127.0.0.1:5432 \
//   DATABASE_TEST_TEMPLATE=tmpl REDIS_TEST_URL=redis://127.0.0.1:6379 \
//   node scripts/run-database-tests.mjs [file filter]
//
// The template must already be migrated: DATABASE_URL=<admin>/tmpl node server/db/migrate.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Test file -> the variables it reads. "db" gets a fresh database URL, "redis" the Redis URL. */
export const GATED = {
  "server/src/__tests__/config-change.db.test.ts": { db: ["CONFIG_CHANGE_TEST_DATABASE_URL"] },
  "server/src/__tests__/full-index-leases.db.test.ts": { db: ["FULL_INDEX_TEST_DATABASE_URL"] },
  "server/src/__tests__/run-admission-leases.db.test.ts": { db: ["RUN_ADMISSION_TEST_DATABASE_URL"] },
  "server/src/__tests__/run-lifecycle-boost.db.test.ts": { db: ["RUN_RETRY_BOOST_TEST_DATABASE_URL"] },
  "server/src/__tests__/auth-rate-limit.db.test.ts": { db: ["AUTH_RATE_LIMIT_TEST_DATABASE_URL"] },
  "server/src/__tests__/auth-session-refresh.db.test.ts": { db: ["AUTH_SESSION_TEST_DATABASE_URL"] },
  "server/src/__tests__/billing-credits.db.test.ts": { db: ["BILLING_TEST_DATABASE_URL"] },
  "server/src/__tests__/byte-counter-migration-locks.db.test.ts": { db: ["MIGRATION_LOCK_TEST_DATABASE_URL"] },
  "server/src/__tests__/chat-feedback-routes.test.ts": { db: ["CHAT_FEEDBACK_TEST_DATABASE_URL"] },
  "server/src/__tests__/cli-oauth.db.test.ts": { db: ["CLI_OAUTH_TEST_DATABASE_URL"] },
  "server/src/__tests__/db-resume.db.test.ts": { db: ["RESUME_TEST_DATABASE_URL"] },
  "server/src/__tests__/organization-concurrency.test.ts": { db: ["ORG_TEST_DATABASE_URL"] },
  "server/src/__tests__/pending-supersession-locks.db.test.ts": { db: ["MIGRATION_LOCK_TEST_DATABASE_URL"] },
  "server/src/__tests__/query-bounds.pg.test.ts": { db: ["SEARCH_BOUNDS_PG_URL"] },
  "server/src/__tests__/rate-limit.redis.test.ts": { redis: ["RATE_LIMIT_TEST_REDIS_URL"] },
  "server/src/__tests__/run-lifecycle.db.test.ts": { db: ["RUN_LIFECYCLE_DATABASE_URL"] },
  "server/src/__tests__/run-start-recovery.db.test.ts": { db: ["RUN_LIFECYCLE_DATABASE_URL"] },
  "server/src/__tests__/usage-attribution.db.test.ts": { db: ["USAGE_ATTRIBUTION_DATABASE_URL"] },
  "server/src/__tests__/workspace-graph-service.db.test.ts": { db: ["WORKSPACE_GRAPH_TEST_DATABASE_URL"] },
  "server/src/__tests__/workspace-naming.db.test.ts": { db: ["WORKSPACE_NAMING_RACE_DATABASE_URL"] },
  "server/src/__tests__/workspace-settings-proposals.db.test.ts": { db: ["SETTINGS_LOCK_TEST_DATABASE_URL"] },
  "server/src/__tests__/workspace-recommendation-visits.db.test.ts": { db: ["RECOMMENDATION_TEST_DATABASE_URL"] },
  "server/src/__tests__/workspace-state.test.ts": { db: ["WORKSPACE_STATE_TEST_DATABASE_URL"] },
  "server/src/lib/dependency-postgres.test.ts": { db: ["GRAPH_PURGE_TEST_DATABASE_URL"] },
  "worker/src/__tests__/checkpoint-lock-order.test.ts": { db: ["CHECKPOINT_LOCK_TEST_DATABASE_URL"] },
  "worker/src/__tests__/credit-lease.test.ts": { db: ["CREDIT_LEASE_TEST_DATABASE_URL"] },
  "worker/src/__tests__/provider-rate-limit.test.ts": { redis: ["AI_RATE_LIMIT_TEST_REDIS_URL"] },
  "worker/src/__tests__/superseded-purge.test.ts": { db: ["GRAPH_PURGE_TEST_DATABASE_URL"] },
};

/** Gated files that need more than a database (fixtures, benchmarks, live services). */
export const NOT_RUN = {
  "server/src/__tests__/search-native.bench.test.ts": "benchmark: needs a qrels file and a populated corpus",
};

const GATE = /process\.env\.([A-Z0-9_]*(?:DATABASE_URL|_PG_URL|REDIS_URL))\b/g;

/** Test files that read a database or Redis URL variable, relative to the repo root. */
export function findGatedTestFiles(dir = root) {
  const found = [];
  for (const top of ["server/src", "worker/src", "packages"]) {
    const walk = (current) => {
      for (const name of readdirSync(current)) {
        if (name === "node_modules" || name === "dist") continue;
        const full = path.join(current, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.test\.(ts|mjs)$/.test(name)) {
          const vars = [...readFileSync(full, "utf8").matchAll(GATE)].map((m) => m[1]).filter((v) => v !== "DATABASE_URL");
          if (vars.length) found.push(path.relative(dir, full));
        }
      }
    };
    walk(path.join(dir, top));
  }
  return found.sort();
}

export function unregisteredGatedFiles(files) {
  return files.filter((file) => !GATED[file] && !NOT_RUN[file]);
}

function main() {
  const unregistered = unregisteredGatedFiles(findGatedTestFiles());
  if (unregistered.length) {
    console.error(`[database-tests] gated test files missing from scripts/run-database-tests.mjs GATED (or NOT_RUN):\n  ${unregistered.join("\n  ")}`);
    process.exit(1);
  }
  const admin = process.env.DATABASE_TEST_ADMIN_URL;
  const template = process.env.DATABASE_TEST_TEMPLATE ?? "tmpl";
  const redis = process.env.REDIS_TEST_URL;
  if (!admin || !redis) {
    console.error("[database-tests] set DATABASE_TEST_ADMIN_URL and REDIS_TEST_URL");
    process.exit(1);
  }
  const filter = process.argv[2];
  const scratch = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "database-tests-"));
  const psql = (sql) => {
    const result = spawnSync("node", ["-e", `
      const { Client } = require("pg");
      const c = new Client({ connectionString: process.argv[1] });
      c.connect().then(() => c.query(process.argv[2])).then(() => c.end(), (e) => { console.error(e.message); process.exit(1); });
    `, `${admin}/postgres`, sql], { cwd: path.join(root, "server"), stdio: "inherit" });
    if (result.status !== 0) throw new Error(`psql failed: ${sql}`);
  };
  const failures = [];
  let index = 0;
  try {
    for (const [file, { db = [], redis: redisVars = [] }] of Object.entries(GATED)) {
      if (filter && !file.includes(filter)) continue;
      index += 1;
      const env = { ...process.env };
      delete env.DATABASE_URL;
      if (db.length) {
        const name = `dbtest_${index}`;
        psql(`drop database if exists ${name} with (force)`);
        psql(`create database ${name} template ${template}`);
        for (const variable of db) env[variable] = `${admin}/${name}`;
      }
      for (const variable of redisVars) env[variable] = redis;
      const pkg = file.split("/")[0];
      const report = path.join(scratch, `${index}.json`);
      const run = spawnSync("pnpm", ["exec", "vitest", "run", file.slice(pkg.length + 1), "--reporter=default", "--reporter=json", `--outputFile.json=${report}`], { cwd: path.join(root, pkg), env, stdio: "inherit" });
      let result = null;
      try { result = JSON.parse(readFileSync(report, "utf8")); } catch { /* reported below */ }
      const skipped = (result?.numPendingTests ?? 0) + (result?.numTodoTests ?? 0);
      if (run.status !== 0 || !result || result.numFailedTests > 0 || skipped > 0 || result.numPassedTests === 0) {
        failures.push(`${file}: exit ${run.status}, passed ${result?.numPassedTests ?? "?"}, failed ${result?.numFailedTests ?? "?"}, skipped ${skipped}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`[database-tests] ${failures.length} file(s) failed or skipped tests:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[database-tests] ${index} file(s) passed with no skipped tests`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
