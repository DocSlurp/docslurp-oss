// Analysis for the end-to-end router benchmark. Reads the ledger (usage_events via usage_attribution),
// performance_log, stage states, S3 artifacts, local OTLP traces and harness samples. Applies the
// pre-declared policy C (policy-c.json) offline. Orchestration only.
// Usage (from core root): node performance/router-e2e-2026-10-21/analyze.mjs <run-dir> <tag> <summary-out.json>
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const require = createRequire(new URL("../../worker/package.json", import.meta.url));
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const postgres = createRequire(new URL("../../server/package.json", import.meta.url))("postgres");
const [runDir, tag, summaryOut] = process.argv.slice(2);
const raw = path.join(runDir, `raw-${tag}`);
const env = Object.fromEntries(readFileSync(path.join(runDir, "env/base.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const sql = postgres(env.DATABASE_URL, { max: 4, onnotice: () => {} });
const s3 = new S3Client({ endpoint: env.AWS_ENDPOINT_URL_S3, region: "us-west-2", forcePathStyle: true, credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } });
const bucket = "docslurp-files";
const corpus = JSON.parse(readFileSync(path.join(runDir, "corpus/corpus.json"), "utf8"));
const byFile = new Map(corpus.items.map((i) => [i.file, i]));
const policy = JSON.parse(readFileSync(new URL("./policy-c.json", import.meta.url), "utf8"));

// ---------- helpers ----------
const quant = (xs, q) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; const i = (s.length - 1) * q; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const dist = (xs) => { const v = xs.filter((x) => Number.isFinite(x)); return { n: v.length, mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null, p50: quant(v, 0.5), p95: quant(v, 0.95), max: v.length ? Math.max(...v) : null, min: v.length ? Math.min(...v) : null, sum: v.reduce((a, b) => a + b, 0) }; };
const hist = (xs, edges) => edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: xs.filter((x) => x >= lo && (i === edges.length - 2 ? x <= edges[i + 1] : x < edges[i + 1])).length }));
const tokens = (t) => (t ?? "").normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const f1 = (a, b) => {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length && !tb.length) return 1; if (!ta.length || !tb.length) return 0;
  const ca = new Map(); for (const t of ta) ca.set(t, (ca.get(t) ?? 0) + 1);
  let hit = 0; for (const t of tb) { const n = ca.get(t); if (n) { hit++; ca.set(t, n - 1); } }
  const p = hit / tb.length, r = hit / ta.length; return p + r ? (2 * p * r) / (p + r) : 0;
};
async function getText(key) { try { const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return await r.Body.transformToString(); } catch { return null; } }
async function getJson(key) { const t = await getText(key); return t ? JSON.parse(t) : null; }
const keyOf = (uri) => uri?.startsWith(`s3://${bucket}/`) ? uri.slice(`s3://${bucket}/`.length) : null;
async function listPrefix(prefix) {
  let token, count = 0, bytes = 0, rasters = 0, rasterBytes = 0;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) { count++; bytes += o.Size; if (/\/images\/.+\.(png|jpe?g|webp)$/.test(o.Key)) { rasters++; rasterBytes += o.Size; } }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return { objects: count, bytes, rasterObjects: rasters, rasterBytes };
}
function referencePages(item) {
  if (!item.reference || !existsSync(item.reference)) return null;
  const r = JSON.parse(readFileSync(item.reference, "utf8"));
  if (Array.isArray(r.pages)) return new Map(r.pages.map((p) => [p.page, p.markdown ?? p.liveMarkdown ?? ""]));
  const text = typeof r.expectedMarkdown === "string" ? r.expectedMarkdown : r.text;
  return typeof text === "string" ? new Map([[1, text]]) : null;
}
function nativePages(md, pageCount) {
  if (md == null) return new Map();
  if (pageCount === 1) return new Map([[1, md]]);
  const ff = md.split("\f");
  if (ff.length === pageCount) return new Map(ff.map((t, i) => [i + 1, t]));
  return new Map(); // no reliable page boundary: native page text unavailable (C cannot qualify)
}

