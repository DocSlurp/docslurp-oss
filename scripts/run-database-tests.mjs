#!/usr/bin/env node
// Run the env-gated real-Postgres and Redis tests against service containers, one
// fresh copy of a migrated template database per file.
//
// A test file opts in by reading TEST_DATABASE_URL and/or TEST_REDIS_URL (and skips
// without them); there is nothing to register. For each such file the runner sets
// TEST_DATABASE_URL to that file's own fresh database and TEST_REDIS_URL to the
// shared Redis. It fails on any failed or skipped test, so a test cannot quietly turn
// itself off, and on any test file gated on a different database or Redis variable
// (one the runner would never set) unless it is listed in NOT_RUN.
//
//   TEST_DATABASE_ADMIN_URL=postgres://user:pw@127.0.0.1:5432 \
//   TEST_DATABASE_TEMPLATE=tmpl TEST_REDIS_URL=redis://127.0.0.1:6379 \
//   node scripts/run-database-tests.mjs [file filter]
//
// TEST_DATABASE_ADMIN_URL is a server URL without a database name, for a role that
// can create databases; each file connects as that role, so tests that create roles
// or extra databases need it to be a superuser (CI uses the container superuser).
// The template must already be migrated: DATABASE_URL=<admin>/tmpl node server/db/migrate.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Gated files that need more than a database (fixtures, benchmarks, live services). */
export const NOT_RUN = {
  "server/src/__tests__/search-native.bench.test.ts": "benchmark: needs a qrels file and a populated corpus",
};

const DB = /(?<![A-Za-z0-9_])TEST_DATABASE_URL(?![A-Za-z0-9_])/;
const REDIS = /(?<![A-Za-z0-9_])TEST_REDIS_URL(?![A-Za-z0-9_])/;
/** Any database or Redis URL variable a test reads; the runner sets only the two above. */
const GATE = /process\.env\.([A-Z0-9_]*(?:DATABASE_URL|_PG_URL|REDIS_URL))\b/g;
const STANDARD = new Set(["DATABASE_URL", "TEST_DATABASE_URL", "TEST_REDIS_URL"]);

/** What a test file's source needs from the runner, and any gate variable it would never get. */
export function classifyTestSource(source) {
  const other = [...new Set([...source.matchAll(GATE)].map((m) => m[1]).filter((v) => !STANDARD.has(v)))];
  return { db: DB.test(source), redis: REDIS.test(source), other };
}

/** Test files under server/src, worker/src and packages with their needs, relative to the repo root. */
export function scanTestFiles(dir = root) {
  const found = [];
  for (const top of ["server/src", "worker/src", "packages"]) {
    const walk = (current) => {
      for (const name of readdirSync(current)) {
        if (name === "node_modules" || name === "dist") continue;
        const full = path.join(current, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.test\.(ts|mjs)$/.test(name)) found.push({ file: path.relative(dir, full), ...classifyTestSource(readFileSync(full, "utf8")) });
      }
    };
    walk(path.join(dir, top));
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

/** Files the runner runs: those reading TEST_DATABASE_URL or TEST_REDIS_URL, minus NOT_RUN. */
export function gatedFiles(scanned) {
  return scanned.filter((entry) => (entry.db || entry.redis) && !NOT_RUN[entry.file]);
}

/** Files gated on a variable the runner never sets: they would skip unnoticed. */
export function unsupportedGatedFiles(scanned) {
  return scanned.filter((entry) => entry.other.length && !NOT_RUN[entry.file]).map((entry) => `${entry.file} (${entry.other.join(", ")})`);
}

function main() {
  const scanned = scanTestFiles();
  const unsupported = unsupportedGatedFiles(scanned);
  if (unsupported.length) {
    console.error(`[database-tests] test files gated on a variable this runner never sets; read TEST_DATABASE_URL / TEST_REDIS_URL instead (or list the file in NOT_RUN):\n  ${unsupported.join("\n  ")}`);
    process.exit(1);
  }
  const admin = process.env.TEST_DATABASE_ADMIN_URL?.replace(/\/+$/, "");
  const template = process.env.TEST_DATABASE_TEMPLATE ?? "tmpl";
  const redis = process.env.TEST_REDIS_URL;
  if (!admin || !redis) {
    console.error("[database-tests] set TEST_DATABASE_ADMIN_URL and TEST_REDIS_URL");
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
    for (const { file, db, redis: needsRedis } of gatedFiles(scanned)) {
      if (filter && !file.includes(filter)) continue;
      index += 1;
      const env = { ...process.env };
      for (const variable of ["DATABASE_URL", "TEST_DATABASE_URL", "TEST_REDIS_URL", "TEST_DATABASE_ADMIN_URL", "TEST_DATABASE_TEMPLATE"]) delete env[variable];
      if (db) {
        const name = `dbtest_${index}`;
        psql(`drop database if exists ${name} with (force)`);
        psql(`create database ${name} template ${template}`);
        env.TEST_DATABASE_URL = `${admin}/${name}`;
      }
      if (needsRedis) env.TEST_REDIS_URL = redis;
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
  if (index === 0) {
    console.error(`[database-tests] no gated test files matched${filter ? ` "${filter}"` : ""}`);
    process.exit(1);
  }
  console.log(`[database-tests] ${index} file(s) passed with no skipped tests`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
