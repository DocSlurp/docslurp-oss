// Frozen-corpus dense-only comparison. Run under tsx with this checkout's shared source mappings.
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2), option = (key) => args[args.indexOf(key) + 1];
for (const key of ["--env-file", "--manifest", "--output"]) if (!args.includes(key)) throw new Error(`Missing ${key}`);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const require = createRequire(new URL("../../worker/package.json", import.meta.url));
const env = require("dotenv").parse(await readFile(option("--env-file")));
for (const key of ["DATABASE_URL", "DEEPINFRA_API_KEY", "OPENAI_API_KEY", "STORAGE_URI", "LANCEDB_URI", "S3_BUCKET", "AWS_ENDPOINT_URL_S3", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"]) if (env[key]) process.env[key] = env[key];
process.env.NODE_ENV = "development";
process.env.SKIP_RUN_BUDGET_GUARDS_IN_DEV = "false";
process.env.AI_PROVIDER_MAX_RETRIES = "0";
const config = JSON.parse(await readFile(option("--manifest"), "utf8"));
const output = option("--output");
try { await readFile(`${output}/state.json`); throw new Error("Existing output evidence must not be overwritten; use a new run directory"); } catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), screenId: randomUUID(), providerCapUsd: 2, priorBudgetUsd: 10, providerActualUsd: 0, arms: [], attempts: [], status: "preflight" };
const save = () => writeFile(`${output}/state.json`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
await save();
let sql;
try {
  const [{ sql: db }, { assertCanSpend, spendGuardsSkipped }, { createUsageLedger }, { attributedUsage, orgUsageTotals }, { embedConfiguredText }, { embedTextChunks }, { fromEnv }] = await Promise.all([
    import("../../server/src/db.ts"), import("../../server/src/services/billing/spend-guard.ts"), import("../../server/src/lib/ai-usage.ts"), import("../../server/src/services/usage-attribution.ts"), import("../../server/src/lib/ai.ts"), import("../../worker/src/stages/embedding-runtime.ts"), import("../../worker/src/config.ts"),
  ]);
  sql = db;
  const { embeddingInputKey, embeddingVectorFingerprint } = await import("../../worker/src/embeddings/embedding-reuse.ts");
  const { normalizePipelineFeatures, assertProviderAllowed } = await import("../../packages/shared/src/index.ts");
  if (spendGuardsSkipped()) throw new Error("Spend guards are disabled");
  const frozen = JSON.parse(await readFile(config.preflight, "utf8"));
  const queryBytes = await readFile(config.queries), queries = JSON.parse(queryBytes);
  if (hash(JSON.stringify(queries)) !== frozen.querySha256 || hash(await readFile(config.dataset)) !== frozen.datasetSha256) throw new Error("Frozen query hash mismatch");
  if (!(frozen.providerCapWith20PercentReserveUsd < report.providerCapUsd)) throw new Error("Frozen provider forecast exceeds cap");
  const documents = [];
  for (const source of config.corpora) {
    const bytes = await readFile(source.path);
    const expected = frozen.corpora.find((item) => item.documentId === source.documentId);
    if (!expected || hash(bytes) !== expected.artifactSha256) throw new Error("Frozen artifact hash mismatch");
    const artifact = JSON.parse(bytes);
    const [run] = await sql`select id,user_id,org_id,workspace_id from workspace_runs where id=${expected.runId} and user_id=${config.userId} and org_id=${config.orgId}`;
    if (!run || artifact.documentId !== source.documentId || artifact.embedding.lateChunking !== false) throw new Error("Artifact ownership or input contract mismatch");
    const originalFingerprint = artifact.reuse?.fingerprint ?? embeddingVectorFingerprint(artifact.embedding);
    for (const chunk of artifact.chunks) {
      if (chunk.vector.length !== 1536 || chunk.vector.some((value) => !Number.isFinite(value)) || !(Math.hypot(...chunk.vector) > 0) || !Number.isFinite(Math.hypot(...chunk.vector))) throw new Error("Invalid native baseline vector");
      if (!chunk.metadata?.embeddingInputKey || embeddingInputKey(chunk.text, originalFingerprint) !== chunk.metadata.embeddingInputKey) throw new Error("Frozen provider input parity mismatch");
    }
    const [workspace] = await sql`select id,pipeline from workspaces where id=${run.workspace_id} and user_id=${config.userId} and org_id=${config.orgId}`;
    if (!workspace) throw new Error("Artifact workspace ownership mismatch");
    const privacyMode = normalizePipelineFeatures(workspace.pipeline).privacyMode;
    for (const candidate of frozen.arms.filter((item) => !item.status)) assertProviderAllowed(privacyMode, { provider: candidate.provider, model: candidate.model, operation: "evaluation.embedding", target: "hosted" });
    documents.push({ ...source, runId: run.id, workspaceId: run.workspace_id, privacyMode, chunks: artifact.chunks });
  }
  const startTotals = await orgUsageTotals(config.orgId, null);
  report.startLedgerUsd = startTotals.costCents / 100;
  // Billing policy is checked from DB and exact observed event charges after each batch.
  // Since the price card (2026-10-21) provider calls bill 0 credits, so the factor is 0 and a frozen
  // forecast made under the old AI markup fails here on purpose.
  const { priceAiUsageEvent } = await import("../../packages/shared/src/billing.ts");
  const factor = priceAiUsageEvent({ provider: "deepinfra", costCents: 100, metadata: {} }).costCents / 100;
  // The frozen receipt records the actual policy multiplier used by this test org.
  if (factor !== null && factor !== config.expectedLedgerFactor) throw new Error("Billing policy differs from frozen forecast");
  report.ledgerForecastWithReserveUsd = frozen.providerCapWith20PercentReserveUsd * config.expectedLedgerFactor;
  if (report.startLedgerUsd + report.ledgerForecastWithReserveUsd >= report.priorBudgetUsd) throw new Error("Original ledger allowance exhausted");
  report.budgetReceipt = { at: new Date().toISOString(), startTotals, providerUpperBoundUsd: frozen.providerUpperBoundUsd, providerForecastWithReserveUsd: frozen.providerCapWith20PercentReserveUsd, ledgerFactor: config.expectedLedgerFactor };
  report.status = "running"; await save();
  if (args.includes("--preflight-only")) {
    report.status = "ready"; await save();
    console.log(JSON.stringify({ status: "ready", documents: documents.length, chunks: documents.reduce((sum, doc) => sum + doc.chunks.length, 0), providerForecastWithReserveUsd: frozen.providerCapWith20PercentReserveUsd, startLedgerUsd: report.startLedgerUsd, ledgerFactor: factor }));
    await sql.end({ timeout: 3 }); process.exit(0);
  }
  const workerConfig = fromEnv();
  const armSpecs = frozen.arms.filter((arm) => !arm.status);
  const queryNorm = (v) => Math.hypot(...v);
  const validate = (v, dimensions) => { if (v.length !== dimensions || v.some((n) => !Number.isFinite(n)) || !(queryNorm(v) > 0) || !Number.isFinite(queryNorm(v))) throw new Error("Provider returned invalid vector dimensions or values"); return v; };
  const scopeLedger = (workspaceId, sessionId) => createUsageLedger({ userId: config.userId, scope: { orgId: config.orgId, workspaceId, sessionId } });
  const guard = async (workspaceId, nextBytes, price, arm) => {
    const [workspace] = await sql`select id,pipeline,archived_at from workspaces where id=${workspaceId} and user_id=${config.userId} and org_id=${config.orgId}`;
    if (!workspace || workspace.archived_at) throw new Error("Artifact workspace no longer active or authorized");
    const privacyMode = normalizePipelineFeatures(workspace.pipeline).privacyMode;
    assertProviderAllowed(privacyMode, { provider: arm.provider, model: arm.model, operation: "evaluation.embedding", target: "hosted" });
    if (report.providerActualUsd + nextBytes * price / 1_000_000 > report.providerCapUsd) throw new Error("Provider next-batch ceiling exceeds hard cap");
    const total = await orgUsageTotals(config.orgId, null);
    if (total.costCents / 100 + nextBytes * price * config.expectedLedgerFactor / 1_000_000 >= report.priorBudgetUsd) throw new Error("Original next-batch ledger allowance exhausted");
    await assertCanSpend(config.orgId, workspaceId, { kind: "interactive" });
    return privacyMode;
  };
  for (const arm of armSpecs) {
    const armDir = `${output}/${arm.id}`; await mkdir(armDir, { recursive: true });
    const started = performance.now();
    const armReport = { ...arm, startedAt: new Date().toISOString(), documents: [], queries: [], providerActualUsd: 0, status: "running" };
    report.arms.push(armReport); await save();
    const price = arm.provider === "openai" ? 0.02 : 0.01;
    const docVectors = new Map();
    for (const doc of documents) {
      if (arm.documentVectors === "retained") { docVectors.set(doc.documentId, doc.chunks.map((chunk) => chunk.vector)); continue; }
      const vectors = [], batchSize = arm.provider === "openai" ? 256 : 64;
      const sessionId = `embedding-screen-${report.screenId}-${arm.id}-${doc.documentId}`;
      const ledger = scopeLedger(doc.workspaceId, sessionId);
      for (let offset = 0; offset < doc.chunks.length; offset += batchSize) {
        const chunks = doc.chunks.slice(offset, offset + batchSize), values = chunks.map((chunk) => chunk.text);
        const byteBound = values.reduce((total, value) => total + Buffer.byteLength(value) + 2, 0);
        const privacyMode = await guard(doc.workspaceId, byteBound, price, arm);
        const attempt = { arm: arm.id, kind: "document", documentId: doc.documentId, offset, chunks: chunks.length, inputSha256: hash(JSON.stringify(values)), inputTokenUpperBound: byteBound, provider: arm.provider, model: arm.model, workspaceId: doc.workspaceId, sessionId, status: "started", startedAt: new Date().toISOString() };
        report.attempts.push(attempt); await save();
        const profile = { profile: "cheapest-hosted", target: "hosted", modelUri: `llm://${arm.provider}/${arm.model}`, runtime: "remote", provider: arm.provider, model: arm.model, baseUrl: arm.provider === "deepinfra" ? "https://api.deepinfra.com/v1/openai" : null, dimensions: arm.dimensions, task: "document", normalize: true, batchSize, lateChunking: false, lateChunkingWindow: 2, supportsCustomDimensions: arm.provider === "openai" };
        let usageCallbacks = 0;
        const result = await embedTextChunks({ chunks: values, profile, config: workerConfig, privacyMode, batchConcurrency: 1, onRemoteUsage: async ({ inputTokens }) => {
          if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) throw new Error("Actual usage missing");
          usageCallbacks++;
          ledger.record({ provider: arm.provider, model: arm.model, metric: "embedding-tokens", inputTokens, logOutputTokens: false, metadata: { experiment: "frozen-dense-embedding-screen", screenId: report.screenId, arm: arm.id, documentId: doc.documentId, offset, sourceRunId: doc.runId, inputSha256: attempt.inputSha256, dimensions: arm.dimensions, usageSource: "provider" } });
          const written = await ledger.flush();
          if (written.length !== 1) throw new Error("Actual document usage persistence missing");
          const cost = inputTokens * price / 1_000_000;
          report.providerActualUsd += cost; armReport.providerActualUsd += cost;
          Object.assign(attempt, { actualInputTokens: inputTokens, providerActualUsd: cost, usageEventIds: written.map((event) => event.id), persisted: true });
          await save();
          if (report.providerActualUsd > report.providerCapUsd || inputTokens > byteBound) throw new Error("Actual usage exceeds frozen batch ceiling");
        } });
        if (usageCallbacks !== 1 || result.vectors.length !== chunks.length) throw new Error("Batch usage or vector count missing");
        for (const vector of result.vectors) vectors.push(validate(vector, arm.dimensions));
        const batchFile = `${armDir}/${doc.documentId}-${offset}.json`;
        await writeFile(batchFile, JSON.stringify({ vectors: result.vectors, usage: result.usage, inputSha256: attempt.inputSha256 }), { mode: 0o600 });
        Object.assign(attempt, { status: "success", finishedAt: new Date().toISOString(), responseSha256: hash(await readFile(batchFile)) });
        await save();
        if (offset % (batchSize * 10) === 0) console.log(JSON.stringify({ arm: arm.id, documentId: doc.documentId, completed: offset + chunks.length, total: doc.chunks.length, providerActualUsd: report.providerActualUsd }));
      }
      docVectors.set(doc.documentId, vectors);
      armReport.documents.push({ documentId: doc.documentId, vectors: vectors.length, dimensions: arm.dimensions });
    }
    for (const query of queries) {
      const targetDocs = query.documentIds?.length ? documents.filter((doc) => query.documentIds.includes(doc.documentId)) : documents;
      if (!targetDocs.length) throw new Error("Frozen query has no matching corpus");
      const workspaceId = targetDocs[0].workspaceId, sessionId = `embedding-screen-${report.screenId}-${arm.id}-query-${query.id}`;
      const ledger = scopeLedger(workspaceId, sessionId), byteBound = Buffer.byteLength(query.question) + 2;
      let privacyMode;
      for (const doc of targetDocs) privacyMode = await guard(doc.workspaceId, byteBound, price, arm);
      const qstart = performance.now(), attempt = { arm: arm.id, kind: "query", id: query.id, status: "started", startedAt: new Date().toISOString(), inputTokenUpperBound: byteBound, provider: arm.provider, model: arm.model, workspaceId, sessionId };
      report.attempts.push(attempt); await save();
      let recorded = false;
      const recordQuery = async ({ inputTokens }) => {
        if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) throw new Error("Actual query usage missing");
        ledger.record({ provider: arm.provider, model: arm.model, metric: "embed-query", inputTokens, logOutputTokens: false, metadata: { experiment: "frozen-dense-embedding-screen", screenId: report.screenId, arm: arm.id, queryId: query.id, dimensions: arm.dimensions, usageSource: "provider" } });
        const written = await ledger.flush();
        if (written.length !== 1) throw new Error("Actual query usage persistence missing");
        const cost = inputTokens * price / 1_000_000;
        report.providerActualUsd += cost; armReport.providerActualUsd += cost; recorded = true;
        Object.assign(attempt, { actualInputTokens: inputTokens, providerActualUsd: cost, usageEventIds: written.map((event) => event.id), persisted: true });
        await save();
        if (report.providerActualUsd > report.providerCapUsd || inputTokens > byteBound) throw new Error("Actual query usage exceeds ceiling");
      };
      const result = await embedConfiguredText({ value: query.question, runtime: "remote", provider: arm.provider, model: arm.model, dimensions: arm.dimensions, maxRetries: 0, normalize: true, apiKey: arm.provider === "openai" ? process.env.OPENAI_API_KEY : process.env.DEEPINFRA_API_KEY, privacyMode, ...(arm.provider === "deepinfra" ? { onUsage: recordQuery } : {}) });
      if (!recorded) await recordQuery(result.usage);
      const vector = validate(result.embedding, arm.dimensions), norm = queryNorm(vector), hits = [];
      for (const doc of targetDocs) {
        const vectors = docVectors.get(doc.documentId);
        for (let index = 0; index < vectors.length; index++) {
          const candidate = vectors[index]; let dot = 0, squared = 0;
          for (let dim = 0; dim < vector.length; dim++) { dot += vector[dim] * candidate[dim]; squared += candidate[dim] * candidate[dim]; }
          const chunk = doc.chunks[index];
          hits.push({ id: chunk.id, documentId: doc.documentId, chunkIndex: chunk.index, pageNumber: chunk.pageNumber, pageNumbers: chunk.pageNumbers, metadata: { sourceTrace: chunk.metadata?.sourceTrace }, text: chunk.text, score: dot / (norm * Math.sqrt(squared)) });
        }
      }
      hits.sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId) || a.chunkIndex - b.chunkIndex);
      const elapsedMs = performance.now() - qstart;
      const response = { queryId: query.id, arm: arm.id, sessionId, dimensions: vector.length, queryVectorSha256: hash(JSON.stringify(vector)), latencyMs: elapsedMs, hits: hits.slice(0, 10) };
      await writeFile(`${armDir}/query-${query.id}.json`, JSON.stringify(response), { mode: 0o600 });
      Object.assign(attempt, { status: "success", finishedAt: new Date().toISOString(), latencyMs: elapsedMs });
      armReport.queries.push({ id: query.id, latencyMs: elapsedMs, hits: Math.min(hits.length, 10) }); await save();
    }
    armReport.status = "success"; armReport.elapsedMs = performance.now() - started; await save();
    console.log(JSON.stringify({ arm: arm.id, status: "success", queries: armReport.queries.length, providerActualUsd: report.providerActualUsd }));
  }
  const rows = await sql`select id,provider,model,metric,input_tokens,output_tokens,cost_cents,workspace_id,metadata from ${attributedUsage(null)} au where au.org_id=${config.orgId} and au.user_id=${config.userId} and au.metadata ->> 'screenId'=${report.screenId}`;
  report.persistedEvents = rows.map(({ metadata, ...row }) => ({ ...row, arm: metadata.arm, sessionId: metadata.sessionId, usageSource: metadata.usageSource }));
  report.customerLedgerUsd = rows.reduce((total, row) => total + Number(row.cost_cents) / 100, 0);
  const completedAttempts = report.attempts.filter((attempt) => attempt.status === "success");
  if (rows.length !== completedAttempts.length) throw new Error("Final persisted event readback count mismatch");
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const attempt of completedAttempts) {
    if (attempt.usageEventIds?.length !== 1) throw new Error("Final persisted event identity missing");
    const row = byId.get(attempt.usageEventIds[0]);
    if (!row || row.provider !== attempt.provider || row.model !== attempt.model || row.workspace_id !== attempt.workspaceId || Number(row.input_tokens) !== attempt.actualInputTokens || Number(row.output_tokens) !== 0 || row.metadata.sessionId !== attempt.sessionId || row.metadata.arm !== attempt.arm) throw new Error("Final persisted event identity or token mismatch");
    if (Math.abs(Number(row.cost_cents) / 100 - attempt.providerActualUsd * config.expectedLedgerFactor) > 1e-12) throw new Error("Final persisted event charge mismatch");
  }
  report.status = "success"; report.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, screenId: report.screenId, providerActualUsd: report.providerActualUsd, customerLedgerUsd: report.customerLedgerUsd, arms: report.arms.map((arm) => ({ id: arm.id, status: arm.status, queries: arm.queries.length })) }));
} catch (error) {
  report.status = "failed";
  const active = report.attempts.findLast((attempt) => attempt.status === "started");
  if (active) Object.assign(active, { status: "failed", finishedAt: new Date().toISOString(), errorType: error?.name ?? "Error", httpStatus: error?.statusCode ?? null, costStatus: active.persisted ? "actual-usage-persisted" : "unknown-no-provider-usage-returned" });
  report.failure = { type: error?.name ?? "Error", code: typeof error?.code === "string" && /^[A-Z_0-9]+$/.test(error.code) ? error.code : null, message: /^(Frozen|Artifact|Invalid native|Spend guards|Original|Provider|Actual|Batch|Billing policy|Final persisted)/.test(error?.message ?? "") ? error.message : "Application experiment failure; details redacted" };
  await save(); console.log(JSON.stringify({ status: report.status, failure: report.failure, providerActualUsd: report.providerActualUsd })); process.exitCode = 1;
} finally { if (sql) await sql.end({ timeout: 3 }); }