// ---------- OTLP traces: S3 operations per run ----------
const s3ByRun = new Map();
const tracesFile = path.join(runDir, "otel/traces.jsonl");
if (existsSync(tracesFile)) {
  for (const line of readFileSync(tracesFile, "utf8").split("\n")) {
    if (!line) continue;
    for (const rs of JSON.parse(line).resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) {
      if (!s.name.startsWith("s3.") || s.name.endsWith(".attempt")) continue;
      const a = Object.fromEntries((s.attributes ?? []).map((x) => [x.key, Object.values(x.value ?? {})[0]]));
      const run = a["docslurp.runId"]; if (!run) continue;
      const r = s3ByRun.get(run) ?? { ops: {}, getBytes: 0 };
      const op = s.name.slice(3); r.ops[op] = (r.ops[op] ?? 0) + 1;
      if (op === "GetObject") r.getBytes += Number(a["http.response.body.size"] ?? 0);
      s3ByRun.set(run, r);
    }
  }
}

// ---------- per document ----------
const samples = readFileSync(path.join(raw, "samples.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((s) => !s.warmup);
const docs = [];
for (const s of samples) {
  const item = byFile.get(s.file);
  const [doc] = await sql`select id, user_id, page_count, status from documents where run_id = ${s.runId ?? ""} limit 1`;
  const usage = await sql`select provider, model, metric, metadata->>'role' as role, (metadata->>'pageNumber')::int as page, input_tokens::float8 as input, output_tokens::float8 as output, cost_cents::float8 as cents,
    coalesce((metadata->>'providerCostCents')::float8, cost_cents::float8) as provider_cents, metadata->>'costSource' as cost_source, metadata->>'serviceElapsedMs' as service_ms
    from usage_attribution where source_run_id = ${s.runId ?? ""}`;
  const perf = await sql`select stage_name, metric, scope, page_number, value::float8 as value, metadata from performance_log where run_id = ${s.runId ?? ""}`;
  // Runs before 1aece870 stored worker metadata as a JSON-encoded string inside jsonb.
  for (const p of perf) if (typeof p.metadata === "string") p.metadata = JSON.parse(p.metadata);
  const states = await sql`select stage_name, artifact_uri, stats from document_run_stage_states where run_id = ${s.runId ?? ""}`;
  const stage = Object.fromEntries(states.map((r) => [r.stage_name, r]));
  const stageMs = Object.fromEntries(perf.filter((p) => p.metric === "stage-duration" && p.scope === "run").map((p) => [p.stage_name, p.value]));
  const pdftoppm = perf.filter((p) => p.metric === "command-duration" && p.metadata?.binary === "pdftoppm");
  const tesseract = perf.filter((p) => p.metric === "command-duration" && /tesseract|ocr/i.test(p.metadata?.binary ?? ""));
  const routeTiming = perf.find((p) => p.metric === "page-route-timing")?.metadata ?? null;
  const layoutDoc = perf.find((p) => p.metric === "page-route-layout" && p.scope === "document")?.metadata ?? null;
  const prefix = doc ? `${doc.user_id}/${s.runId}/` : null;
  const stored = prefix ? await listPrefix(prefix) : null;
  const vision = keyOf(stage["vision-extract"]?.artifact_uri) ? await getJson(keyOf(stage["vision-extract"].artifact_uri)) : null;
  const layout = s.arm === "B" && doc ? await getJson(`${doc.user_id}/${s.runId}/page-route-layout-shadow/${doc.id}.json`) : null;
  const plan = keyOf(stage["route-pages"]?.artifact_uri) ? await getJson(keyOf(stage["route-pages"].artifact_uri)) : null;
  const mdKey = keyOf(stage["extract-markdown"]?.artifact_uri);
  const native = nativePages(mdKey && mdKey.endsWith(".md") ? await getText(mdKey) : null, doc?.page_count ?? item?.pages ?? 1);
  const paid = usage.filter((u) => u.provider !== "local" && u.provider !== "local-compute" && u.provider !== "docslurp");
  const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  const group = (rows) => { const g = {}; for (const u of rows) { const k = `${u.provider}/${u.model}/${u.metric}${u.role ? `:${u.role}` : ""}`; const e = (g[k] ??= { calls: 0, input: 0, output: 0, customerCents: 0, providerCents: 0, costSources: new Set() }); e.calls++; e.input += u.input ?? 0; e.output += u.output ?? 0; e.customerCents += u.cents ?? 0; e.providerCents += u.provider_cents ?? 0; if (u.cost_source) e.costSources.add(u.cost_source); } for (const v of Object.values(g)) v.costSources = [...v.costSources]; return g; };
  docs.push({
    arm: s.arm, block: s.block, file: s.file, kind: s.kind, source: s.source, pages: doc?.page_count ?? s.pages, runId: s.runId, documentId: doc?.id, status: s.status ?? "upload-error", error: s.error, timedOut: s.timedOut,
    wallMs: s.wallMs, serverRunMs: s.runCreatedAt && s.runUpdatedAt ? new Date(s.runUpdatedAt) - new Date(s.runCreatedAt) : null,
    workerCpuSec: s.workerCpuSec, layoutCpuSec: s.layoutCpuSec, peakWorkerRssKb: s.peakWorkerRssKb, peakLayoutRssKb: s.peakLayoutRssKb,
    stageMs, routeTiming, layoutSummary: layoutDoc,
    usage: group(usage.filter((u) => u.provider !== "local-compute")),
    paidCalls: paid.length, inputTokens: sum(paid, "input"), outputTokens: sum(paid, "output"), customerCents: sum(paid, "cents"), providerCents: sum(paid, "provider_cents"),
    vlmPageCalls: usage.filter((u) => u.metric === "page-analysis").length, ocrCommands: tesseract.length,
    decisionCalls: usage.filter((u) => u.metric?.startsWith("page-route-decision")).length,
    layoutRequests: usage.filter((u) => u.metric === "layout-shadow").length, layoutFailed: usage.filter((u) => u.metric === "layout-shadow-failed-observation").length,
    layoutServiceMs: usage.filter((u) => u.metric === "layout-shadow").map((u) => Number(u.service_ms)).filter(Number.isFinite),
    pdftoppmRenders: pdftoppm.length, renderImages: stage["render-images"]?.stats ?? null, visionSelectedPages: vision?.selectedPages ?? [],
    s3: s3ByRun.get(s.runId) ?? { ops: {}, getBytes: 0 }, stored,
    visionPages: (vision?.pagesDetail ?? []).map((p) => ({ page: p.pageNumber, text: p.text, input: p.inputTokens, output: p.outputTokens, latencyMs: p.latencyMs })),
    nativePages: Object.fromEntries(native), layoutRows: layout?.pages ?? [], planAssignments: plan?.assignments?.length ?? null, planRejected: plan?.rejected ?? [], planAttention: plan?.attention ?? [],
    reference: referencePages(item ?? {}),
  });
}

// ---------- per-arm aggregates ----------
const arms = {};
for (const arm of ["A", "B"]) {
  const d = docs.filter((x) => x.arm === arm);
  const pages = d.reduce((n, x) => n + (x.pages ?? 0), 0);
  const ok = d.filter((x) => x.status === "completed");
  const wallMin = d.reduce((n, x) => n + x.wallMs, 0) / 60000;
  const providerUsd = d.reduce((n, x) => n + x.providerCents, 0) / 100;
  const customerUsd = d.reduce((n, x) => n + x.customerCents, 0) / 100;
  const usage = {};
  for (const x of d) for (const [k, v] of Object.entries(x.usage)) { const e = (usage[k] ??= { calls: 0, input: 0, output: 0, customerCents: 0, providerCents: 0, costSources: [] }); e.calls += v.calls; e.input += v.input; e.output += v.output; e.customerCents += v.customerCents; e.providerCents += v.providerCents; e.costSources = [...new Set([...e.costSources, ...v.costSources])]; }
  const stages = {};
  for (const x of d) for (const [k, v] of Object.entries(x.stageMs)) (stages[k] ??= []).push(v);
  const s3ops = {}; let getBytes = 0;
  for (const x of d) { for (const [k, v] of Object.entries(x.s3.ops)) s3ops[k] = (s3ops[k] ?? 0) + v; getBytes += x.s3.getBytes; }
  const ppm = pages / wallMin;
  const nativeAccepted = d.reduce((n, x) => n + Math.max(0, (x.pages ?? 0) - x.vlmPageCalls - x.ocrCommands), 0);
  arms[arm] = {
    documents: d.length, pages, completed: ok.length, failed: d.filter((x) => x.status === "failed").length, timedOut: d.filter((x) => x.timedOut).length, uploadErrors: d.filter((x) => x.error).length,
    extractionCalls: { nativeAcceptedPages: nativeAccepted, vlmPageCalls: d.reduce((n, x) => n + x.vlmPageCalls, 0), localOcrCommands: d.reduce((n, x) => n + x.ocrCommands, 0), decisionModelCalls: d.reduce((n, x) => n + x.decisionCalls, 0), layoutRequests: d.reduce((n, x) => n + x.layoutRequests, 0), layoutFailedObservations: d.reduce((n, x) => n + x.layoutFailed, 0) },
    paid: { calls: d.reduce((n, x) => n + x.paidCalls, 0), inputTokens: d.reduce((n, x) => n + x.inputTokens, 0), outputTokens: d.reduce((n, x) => n + x.outputTokens, 0), providerUsd, customerUsd },
    usageByModel: usage,
    latency: { endToEndWallMs: dist(d.map((x) => x.wallMs)), serverRunMs: dist(d.map((x) => x.serverRunMs)), stageMs: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, dist(v)])),
      routePagesLayoutShadowMs: dist(d.map((x) => x.routeTiming?.layoutShadowMs).filter((v) => v !== undefined)) },
    throughput: { pagesPerMinuteSequential: ppm, timeToIngest100PagesMin: 100 / ppm, pagesPerUsdProvider: providerUsd ? pages / providerUsd : null, pagesPerUsdCustomer: customerUsd ? pages / customerUsd : null,
      basis: "Sequential single-document submissions on one local worker (docConcurrency 4 available, 1 document in flight); runtime = client wall time upload->completed; cost = paid provider calls only (local CPU and storage not priced)." },
    storage: { tracedS3Ops: s3ops, tracedGetBytes: getBytes, storedObjects: d.reduce((n, x) => n + (x.stored?.objects ?? 0), 0), storedBytes: d.reduce((n, x) => n + (x.stored?.bytes ?? 0), 0), storedRasterObjects: d.reduce((n, x) => n + (x.stored?.rasterObjects ?? 0), 0), storedRasterBytes: d.reduce((n, x) => n + (x.stored?.rasterBytes ?? 0), 0),
      note: "Ops counted from worker/API OTLP spans tagged with docslurp.runId (instrumented S3 client). LanceDB's native S3 traffic is not instrumented and is excluded. Stored = objects under the run prefix at the end (overwrites counted once)." },
    rasters: { pdftoppmRenders: d.reduce((n, x) => n + x.pdftoppmRenders, 0), renderImagesRendered: d.reduce((n, x) => n + (x.renderImages?.renderedPages ?? 0), 0), renderImagesReused: d.reduce((n, x) => n + (x.renderImages?.reusedPages ?? 0), 0) },
    resources: { workerCpuSecPerDoc: dist(d.map((x) => x.workerCpuSec)), layoutCpuSecPerDoc: dist(d.map((x) => x.layoutCpuSec)), workerCpuSecTotal: d.reduce((n, x) => n + (x.workerCpuSec ?? 0), 0), layoutCpuSecTotal: d.reduce((n, x) => n + (x.layoutCpuSec ?? 0), 0),
      peakWorkerRssMb: Math.max(...d.map((x) => x.peakWorkerRssKb ?? 0)) / 1024, peakLayoutRssMb: Math.max(...d.map((x) => x.peakLayoutRssKb ?? 0)) / 1024 },
    histograms: { endToEndWallMs: hist(d.map((x) => x.wallMs), [0, 2000, 4000, 6000, 8000, 10000, 15000, 20000, 40000, 1e9]), providerCentsPerDoc: hist(d.map((x) => x.providerCents), [0, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 1e9]) },
    byKind: Object.fromEntries([...new Set(d.map((x) => x.kind))].map((k) => { const g = d.filter((x) => x.kind === k); return [k, { documents: g.length, pages: g.reduce((n, x) => n + x.pages, 0), vlmPageCalls: g.reduce((n, x) => n + x.vlmPageCalls, 0), providerUsd: g.reduce((n, x) => n + x.providerCents, 0) / 100, wallMsP50: quant(g.map((x) => x.wallMs), 0.5), wallMsP95: quant(g.map((x) => x.wallMs), 0.95) }]; })),
  };
}

