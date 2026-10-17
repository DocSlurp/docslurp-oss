// Run with tsx and a tsconfig mapping @docslurp/shared to this checkout's source.
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
for (const flag of ["--env-file", "--workspace", "--user", "--output"]) if (!args.includes(flag)) throw new Error(`Missing ${flag}`);
const require = createRequire(new URL("../../worker/package.json", import.meta.url));
const { parse } = require("dotenv");
const source = parse(await readFile(option("--env-file")));
for (const key of ["DATABASE_URL", "DEEPINFRA_API_KEY"]) {
  if (!source[key]) throw new Error(`${key} is required`);
  process.env[key] = source[key];
}
for (const key of ["STORAGE_URI", "LANCEDB_URI", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "METRICS_SECRET", "BETTER_AUTH_SECRET", "CREDENTIALS_ENCRYPTION_KEY", "SECRETS_ENCRYPTION_KEY"]) if (source[key]) process.env[key] = source[key];
// Local harness startup does not need unrelated production authentication secrets.
// Spend protection stays explicitly enabled and is checked before any request.
process.env.NODE_ENV = "development";
process.env.AI_PROVIDER_MAX_RETRIES = "0";
process.env.SKIP_RUN_BUDGET_GUARDS_IN_DEV = "false";
const sessionId = `embedding-smoke-${randomUUID()}`;
const report = { startedAt: new Date().toISOString(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sessionId, providerLimitUsd: 0.02, route: { provider: "deepinfra", model: "BAAI/bge-m3", baseUrl: "https://api.deepinfra.com/v1/openai", dimensions: 1024, normalization: "L2", documentTask: "unprefixed-text", queryTask: "unprefixed-text" }, attempts: [], persistedUsage: [], providerActualUsd: 0 };
const save = () => writeFile(option("--output"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
await save();
let sql;
try {
  const [{ sql: db }, { assertCanSpend, spendGuardsSkipped }, { createUsageLedger }, { attributedUsage }, { embedConfiguredText }, { embedTextChunks }, { fromEnv }] = await Promise.all([
    import("../../server/src/db.ts"), import("../../server/src/services/billing/spend-guard.ts"), import("../../server/src/lib/ai-usage.ts"), import("../../server/src/services/usage-attribution.ts"), import("../../server/src/lib/ai.ts"), import("../../worker/src/stages/embedding-runtime.ts"), import("../../worker/src/config.ts"),
  ]);
  sql = db;
  const workspaceId = option("--workspace"), userId = option("--user");
  const [workspace] = await sql`select id, org_id, user_id from workspaces where id = ${workspaceId} and user_id = ${userId}`;
  if (!workspace?.org_id) throw new Error("Verified owned workspace with organization required");
  if (spendGuardsSkipped()) throw new Error("Spend guards must be active");
  const scope = { orgId: workspace.org_id, workspaceId, sessionId };
  report.scope = { ...scope, userId };
  const ledger = createUsageLedger({ userId, scope });
  const record = async (metric, inputTokens, kind) => {
    ledger.record({ provider: "deepinfra", model: "BAAI/bge-m3", metric, inputTokens, logOutputTokens: false, metadata: { experiment: "synthetic-route-smoke", kind, usageSource: "provider", providerInputUsdPerMTok: 0.01 } });
    await ledger.flush();
    report.providerActualUsd += inputTokens * 0.01 / 1_000_000;
    await save();
    if (report.providerActualUsd >= report.providerLimitUsd) throw new Error("Provider smoke cap reached");
  };
  const describe = (vector) => ({ dimensions: vector.length, finite: vector.every(Number.isFinite), norm: Math.hypot(...vector), vectorSha256: createHash("sha256").update(JSON.stringify(vector)).digest("hex") });
  const document = "A sample equipment guide says the blue sensor uses two replaceable batteries.";
  const query = "How many batteries does the blue sensor use?";
  if (document.length + query.length > 512) throw new Error("Synthetic smoke input bound exceeded");
  for (const kind of ["document", "query"]) {
    await assertCanSpend(scope.orgId, workspaceId, { kind: "interactive" });
    const attempt = { kind, startedAt: new Date().toISOString(), status: "started", inputCharacters: (kind === "document" ? document : query).length };
    report.attempts.push(attempt); await save();
    try {
      let vector;
      if (kind === "document") {
        const profile = { profile: "cheapest-hosted", target: "hosted", modelUri: "llm://deepinfra/BAAI/bge-m3", runtime: "remote", provider: "deepinfra", model: "BAAI/bge-m3", baseUrl: report.route.baseUrl, dimensions: 1024, task: "document", normalize: true, batchSize: 1, lateChunking: false, lateChunkingWindow: 2 };
        const result = await embedTextChunks({ chunks: [document], profile, config: fromEnv(), privacyMode: "standard", batchConcurrency: 1, onRemoteUsage: async ({ inputTokens }) => { attempt.actualInputTokens = inputTokens; await record("embedding-tokens", inputTokens, kind); } });
        vector = result.vectors[0];
      } else {
        const result = await embedConfiguredText({ value: query, runtime: "remote", provider: "deepinfra", model: "BAAI/bge-m3", dimensions: 1024, normalize: true, apiKey: process.env.DEEPINFRA_API_KEY, privacyMode: "standard", onUsage: async ({ inputTokens }) => { attempt.actualInputTokens = inputTokens; await record("embed-query", inputTokens, kind); } });
        vector = result.embedding;
      }
      Object.assign(attempt, { status: "success", finishedAt: new Date().toISOString(), vector: describe(vector) });
    } catch (error) {
      Object.assign(attempt, { status: "failed", finishedAt: new Date().toISOString(), errorType: error?.name ?? "Error", httpStatus: error?.statusCode ?? null, actualInputTokens: attempt.actualInputTokens ?? null, costStatus: attempt.actualInputTokens === undefined ? "unknown-no-provider-usage-returned" : "persisted-provider-token-usage" });
      await save(); throw new Error(`Synthetic ${kind} embedding failed; sanitized evidence retained`);
    }
    await save();
  }
  const rows = await sql`select id, provider, model, metric, input_tokens, output_tokens, cost_cents, org_id, workspace_id, metadata from ${attributedUsage(null)} au where au.metadata ->> 'sessionId' = ${sessionId}`;
  report.persistedUsage = rows.map(({ metadata, ...row }) => ({ ...row, usageSource: metadata.usageSource, sessionId: metadata.sessionId }));
  if (rows.length !== 2 || rows.some((row) => row.provider !== "deepinfra" || row.model !== "BAAI/bge-m3" || row.org_id !== scope.orgId || row.workspace_id !== workspaceId || !(row.input_tokens > 0))) throw new Error("Scoped persisted usage readback failed");
  report.customerLedgerUsd = rows.reduce((total, row) => total + Number(row.cost_cents) / 100, 0);
  report.completedAt = new Date().toISOString(); report.status = "success";
  await save(); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "failed"; report.failure = { type: error?.name ?? "Error", code: typeof error?.code === "string" && /^[A-Z_0-9]+$/.test(error.code) ? error.code : null, frames: typeof error?.stack === "string" ? error.stack.split("\n").slice(1, 3).map((line) => line.trim()) : [], message: /^(?:[A-Z_ ]+ (?:is required|must be a strong)|Verified owned|Spend guards|Provider smoke|Synthetic|Scoped persisted|Cannot find package|Cannot find module|Unknown file extension)/.test(error?.message ?? "") ? error.message : "Application smoke prerequisite or provider failure; details redacted" };
  await save(); console.log(JSON.stringify({ status: report.status, failure: report.failure, attempts: report.attempts.length, providerActualUsd: report.providerActualUsd })); process.exitCode = 1;
} finally { if (sql) await sql.end({ timeout: 3 }); }
