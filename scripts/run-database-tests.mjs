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
//
// The server and worker test setups refuse a TEST_DATABASE_URL off loopback or naming a database that does not look
// disposable (packages/shared/src/test-database-guard.ts); the dbtest_<n> databases made here pass.
import { createHash } from "node:crypto";
import ts from "typescript-compiler-api";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const reviewed = JSON.parse(readFileSync(new URL("./database-discovery-reviewed.json", import.meta.url), "utf8"));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Gated files that need more than a database (fixtures, benchmarks, live services). */
export const NOT_RUN = {
  "server/src/__tests__/search-native.bench.test.ts": "benchmark: needs a qrels file and a populated corpus",
  "server/db/tests/project-cutover-roles.mjs":
    "manual migration reproducer: needs an empty database (not the migrated template) whose owner holds the cutover roles",
};

/** A database or Redis URL variable name; the runner sets only the two above. */
const GATE_NAME = /^[A-Z0-9_]*(?:DATABASE_URL|_PG_URL|REDIS_URL)$/;
const STANDARD = new Set(["DATABASE_URL", "TEST_DATABASE_URL", "TEST_REDIS_URL"]);
/** Discover static environment access through typed expressions and nested bindings. */
export function environmentReads(source) {
  const names = new Set();
  if (!/\bprocess\b/.test(source)) return names;
  let tree = ts.createSourceFile("test.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (tree.parseDiagnostics.length) {
    const plain = ts.createSourceFile("test.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (plain.parseDiagnostics.length < tree.parseDiagnostics.length) tree = plain;
  }
  const host = ts.createCompilerHost({ noLib: true, noResolve: true, types: [] });
  host.getSourceFile = name => name === "test.tsx" ? tree : undefined;
  const checker = ts.createProgram(["test.tsx"], { noLib: true, noResolve: true, types: [] }, host).getTypeChecker();
  const aliases = new Map();
  const constants = new Map();
  const symbol = node => ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
  const keyOf = node => {
    if (!node) return;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isComputedPropertyName(node)) return keyOf(node.expression);
    if (ts.isIdentifier(node)) return constants.get(symbol(node));
  };
  let final = false;
  const unknown = () => { if (final) names.add("<unresolved environment access>"); };
  const record = (parts) => {
    if (parts?.[0] === "process" && parts[1] === "env" && parts[2]) names.add(parts[2]);
    return parts;
  };
  const resolve = (node) => {
    if (!node) return;
    if (ts.isIdentifier(node)) return aliases.get(symbol(node)) ?? (node.text === "process" && !symbol(node) ? ["process"] : undefined);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return resolve(node.expression);
    const base = (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && resolve(node.expression);
    if (!base) return;
    const key = ts.isPropertyAccessExpression(node) ? node.name.text :
      keyOf(node.argumentExpression);
    if (key) return record([...base, key]);
    if (base[0] === "process" && base.length <= 2) unknown();
  };
  let changed = true;
  const bind = (name, parts) => {
    if (!parts) return;
    record(parts);
    if (parts.length > 2) return;
    if (ts.isIdentifier(name)) {
      const id = symbol(name);
      if (id && !aliases.has(id)) { aliases.set(id, parts); changed = true; }
      else if (id && aliases.get(id).join(".") !== parts.join(".")) unknown();
    } else if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (element.dotDotDotToken) { bind(element.name, parts); continue; }
        const key = element.propertyName ?? element.name;
        const property = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : keyOf(key);
        if (property) bind(element.name, [...parts, property]); else unknown();
      }
    } else if (ts.isObjectLiteralExpression(name)) {
      for (const property of name.properties) {
        if (ts.isShorthandPropertyAssignment(property)) bind(property.name, [...parts, property.name.text]);
        else if (ts.isPropertyAssignment(property)) {
          const key = ts.isIdentifier(property.name) ? property.name.text : keyOf(property.name);
          if (key) bind(property.initializer, [...parts, key]); else unknown();
        } else unknown();
      }
    } else unknown();
  };
  let passes = 0;
  while (changed || !final) {
    if (++passes > 32) { names.add("<unresolved environment access>"); break; }
    if (!changed) final = true;
    changed = false;
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && ["process", "node:process"].includes(node.moduleSpecifier.text)) {
        const clause = node.importClause;
        if (clause?.name) bind(clause.name, ["process"]);
        if (clause?.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name, ["process"]);
          else for (const item of clause.namedBindings.elements) bind(item.name, ["process", (item.propertyName ?? item.name).text]);
        }
      }
      if (ts.isVariableDeclaration(node)) {
        bind(node.name, resolve(node.initializer));
        if (ts.isIdentifier(node.name)) {
          const value = keyOf(node.initializer), id = symbol(node.name);
          if (value && id && !constants.has(id)) { constants.set(id, value); changed = true; }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        bind(node.left, resolve(node.right));
      }
      resolve(node);
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  if (tree.parseDiagnostics.length && /\bprocess\b/.test(source)) names.add("<unresolved environment access>");
  return names;
}