// ---------- paired shadow overhead ----------
const pair = new Map();
for (const x of docs) { const p = pair.get(x.file) ?? {}; p[x.arm] = x; pair.set(x.file, p); }
const pairs = [...pair.values()].filter((p) => p.A && p.B && p.A.status === "completed" && p.B.status === "completed");
const routeStage = (x) => x.stageMs["route-pages"];
const overhead = {
  pairs: pairs.length,
  wallMsDelta: dist(pairs.map((p) => p.B.wallMs - p.A.wallMs)),
  routePagesStageMsDelta: dist(pairs.map((p) => routeStage(p.B) - routeStage(p.A)).filter(Number.isFinite)),
  renderImagesStageMsDelta: dist(pairs.map((p) => p.B.stageMs["render-images"] - p.A.stageMs["render-images"]).filter(Number.isFinite)),
  workerCpuSecDelta: dist(pairs.map((p) => p.B.workerCpuSec - p.A.workerCpuSec)),
  pdftoppmRendersDelta: pairs.reduce((n, p) => n + p.B.pdftoppmRenders - p.A.pdftoppmRenders, 0),
  storedRasterObjectsDelta: pairs.reduce((n, p) => n + (p.B.stored?.rasterObjects ?? 0) - (p.A.stored?.rasterObjects ?? 0), 0),
  storedBytesDelta: pairs.reduce((n, p) => n + (p.B.stored?.bytes ?? 0) - (p.A.stored?.bytes ?? 0), 0),
  s3PutDelta: pairs.reduce((n, p) => n + (p.B.s3.ops.PutObject ?? 0) - (p.A.s3.ops.PutObject ?? 0), 0),
  s3GetDelta: pairs.reduce((n, p) => n + (p.B.s3.ops.GetObject ?? 0) - (p.A.s3.ops.GetObject ?? 0), 0),
  vlmCallsDelta: pairs.reduce((n, p) => n + p.B.vlmPageCalls - p.A.vlmPageCalls, 0),
  layoutServiceMs: dist(pairs.flatMap((p) => p.B.layoutServiceMs)),
  layoutObserverElapsedMs: dist(pairs.flatMap((p) => p.B.layoutRows.map((r) => r.observerElapsedMs)).filter(Number.isFinite)),
  layoutPageRowElapsedMs: dist(pairs.flatMap((p) => p.B.layoutRows.map((r) => r.elapsedMs)).filter(Number.isFinite)),
  histogramWallMsDelta: hist(pairs.map((p) => p.B.wallMs - p.A.wallMs), [-1e9, -2000, -1000, -500, 0, 500, 1000, 2000, 4000, 1e9]),
};

