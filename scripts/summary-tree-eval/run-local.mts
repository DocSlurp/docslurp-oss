/** Zero-provider-cost development replay over cached vectors and frozen trees.
 * A newly migrated disposable database and fresh Lance directory are removed on exit.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import postgres from "postgres";

const [cases, output] = process.argv.slice(2);
if (!cases || !output) throw new Error("Usage: run-local.mts DEVELOPMENT_CASES OUTPUT_DIR");
const tempRoot = process.env.TMPDIR;
if (!tempRoot || !process.env.SUMMARY_TREE_EVAL_ROOT) throw new Error("TMPDIR and SUMMARY_TREE_EVAL_ROOT are required");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error("Replay output directory must be empty; preserve prior attempts separately");
const adminFile = process.env.SUMMARY_TREE_EVAL_ADMIN_ENV;
const adminValue = process.env.SUMMARY_TREE_EVAL_ADMIN_URL ?? (adminFile
  ? (await readFile(adminFile, "utf8")).split("\n").find(line => line.startsWith("DATABASE_URL="))?.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "") : undefined);
if (!adminValue) throw new Error("SUMMARY_TREE_EVAL_ADMIN_URL or SUMMARY_TREE_EVAL_ADMIN_ENV is required");
const adminUrl = new URL(adminValue);
if (!["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname)) throw new Error("Replay admin database must be on loopback");
adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.href, { max: 1, prepare: false, onnotice: () => {} });
const database = `docslurp_tree_replay_${randomUUID().replaceAll("-", "")}`;
const scratch = await mkdtemp(join(tempRoot, "summary-tree-replay-"));
let created = false;
try {
  await admin`create database ${admin(database)}`;
  created = true;
  const databaseUrl = new URL(adminUrl.href);
  databaseUrl.pathname = `/${database}`;
  const treeRoot = join(process.env.SUMMARY_TREE_EVAL_ROOT!, "tree-product");
  const treeHashes = Object.fromEntries(await Promise.all((await readdir(treeRoot)).filter(name => name.endsWith(".tree.json")).sort()
    .map(async name => [name, createHash("sha256").update(await readFile(join(treeRoot, name))).digest("hex")])));
  const sourceDiffSha256 = createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "server", "worker", "packages/shared", "scripts/summary-tree-eval"])).digest("hex");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const env = { ...process.env, DATABASE_URL: databaseUrl.href,
    LANCEDB_URI: join(scratch, "lancedb"), SUMMARY_TREE_EVAL_CAP_USD: "0", SUMMARY_TREE_EVAL_OUT: resolve(output),
    SUMMARY_TREE_EVAL_TREE_DIR: "tree-product", DATABASE_POOL_MAX: "1", LIVE_MODEL_PRICES: "off" };
  const run = (script: string, args: string[]) => new Promise<void>((done, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", script, ...args], { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? done() : reject(new Error(`${script} exited ${code}`)));
  });
  await run("server/db/migrate.mjs", []);
  await run("scripts/summary-tree-eval/seed.mts", ["docs/evals/summary-tree/sources-manifest.json"]);
  await run("scripts/summary-tree-eval/arms.mts", [cases, output, "--arms", "current,summary-seed,document-order,product-guide,product-include", "--no-answers"]);
  await run("scripts/summary-tree-eval/report.mts", [output, join(output, "summary.json")]);
  await writeFile(join(output, "provenance.json"), JSON.stringify({ observedAt: new Date().toISOString(), storage: "fresh local LanceDB", database: "migrated disposable PostgreSQL", providerSpendCapUsd: 0,
    sourceCommit, sourceDiffSha256, treeHashes, treeDirectory: "tree-product", answers: false, cases: resolve(cases), productionCalibration: false }, null, 2));
} finally {
  try { if (created) await admin`drop database ${admin(database)} with (force)`; } finally {
    await admin.end();
    await rm(scratch, { recursive: true, force: true });
  }
}