/** What a test file's source needs from the runner, and any gate variable it would never get. */
export function classifyTestSource(source) {
  const reads = environmentReads(source);
  const other = [...reads].filter(v => v === "<unresolved environment access>" || GATE_NAME.test(v) && !STANDARD.has(v));
  return { db: reads.has("TEST_DATABASE_URL"), redis: reads.has("TEST_REDIS_URL"), other };
}

/**
 * Test files under server/src, worker/src and packages with their needs, relative to the repo root, plus the
 * server/db/tests scripts (`script: true`). Those run through server's test:db or a vitest wrapper
 * (run-control-native.db.test.ts runs run-control-admission.mjs), never directly here, but they are scanned so a script
 * gated on a variable the runner never sets is reported too.
 */
export function scanTestFiles(dir = root) {
  const found = [];
  const walk = (current, pattern, extra) => {
    for (const name of readdirSync(current)) {
      if (name === "node_modules" || name === "dist") continue;
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full, pattern, extra);
      else if (pattern.test(name)) {
        const file = path.relative(dir, full), source = readFileSync(full, "utf8");
        const entry = classifyTestSource(source);
        // Explicit, content-pinned review of existing setup helpers. A changed or
        // new dynamic access fails closed; concrete gates are never exempted.
        if (reviewed[file]?.sha256 === createHash("sha256").update(source).digest("hex")) {
          entry.other = entry.other.filter(name => name !== "<unresolved environment access>");
        }
        found.push({ file, ...entry, ...extra });
      }
    }
  };
  for (const top of ["server/src", "worker/src", "packages"]) walk(path.join(dir, top), /\.test\.(?:[cm]?[jt]s|tsx|jsx)$/, {});
  walk(path.join(dir, "server/db/tests"), /\.(ts|mjs)$/, { script: true });
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

/** Files the runner runs: test files reading TEST_DATABASE_URL or TEST_REDIS_URL, minus NOT_RUN and scripts. */
export function gatedFiles(scanned) {
  return scanned.filter((entry) => (entry.db || entry.redis) && !entry.script && !NOT_RUN[entry.file]);
}

/** Files gated on a variable the runner never sets: they would skip unnoticed. */
export function unsupportedGatedFiles(scanned) {
  return scanned.filter((entry) => entry.other.length && !NOT_RUN[entry.file]).map((entry) => `${entry.file} (${entry.other.join(", ")})`);
}

function main() {
  const scanned = scanTestFiles();
  console.error("[database-tests] dynamic setup helpers are explicitly reviewed in scripts/database-discovery-reviewed.json; modified/unlisted unresolved syntax is refused");
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
      const pkg = file.startsWith("packages/") ? file.split("/").slice(0, 2).join("/") : file.split("/")[0];
      const report = path.join(scratch, `${index}.json`);
      const run = spawnSync("pnpm", ["exec", "vitest", "run", file.slice(pkg.length + 1), "--maxWorkers=2", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`], { cwd: path.join(root, pkg), env, stdio: "inherit" });
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