// ---------- layout evidence, audit findings and policy C ----------
const TEXT = new Set(["paragraph", "title", "header", "footer", "footnote", "caption", "number"]);
const NONTEXT = new Set(["table", "figure", "chart", "formula", "formula_number", "code", "seal"]);
const words = (t) => tokens(t).length;
const layoutStats = { rows: 0, routed: 0, audit: 0, succeeded: 0, errors: 0, errorReasons: {}, documentsWithRows: 0, eligibleTotal: 0, auditPoolTotal: 0, budgetExhausted: 0, admissionRejected: 0, planZeroAssignmentDocs: 0 };
const auditFindings = [];
const cRows = [];
for (const p of pairs) {
  const B = p.B, A = p.A;
  if (B.layoutRows.length) layoutStats.documentsWithRows++;
  layoutStats.eligibleTotal += B.layoutSummary?.eligible ?? 0; layoutStats.auditPoolTotal += B.layoutSummary?.auditPool ?? 0;
  layoutStats.budgetExhausted += Number(!!B.layoutSummary?.budgetExhausted); layoutStats.admissionRejected += B.layoutSummary?.admissionRejected ?? 0;
  if (B.planAssignments === 0 && B.pages > 0) layoutStats.planZeroAssignmentDocs++;
  for (const r of B.layoutRows) {
    layoutStats.rows++; layoutStats[r.selection]++;
    if (r.error) { layoutStats.errors++; layoutStats.errorReasons[r.error] = (layoutStats.errorReasons[r.error] ?? 0) + 1; continue; }
    if (!r.result) continue;
    layoutStats.succeeded++;
    const regions = r.result.regions ?? [];
    const strongNonText = regions.filter((g) => NONTEXT.has(g.label) && g.confidence >= 0.5);
    const ref = B.reference?.get(r.pageNumber);
    const nativeText = A.nativePages[r.pageNumber] ?? B.nativePages[r.pageNumber];
    if (r.selection === "audit") {
      const nativeF1 = ref != null && nativeText != null ? f1(ref, nativeText) : null;
      const finalSentToVlm = A.visionSelectedPages.includes(r.pageNumber);
      if (strongNonText.length) auditFindings.push({ file: p.A.file, kind: p.A.kind, page: r.pageNumber, healthyTextLayer: r.healthyTextLayer, routedRoles: r.routedRoles, nonTextLabels: [...new Set(strongNonText.map((g) => g.label))], armAVlmCall: finalSentToVlm, nativeF1, confirmedIncomplete: nativeF1 !== null && nativeF1 < 0.9 });
    }
    // Policy C applies only to pages arm A actually sent to an extraction call.
    const vlm = A.visionPages.find((v) => v.page === r.pageNumber);
    if (!vlm) continue;
    const thresholdRegions = regions.filter((g) => g.confidence >= 0.3);
    const allText = thresholdRegions.every((g) => TEXT.has(g.label));
    const strongParagraph = regions.some((g) => g.label === "paragraph" && g.confidence >= 0.5);
    const coverage = thresholdRegions.filter((g) => TEXT.has(g.label)).reduce((n, g) => n + (g.imageCoverage ?? 0), 0);
    const healthy = r.selection === "audit" ? r.healthyTextLayer === true : false; // routed rows are by construction not healthy; no other per-page probe facts are persisted
    const nativeWords = nativeText != null ? words(nativeText) : 0;
    const qualifies = allText && strongParagraph && coverage >= 0.05 && healthy && nativeWords >= 50;
    const usageRow = A.usage; // per-call actuals
    const fA = ref != null ? f1(ref, vlm.text) : null, fN = ref != null && nativeText != null ? f1(ref, nativeText) : null;
    cRows.push({ file: p.A.file, kind: p.A.kind, page: r.pageNumber, selection: r.selection, allText, strongParagraph, coverage, healthy, nativeWords, qualifies,
      avoidedInputTokens: vlm.input, avoidedOutputTokens: vlm.output, avoidedLatencyMs: vlm.latencyMs, f1Vlm: fA, f1Native: fN, loss: fA !== null && fN !== null ? fA - fN : null, agreementNativeVsVlm: nativeText != null ? f1(vlm.text, nativeText) : null });
  }
}
// Actual per-call provider cost for avoided VLM calls (arm A ledger, page-analysis rows).
const vlmCost = new Map();
for (const r of await sql`select source_run_id, (metadata->>'pageNumber')::int as page, coalesce((metadata->>'providerCostCents')::float8, cost_cents::float8) as provider_cents, cost_cents::float8 as cents from usage_attribution where metric = 'page-analysis' and org_id like ${`bench-${tag}-a`}`) vlmCost.set(`${r.source_run_id}:${r.page}`, r);
const armAVlmPages = docs.filter((x) => x.arm === "A").flatMap((x) => x.visionPages.map((v) => ({ file: x.file, runId: x.runId, page: v.page, latencyMs: v.latencyMs, ...vlmCost.get(`${x.runId}:${v.page}`) })));
const coveredKeys = new Set(cRows.map((r) => `${r.file}:${r.page}`));
const skipped = cRows.filter((r) => r.qualifies);
const runIdOf = new Map(docs.filter((x) => x.arm === "A").map((x) => [x.file, x.runId]));
const avoidedCents = skipped.reduce((n, r) => n + (vlmCost.get(`${runIdOf.get(r.file)}:${r.page}`)?.provider_cents ?? 0), 0);
const totalVlmCents = armAVlmPages.reduce((n, r) => n + (r.provider_cents ?? 0), 0);
const losses = skipped.map((r) => r.loss).filter((v) => v !== null);
const policyC = {
  policy: policy.id, declaredAt: policy.declaredAt,
  armAVlmPageCalls: armAVlmPages.length, armAVlmProviderUsd: totalVlmCents / 100, armAVlmLatencyMs: dist(armAVlmPages.map((r) => r.latencyMs)),
  vlmPagesWithLayoutEvidence: cRows.length, vlmPagesWithoutLayoutEvidence: armAVlmPages.filter((r) => !coveredKeys.has(`${r.file}:${r.page}`)).length,
  conditionCounts: { allTextRegions: cRows.filter((r) => r.allText).length, strongParagraph: cRows.filter((r) => r.strongParagraph).length, coverageAtLeast5pct: cRows.filter((r) => r.coverage >= 0.05).length, healthyTextLayer: cRows.filter((r) => r.healthy).length, nativeAtLeast50Words: cRows.filter((r) => r.nativeWords >= 50).length, textOnlyLayoutIgnoringTextLayer: cRows.filter((r) => r.allText && r.strongParagraph && r.coverage >= 0.05).length },
  skippedCalls: skipped.length, avoidedProviderUsd: avoidedCents / 100, avoidedShareOfVlmUsd: totalVlmCents ? avoidedCents / totalVlmCents : 0,
  avoidedInputTokens: skipped.reduce((n, r) => n + r.avoidedInputTokens, 0), avoidedOutputTokens: skipped.reduce((n, r) => n + r.avoidedOutputTokens, 0), avoidedVlmLatencyMs: skipped.reduce((n, r) => n + (r.avoidedLatencyMs ?? 0), 0),
  quality: { skippedWithReference: losses.length, meanLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null, materialLossPages: losses.filter((v) => v > 0.05).length, lossDistribution: dist(losses) },
  // Diagnostic only (NOT policy C): what a text-only layout gate would do if the healthy-text-layer condition were dropped.
  diagnosticTextOnlyLayoutGate: (() => { const g = cRows.filter((r) => r.allText && r.strongParagraph && r.coverage >= 0.05); const l = g.map((r) => r.loss).filter((v) => v !== null); return { pages: g.length, withReference: l.length, meanLoss: l.length ? l.reduce((a, b) => a + b, 0) / l.length : null, materialLossPages: l.filter((v) => v > 0.05).length, rows: g.map(({ file, page, selection, nativeWords, f1Vlm, f1Native, loss }) => ({ file, page, selection, nativeWords, f1Vlm, f1Native, loss })) }; })(),
  rows: cRows,
};

const ledger = await sql`select provider, model, metric, count(*)::int as calls, sum(input_tokens)::float8 as input, sum(output_tokens)::float8 as output, sum(cost_cents)::float8 as customer_cents, sum(coalesce((metadata->>'providerCostCents')::float8, cost_cents::float8))::float8 as provider_cents from usage_attribution where org_id like 'bench-%' and provider not in ('local','local-compute','docslurp') group by 1,2,3 order by 1,2,3`;
const summary = {
  schema: "router-e2e-summary@v1", tag, generatedAt: new Date().toISOString(), corpus: { documents: corpus.documents, pages: corpus.pages, byKind: corpus.byKind, rule: corpus.rule },
  arms, shadowOverhead: overhead, layout: layoutStats, auditFindings, policyC: { ...policyC, rows: undefined }, benchLedgerAllOrgs: ledger,
  perDocument: docs.map(({ visionPages, nativePages, layoutRows, reference, usage, ...rest }) => ({ ...rest, layoutRows: layoutRows.map(({ result, ...r }) => ({ ...r, regions: result?.regions?.map((g) => ({ label: g.label, confidence: g.confidence, imageCoverage: g.imageCoverage })) })) })),
};
writeFileSync(path.join(raw, "analysis.json"), JSON.stringify({ ...summary, policyCRows: policyC.rows }, null, 2));
const { perDocument, ...compact } = summary;
writeFileSync(summaryOut, JSON.stringify({ ...compact, rawAnalysis: path.join(raw, "analysis.json") }, null, 2));
console.log(JSON.stringify({ arms: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, { documents: v.documents, pages: v.pages, completed: v.completed, paid: v.paid, calls: v.extractionCalls, wall: v.latency.endToEndWallMs, ppm: v.throughput.pagesPerMinuteSequential }])), overhead: { wallMsDelta: overhead.wallMsDelta, routePages: overhead.routePagesStageMsDelta }, layout: layoutStats, audit: auditFindings.length, policyC: { ...policyC, rows: undefined, diagnosticTextOnlyLayoutGate: { ...policyC.diagnosticTextOnlyLayoutGate, rows: undefined } } }, null, 2));
await sql.end();
