#!/usr/bin/env node
// Large-PDF ingestion benchmark harness (zero dependencies, Node >= 20).
// Generic tooling: no document names, queries or expected values live here; those come from
// manifest.json / queries.json supplied by the corpus owner. See core/performance/large-docs/plan.md.
//
// Network commands (login, prepare, upload, watch, probe, report --live) refuse to run unless
// --go is passed. `check` and `validate` are offline. Credentials are read from a file and never printed.
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openAsBlob, openSync, readFileSync, readSync, statSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";

export const TEXT_MODEL = "z-ai/glm-5.3-flash";
// User requirement: app ingestion uses GLM 5.3 Flash for text AND vision/OCR (native multimodal image+text, $0.049/M in, $0.65/M out on
// the live OpenRouter catalog, models.json). The shared default vision route (gemini) is overridden explicitly.
export const VISION_MODEL_URI = "llm://openrouter/z-ai/glm-5.3-flash";
// Customer-ledger facts the cost forecast uses (all cents). The per-page base fee is DOCSLURP_PAGE_BASE_FEE_USD (fly.worker.toml, 0.0003 USD/page);
// it is booked once in completeRun after the last stage and after the run cost cap is checked, so no poll rate can stop it. Embeddings were billed at
// 1.2x the list price in the e2 ledger (not investigated). The $5.00 benchmark ceiling counts every ledger charge, fee included.
export const PAGE_BASE_FEE_CENTS = 0.03, LEDGER_EMBED_FACTOR = 1.2, EMBED_USD_PER_MTOK = 0.02, BENCHMARK_CEILING_CENTS = 500;
// Per-run pipeline cost cap in cents (server-enforced against billed spend). Shared API balance $9.86; large-benchmark ceiling $5.00.
export const MAX_COST_CENTS = 250;
const ROOT = process.env.BENCH_ROOT ?? "/tmp/docslurp-large-docs";
const DEFAULTS = {
  base: process.env.BENCH_BASE_URL ?? "https://docslurp.io",
  credentials: process.env.BENCH_CREDENTIALS ?? "/tmp/docslurp-production-acceptance/credentials.json",
  manifest: `${ROOT}/manifest.json`,
  queries: `${ROOT}/queries.json`,
  out: `${ROOT}/runs`,
  core: process.env.BENCH_CORE_DIR ?? "/tmp/docslurp-composer-ci-pr/core",
};

// ---------- pipeline profiles (workspace-level; both pin the text model explicitly) ----------
// rag-only: embedding + vector/lexical index. contextualChunkPreambles stays at its schema default (true)
// because it is required indexing work that calls the text model; it is NOT disabled to win a timing.
// enriched: adds every optional text-model enrichment. Compare profiles only against themselves.
// Embedding is an opt-in per-arm setting. Omitted = the request carries no embedding key and the workspace default applies
// (good-fast-local, local bge-m3), exactly as the e1 baseline did. Never a silent global default change.
export const EMBEDDING_PROFILES = ["good-fast-local", "cheapest-hosted"];
// Full catalog config, not just { profile }: merging a profile-only override onto a default-embedding base keeps the base modelUri/target
// (profile says hosted, route stays local bge-m3), so `check` asserts the merged result and the bench never sends a profile-only override.
export async function embeddingOverrideFor(name, o = {}) {
  if (name === undefined) return null;
  if (!EMBEDDING_PROFILES.includes(name)) throw new Error(`--embedding-profile must be one of ${EMBEDDING_PROFILES.join(" | ")} (got ${name === true ? "no value" : name})`);
  const m = await import(join(o.core ?? DEFAULTS.core, "packages/shared/dist/index.js")).catch(e => { throw new Error(`shared schema not importable (${e.code ?? e.message}); build core/packages/shared or pass --core`); });
  const { profile, target, modelUri, task, normalize } = m.embeddingProfileCatalog[name].config; return { profile, target, modelUri, task, normalize };
}
const embeddingMatches = (eff, want) => !!eff && eff.profile === want.profile && eff.modelUri === want.modelUri && eff.target === want.target;
export function pipelineFor(profile, model = TEXT_MODEL, embedding = null, capCents = MAX_COST_CENTS) {
  const textGeneration = { model, models: {} };
  const common = { vision: { modelUri: VISION_MODEL_URI }, maxCostCents: capCents, ...(embedding ? { embedding } : {}) };
  if (profile === "rag-only") {
    return { ...common, textGeneration, summarize: false, pageIndex: false, propositionIndex: false, graphRag: false, graphCommunitySummaries: false, entityIndex: false };
  }
  if (profile === "enriched") {
    return { ...common, textGeneration, summarize: true, pageIndex: true, propositionIndex: true, graphRag: true, graphCommunitySummaries: true, entityIndex: true };
  }
  throw new Error(`unknown profile ${profile} (rag-only | enriched)`);
}

// ---------- tiny utilities ----------
const now = () => Date.now();
const iso = (t = now()) => new Date(t).toISOString();
const log = (...a) => console.error(`[bench ${iso()}]`, ...a);
const sha256File = (p) => new Promise((res, rej) => { const h = createHash("sha256"); createReadStream(p).on("data", d => h.update(d)).on("error", rej).on("end", () => res(h.digest("hex"))); });
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v, mode) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); if (mode) chmodSync(p, mode); };
const appendJsonl = (p, v) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, JSON.stringify(v) + "\n"); };
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function parseArgs(argv) {
  const [cmd, ...rest] = argv; const o = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true; o[k] = v; } else o._.push(a);
  }
  return { cmd, o };
}

// ---------- manifest / queries (real corpus schema: manifest.documents[], queries.queries[]) ----------
// manifest.json: documents[] with id, local_path, sha256, bytes, pdfinfo_pages, full_text_file.
// queries.json:  queries[] with id, document, position, question, expected_answer, support_pages (1-based), support_match_all.
export function loadManifest(p) {
  const raw = readJson(p); const arr = Array.isArray(raw) ? raw : raw.documents;
  if (!Array.isArray(arr) || !arr.length) throw new Error(`manifest ${p}: no documents[]`);
  const dir = dirname(resolve(p));
  return arr.map((f, i) => {
    const path = f.local_path ?? f.path;
    if (!f.id) throw new Error(`manifest document #${i}: missing id`);
    // Upload filename is unique per document (every source is called catalog.pdf on disk); citations report this name.
    return { id: f.id, path: path ? resolve(dir, path) : null, filename: `${f.id}.pdf`, sha256: f.sha256 ?? null, sizeBytes: f.bytes ?? null,
      pageCount: f.pdfinfo_pages ?? null, fullText: f.full_text_file ? resolve(dir, f.full_text_file) : null, url: f.url ?? null, raw: f };
  });
}
export function loadQueries(p) {
  const raw = readJson(p); const arr = Array.isArray(raw) ? raw : raw.queries;
  if (!Array.isArray(arr) || !arr.length) throw new Error(`queries ${p}: no queries[]`);
  return arr.map((q, i) => ({
    id: q.id ?? `q${i}`, q: q.question, document: q.document ?? null, position: q.position ? String(q.position).trim().split(/[\s(]/)[0].toLowerCase() : null, positionLabel: q.position ?? null, // "end (79%)" -> "end"
    pages: [].concat(q.support_pages ?? []), all: [].concat(q.support_match_all ?? []), expectedAnswer: q.expected_answer ?? null,
    k: q.k ?? 10,
  }));
}
// Strict static validity of one query (used by `check` and by judge): all three oracle parts must be non-empty.
export function oracleProblems(q) {
  const out = [];
  if (!norm(q.q)) out.push("empty question");
  if (!q.document) out.push("no document id");
  if (!q.pages.length || !q.pages.every(n => Number.isInteger(n) && n > 0)) out.push("support_pages empty or not positive integers");
  if (!q.all.length || q.all.some(s => !norm(s))) out.push("support_match_all empty or contains an empty string");
  return out;
}
// A result is correct iff ALL hold: (1) citation.documentId equals the ingested document's real id, (2) the chunk text contains every
// support_match_all string (NFKC, case/whitespace-insensitive), and (3) one of the cited pages is a support page.
// Missing/empty oracle parts, a missing document id or an absent citation can never pass (no vacuous truth).
// Real search result shape: { text, score, citation: { documentId, filename, pageNumber, pageNumbers[] } }.
export function judge(query, results, ctx = {}) {
  const hits = [], pageOnly = []; // pageOnly: right document + right page but text oracle missed (OCR/rendering drift; diagnostic, NOT correct)
  const bad = oracleProblems(query);
  if (bad.length || !ctx.documentId) return { correct: false, rank: null, hitRanks: [], invalid: bad.length ? bad.join("; ") : "no documentId for the ingested document" };
  results.forEach((r, rank) => {
    const c = r?.citation; if (!c || c.documentId == null) return;
    const text = norm(r.text);
    const pages = new Set([c.pageNumber, ...(c.pageNumbers ?? [])].filter(x => Number.isInteger(x)));
    const okDoc = c.documentId === ctx.documentId;
    const okText = query.all.every(s => text.includes(norm(s)));
    const okPage = query.pages.some(p => pages.has(p));
    if (okDoc && okText && okPage) hits.push(rank + 1); else if (okDoc && okPage) pageOnly.push(rank + 1);
  });
  return { correct: hits.length > 0, rank: hits[0] ?? null, hitRanks: hits, ...(pageOnly.length ? { docPageHitTextMissRanks: pageOnly } : {}) };
}

// ---------- HTTP client with cookie jar ----------
class Client {
  constructor(base, jarPath) { this.base = base.replace(/\/$/, ""); this.jarPath = jarPath; this.jar = existsSync(jarPath) ? readJson(jarPath) : {}; this.calls = 0; }
  cookie() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; "); }
  save() { writeJson(this.jarPath, this.jar, 0o600); }
  async req(path, { method = "GET", json, headers = {}, raw = false, timeoutMs = 60000 } = {}) {
    const t0 = now(); this.calls++;
    const res = await fetch(path.startsWith("http") ? path : this.base + path, {
      method, signal: AbortSignal.timeout(timeoutMs), redirect: "manual",
      headers: { ...(json ? { "Content-Type": "application/json" } : {}), Origin: this.base, ...(this.cookie() ? { Cookie: this.cookie() } : {}), ...headers },
      body: json ? JSON.stringify(json) : undefined,
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(";"); const i = kv.indexOf("="); if (i > 0) this.jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
    if (raw) return res;
    const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
    return { status: res.status, ok: res.ok, body, ms: now() - t0, headers: res.headers };
  }
}

// ---------- run directory ----------
function runDir(o) { const label = o.label; if (!label) throw new Error("--label required"); const d = join(o.out ?? DEFAULTS.out, label); mkdirSync(d, { recursive: true }); return d; }
const statePath = (d) => join(d, "state.json");
const loadState = (d) => (existsSync(statePath(d)) ? readJson(statePath(d)) : {});
const saveState = (d, patch) => writeJson(statePath(d), { ...loadState(d), ...patch });
function requireGo(o) { if (!o.go) throw new Error("network command refused: pass --go (root approval) to contact the app"); }
function client(o, d) { return new Client(o.base ?? DEFAULTS.base, join(d, ".cookies.json")); }

// ---------- commands ----------
const queriesFor = (qs, fileId) => qs.filter(q => q.document === fileId);
// Oracle self-test: proves the judge cannot pass vacuously. Offline, no data needed.
export function judgeSelfTest() {
  const bad = []; const doc = "DOC1";
  const mk = (over = {}) => ({ id: "t", q: "question?", document: "d", position: "middle", pages: [5], all: ["alpha beta"], k: 10, ...over });
  const res = (over = {}) => ({ text: "x Alpha  Beta y", score: 1, citation: { documentId: doc, filename: "d.pdf", pageNumber: 5, pageNumbers: [5], ...over.citation }, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "citation")) });
  const expect = (name, got, want) => { if (got !== want) bad.push(`judge self-test '${name}': got ${got}, want ${want}`); };
  expect("correct", judge(mk(), [res()], { documentId: doc }).correct, true);
  expect("ligature+case normalised", judge(mk({ all: ["\ufb01nal"] }), [res({ text: "FINAL" })], { documentId: doc }).correct, true);
  expect("wrong page", judge(mk(), [res({ citation: { pageNumber: 6, pageNumbers: [6] } })], { documentId: doc }).correct, false);
  expect("wrong text", judge(mk(), [res({ text: "nothing" })], { documentId: doc }).correct, false);
  expect("wrong document id", judge(mk(), [res({ citation: { documentId: "OTHER" } })], { documentId: doc }).correct, false);
  expect("no ingested document id", judge(mk(), [res()], {}).correct, false);
  expect("empty match_all", judge(mk({ all: [] }), [res()], { documentId: doc }).correct, false);
  expect("empty-string match", judge(mk({ all: [""] }), [res()], { documentId: doc }).correct, false);
  expect("empty pages", judge(mk({ pages: [] }), [res()], { documentId: doc }).correct, false);
  expect("no document on query", judge(mk({ document: null }), [res()], { documentId: doc }).correct, false);
  expect("no citation", judge(mk(), [{ text: "alpha beta", score: 1 }], { documentId: doc }).correct, false);
  expect("text on other page only", judge(mk(), [res({ citation: { pageNumber: 9, pageNumbers: [9] } }), res({ text: "zzz" })], { documentId: doc }).correct, false);
  return bad;
}

async function cmdCheck(o) { // offline: validate inputs against the real corpus files, hash PDFs, verify oracles against full text, validate pipeline payload
  const man = loadManifest(o.manifest ?? DEFAULTS.manifest); const qs = loadQueries(o.queries ?? DEFAULTS.queries);
  const report = { files: [], queries: qs.length, problems: [], notes: [] };
  report.problems.push(...judgeSelfTest());
  const byId = new Map(man.map(f => [f.id, f])); const pageText = new Map();
  for (const f of man) {
    const ent = { id: f.id, filename: f.filename, expectedPages: f.pageCount };
    if (!f.path || !existsSync(f.path)) { report.problems.push(`${f.id}: file missing (${f.path})`); report.files.push(ent); continue; }
    ent.sizeBytes = statSync(f.path).size; ent.sha256 = await sha256File(f.path);
    if (f.sha256 && f.sha256 !== ent.sha256) report.problems.push(`${f.id}: sha256 differs from manifest`);
    if (f.sizeBytes && f.sizeBytes !== ent.sizeBytes) report.problems.push(`${f.id}: size differs from manifest`);
    const fd = openSync(f.path, "r"); const head = Buffer.alloc(5); readSync(fd, head, 0, 5, 0); closeSync(fd); if (head.toString() !== "%PDF-") report.problems.push(`${f.id}: not a PDF`);
    ent.MB = +(ent.sizeBytes / 1e6).toFixed(2); ent.MiB = +(ent.sizeBytes / 1048576).toFixed(2);
    if (f.fullText && existsSync(f.fullText)) { const pages = readFileSync(f.fullText, "utf8").split("\f"); if (pages.length && !pages.at(-1).trim()) pages.pop(); pageText.set(f.id, pages.map(norm)); ent.textPages = pages.length;
      if (f.pageCount && pages.length !== f.pageCount) report.problems.push(`${f.id}: full text has ${pages.length} pages, manifest pdfinfo_pages ${f.pageCount}`);
      ent.shortTextPages = pages.filter(t => t.trim().length < 100).length; }
    else report.notes.push(`${f.id}: no full_text_file, query oracles not verified against text`);
    report.files.push(ent);
  }
  for (const q of qs) {
    for (const p of oracleProblems(q)) report.problems.push(`${q.id}: ${p}`);
    const f = byId.get(q.document); if (!f) { report.problems.push(`${q.id}: document '${q.document}' not in manifest`); continue; }
    if (f.pageCount) for (const pg of q.pages) if (pg < 1 || pg > f.pageCount) report.problems.push(`${q.id}: support page ${pg} outside 1..${f.pageCount}`);
    const pt = pageText.get(f.id);
    if (pt) { for (const pg of q.pages) { const t = pt[pg - 1]; if (t == null) continue; const miss = q.all.filter(s => !t.includes(norm(s)));
      if (miss.length) report.problems.push(`${q.id}: page ${pg} text lacks ${JSON.stringify(miss)}`); }
      const hits = pt.flatMap((t, i) => (q.all.length && q.all.every(s => t.includes(norm(s))) ? [i + 1] : []));
      const extra = hits.filter(h => !q.pages.includes(h)); if (extra.length) report.problems.push(`${q.id}: support strings also match pages ${extra.slice(0, 5)} not listed in support_pages (would be scored wrong)`); }
    if (!q.expectedAnswer) report.notes.push(`${q.id}: no expected_answer (diagnostic only)`);
  }
  for (const f of man) { const mine = queriesFor(qs, f.id); if (!mine.length) { report.notes.push(`${f.id}: no queries (do not use as a benchmark arm)`); continue; }
    const pos = new Set(mine.map(q => q.position)); const missing = ["beginning", "middle", "end"].filter(p => !pos.has(p));
    if (missing.length) report.notes.push(`${f.id}: queries lack position(s) ${missing} (allPositionsQueryable only covers positions present)`); }
  if (!qs.some(q => ["beginning", "middle", "end"].every(p => queriesFor(qs, q.document).some(x => x.position === p)))) report.problems.push("no document has beginning+middle+end queries");
  for (const profile of ["rag-only", "enriched"]) { const v = report[`pipeline:${profile}`] = await validatePipeline(pipelineFor(profile), o); if (v.ok !== true) report.problems.push(`pipeline ${profile}: ${(v.issues ?? []).join("; ") || "not validated"}`); }
  const ev = report.embeddingProfiles = await validateEmbeddingProfiles(o); report.problems.push(...ev.problems);
  console.log(JSON.stringify(report, null, 2)); if (report.problems.length) process.exitCode = 2;
}
async function validatePipeline(p, o, cap = MAX_COST_CENTS) { // runs both server-side schemas: full features and the override schema used by workspace create / upload sessions
  try { const m = await import(join(o.core ?? DEFAULTS.core, "packages/shared/dist/index.js")); const r = m.pipelineFeaturesSchema.safeParse(p);
    if (!r.success) return { ok: false, issues: r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) };
    const ov = m.pipelineFeatureOverridesSchema?.safeParse(p); if (ov && !ov.success) return { ok: false, issues: ov.error.issues.map(i => `override ${i.path.join(".")}: ${i.message}`) };
    const issues = [];
    if (r.data.textGeneration?.model !== TEXT_MODEL) issues.push(`textGeneration.model is ${r.data.textGeneration?.model}`);
    if (Object.keys(r.data.textGeneration?.models ?? {}).length) issues.push("per-operation text model overrides present");
    if (r.data.vision?.modelUri !== VISION_MODEL_URI) issues.push(`vision.modelUri is ${r.data.vision?.modelUri}`);
    if (r.data.maxCostCents !== cap) issues.push(`maxCostCents is ${r.data.maxCostCents}`);
    return { ok: issues.length === 0, issues, textGeneration: r.data.textGeneration, visionModelUri: r.data.vision?.modelUri, visionTarget: r.data.vision?.target, maxCostCents: r.data.maxCostCents, embedding: r.data.embedding?.modelUri };
  } catch (e) { return { ok: null, issues: [`shared schema not importable (${e.code ?? e.message}); build core/packages/shared or pass --core`] }; }
}

// Offline: each --embedding-profile must pass both shared schemas with GLM text+vision still pinned, and must resolve to the catalog route on
// every path a run takes: workspace create (normalize), upload override onto a default workspace, and onto a same-profile workspace.
async function validateEmbeddingProfiles(o) {
  const out = { problems: [], profiles: {} };
  try {
    const m = await import(join(o.core ?? DEFAULTS.core, "packages/shared/dist/index.js"));
    const route = (e) => { const r = m.resolveEmbeddingRoute(e); return `${r.runtime}/${r.provider}/${r.model}/${r.dimensions}d`; };
    const dflt = m.normalizePipelineFeatures(pipelineFor("rag-only")); // what an omitted --embedding-profile yields
    out.omittedFlag = { profile: dflt.embedding.profile, route: route(dflt.embedding) };
    if (dflt.embedding.profile !== "good-fast-local") out.problems.push(`omitted --embedding-profile resolves to ${dflt.embedding.profile}, expected good-fast-local`);
    for (const name of EMBEDDING_PROFILES) {
      const emb = await embeddingOverrideFor(name, o); const want = route(emb); const p = pipelineFor("rag-only", TEXT_MODEL, emb);
      const v = await validatePipeline(p, o); if (v.ok !== true) out.problems.push(`embedding ${name}: ${(v.issues ?? []).join("; ") || "not validated"}`);
      const created = m.normalizePipelineFeatures(p), same = m.mergePipelineFeatures(created, { embedding: emb }), onDefault = m.mergePipelineFeatures(dflt, { embedding: emb });
      const got = { create: route(created.embedding), uploadOnSameProfileWorkspace: route(same.embedding), uploadOnDefaultWorkspace: route(onDefault.embedding) };
      for (const [path, r] of Object.entries(got)) if (r !== want) out.problems.push(`embedding ${name}: ${path} resolves to ${r}, expected ${want}`);
      out.profiles[name] = { modelUri: emb.modelUri, target: emb.target, route: want, ...got };
    }
    const bare = m.mergePipelineFeatures(dflt, { embedding: { profile: "cheapest-hosted" } }); // known footgun, documented in plan.md; never sent by this harness
    out.profileOnlyOverrideOnDefaultWorkspace = { profile: bare.embedding.profile, route: route(bare.embedding), note: "profile label changes but the route stays on the base model; the harness sends the full catalog config instead" };
  } catch (e) { out.problems.push(`embedding profile validation unavailable: ${e.message}`); }
  return out;
}

async function cmdLogin(o) {
  requireGo(o); const d = runDir(o); const c = client(o, d); const cred = readJson(o.credentials ?? DEFAULTS.credentials);
  const r = await c.req("/api/auth/sign-in/email", { method: "POST", json: { email: cred.email, password: cred.password } });
  if (!r.ok || Object.keys(c.jar).length === 0) throw new Error(`login failed: HTTP ${r.status}`); // body deliberately not printed
  c.save(); const me = await c.req("/v1/workspaces"); if (!me.ok) throw new Error(`session check failed: HTTP ${me.status}`);
  log(`login ok (cookies stored 0600), ${me.body?.workspaces?.length ?? "?"} existing workspaces untouched`);
  saveState(d, { loggedInAt: iso() });
}

// Fee-reserved cost forecast (cents, customer ledger). The per-page base fee is certain and is booked at completion after the run cost cap is checked,
// so it is reserved up front instead of being discovered at the end. AI is estimated from the corpus text, with GLM and compute as flat reserves.
// The server run cap is budget minus the fee, because the cap is checked before the fee is booked. Not a prediction of the exact bill.
export function forecastCost({ pages, textChars, budgetCents, spentCents = 0, ceilingCents = BENCHMARK_CEILING_CENTS, feePerPageCents = PAGE_BASE_FEE_CENTS, charsPerToken = 3, glmReserveCents = 10, computeReserveCents = 2 }) {
  const feeCents = +(pages * feePerPageCents).toFixed(4), embedTokens = Math.ceil(textChars / charsPerToken);
  const embedCents = +(embedTokens / 1e6 * EMBED_USD_PER_MTOK * 100 * LEDGER_EMBED_FACTOR).toFixed(4);
  const aiCents = +(embedCents + glmReserveCents).toFixed(4), totalCents = +(feeCents + aiCents + computeReserveCents).toFixed(4), remainingCents = +(ceilingCents - spentCents).toFixed(4);
  const reasons = []; if (totalCents > budgetCents) reasons.push(`forecast ${totalCents}c > arm budget ${budgetCents}c`); if (totalCents > remainingCents) reasons.push(`forecast ${totalCents}c > remaining benchmark ceiling ${remainingCents}c`);
  return { pages, textChars, embedTokens, feeCents, embedCents, glmReserveCents, computeReserveCents, aiCents, totalCents, budgetCents, spentCents, ceilingCents, remainingCents, runCapCents: Math.max(0, Math.floor(budgetCents - feeCents)), ok: reasons.length === 0, reasons,
    basis: "fee = pages x DOCSLURP_PAGE_BASE_FEE_USD (0.03c/page); embeddings = chars/3 tokens x $0.02/M x 1.2 (e2 ledger factor); GLM and compute are flat reserves" };
}
async function cmdPreflight(o) { // read-only: health, readiness, existing docs with same sha256 (org-level reuse risk)
  requireGo(o); const d = runDir(o); const c = client(o, d);
  const out = { at: iso(), health: (await c.req("/health")).body, ready: (await c.req("/ready")).body };
  const man = loadManifest(o.manifest ?? DEFAULTS.manifest); const shas = new Map();
  for (const f of man) shas.set(f.sha256 ?? await sha256File(f.path), f.id);
  const docs = await c.req("/v1/documents", { timeoutMs: 120000 }); if (!docs.ok) throw new Error(`documents list HTTP ${docs.status}`);
  const list = docs.body?.documents; if (!Array.isArray(list)) throw new Error("documents list: expected { documents: [] }"); // real contract; no limit/paging parameter exists
  out.documentsScanned = list.length; out.sameBytesAlreadyInOrg = list.filter(x => x.sourceSha256 && shas.has(x.sourceSha256)).map(x => ({ file: shas.get(x.sourceSha256), documentId: x.id, workspaceId: x.workspaceId, status: x.status }));
  out.reuseWarning = out.sameBytesAlreadyInOrg.length ? "bytes already ingested in this org: content dedup and/or embedding reuse likely; run is WARM, not cold" : "no same-bytes document in the org document list (reuse of identical chunk text from other docs is still possible; see embed reuse stats)";
  if (o.file) { // fee-reserved forecast for the one file about to be uploaded; spent = every ledger charge this month (customer ledger, fee included)
    const f = man.find(x => x.id === o.file); if (!f) throw new Error(`--file ${o.file} not in manifest`); if (!f.pageCount) throw new Error("manifest has no pdfinfo_pages for the forecast");
    const u = await c.req("/v1/billing/usage"); if (!u.ok) throw new Error(`billing usage HTTP ${u.status}: cannot read the ledger for the forecast`);
    const text = f.fullText && existsSync(f.fullText) ? readFileSync(f.fullText, "utf8").replace(/\s+/g, " ").length : null; if (text == null) throw new Error("no full_text_file for the forecast");
    out.forecast = { file: f.id, ...forecastCost({ pages: f.pageCount, textChars: text, budgetCents: +(o["budget-cents"] ?? 100), spentCents: u.body?.currentMonth?.costCents ?? 0, glmReserveCents: +(o["glm-reserve-cents"] ?? 10), computeReserveCents: +(o["compute-reserve-cents"] ?? 2) }) };
    if (!out.forecast.ok) { process.exitCode = 4; log(`FORECAST EXCEEDS BUDGET, STOP: ${out.forecast.reasons.join("; ")}`); }
  }
  writeJson(join(d, "preflight.json"), out); console.log(JSON.stringify(out, null, 2));
}

async function cmdPrepare(o) { // create a NEW benchmark workspace with explicit pipeline; verify effective config
  requireGo(o); const d = runDir(o); const c = client(o, d); const profile = o.profile ?? "rag-only";
  const emb = await embeddingOverrideFor(o["embedding-profile"], o);
  const pf = existsSync(join(d, "preflight.json")) ? readJson(join(d, "preflight.json")).forecast : null; if (pf && !pf.ok) throw new Error(`preflight forecast is over budget (${pf.reasons.join("; ")}): stop and report`);
  const capCents = pf ? pf.runCapCents : MAX_COST_CENTS; const pipeline = pipelineFor(profile, o.model ?? TEXT_MODEL, emb, capCents);
  const name = o.name ?? `bench-large-${profile}-${o.label}`;
  const r = await c.req("/v1/workspaces", { method: "POST", json: { name, pipeline } }); if (r.status !== 201) throw new Error(`workspace create HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`);
  const ws = r.body; const got = await c.req(`/v1/workspaces/${ws.id}`); const eff = got.body?.pipeline ?? ws.pipeline;
  const checks = { textModel: eff?.textGeneration?.model === (o.model ?? TEXT_MODEL), perOpOverrides: Object.keys(eff?.textGeneration?.models ?? {}), visionModelUri: eff?.vision?.modelUri === VISION_MODEL_URI, maxCostCents: eff?.maxCostCents === capCents, embedding: emb ? embeddingMatches(eff?.embedding, emb) : null, profileFlags: Object.fromEntries(Object.keys(pipeline).filter(k => typeof pipeline[k] === "boolean").map(k => [k, eff?.[k] === pipeline[k]])) };
  const ok = checks.textModel && checks.visionModelUri && checks.maxCostCents && checks.perOpOverrides.length === 0 && checks.embedding !== false && Object.values(checks.profileFlags).every(Boolean);
  const receipt = { at: iso(), workspaceId: ws.id, name, profile, requestedPipeline: pipeline, effectivePipeline: { textGeneration: eff?.textGeneration, vision: eff?.vision, embedding: eff?.embedding, contextualChunkPreambles: eff?.contextualChunkPreambles, parserPlaybook: eff?.parserPlaybook, maxCostCents: eff?.maxCostCents }, checks, ok };
  writeJson(join(d, "workspace.json"), receipt); saveState(d, { workspaceId: ws.id, profile, textModel: o.model ?? TEXT_MODEL, embeddingProfile: emb?.profile ?? null, embedding: emb, runCapCents: capCents, budgetCents: pf?.budgetCents ?? null, feeReserveCents: pf?.feeCents ?? 0, forecastFile: pf?.file ?? null }); c.save();
  console.log(JSON.stringify(receipt, null, 2)); if (!ok) { process.exitCode = 3; log("EFFECTIVE CONFIG MISMATCH - do not upload"); }
}

async function cmdUpload(o) { // direct-upload protocol, mirrors app/src/lib/api.ts uploadFilesDirect
  requireGo(o); const d = runDir(o); const c = client(o, d); const st = loadState(d); if (!st.workspaceId) throw new Error("run prepare first");
  if (!o["fresh-ok"] && !existsSync(join(d, "preflight.json"))) throw new Error("run preflight first (or pass --fresh-ok)");
  const pfc = existsSync(join(d, "preflight.json")) ? readJson(join(d, "preflight.json")).forecast : null;
  if (!o["no-forecast"] && !pfc) throw new Error("preflight has no fee-reserved forecast: run preflight --file <manifest id> --budget-cents N (or pass --no-forecast)");
  if (pfc && !pfc.ok) throw new Error(`preflight forecast is over budget (${pfc.reasons.join("; ")}): stop and report`);
  const man = loadManifest(o.manifest ?? DEFAULTS.manifest); const only = o.file ? man.filter(f => f.id === o.file) : man;
  if (only.length !== 1) throw new Error("exactly one ingestion at a time: pass --file <manifest id>");
  const f = only[0]; if (pfc && pfc.file !== f.id) throw new Error(`forecast was made for ${pfc.file}, not ${f.id}`); const size = statSync(f.path).size; const sha = await sha256File(f.path);
  if (f.sha256 && f.sha256 !== sha) throw new Error("source bytes differ from manifest sha256");
  const t = { startedAt: now() };
  const s = await c.req("/v1/ingest/direct/sessions", { method: "POST", json: { workspaceId: st.workspaceId, pipeline: { textGeneration: { model: st.textModel, models: {} }, vision: { modelUri: VISION_MODEL_URI }, maxCostCents: st.runCapCents ?? MAX_COST_CENTS, ...(st.embedding ? { embedding: st.embedding } : {}) }, files: [{ filename: f.filename, mimeType: "application/pdf", sizeBytes: size }] } });
  if (s.status !== 201) throw new Error(`session HTTP ${s.status}: ${JSON.stringify(s.body).slice(0, 400)}`);
  t.sessionMs = s.ms; const desc = s.body.files[0]; const blob = await openAsBlob(f.path, { type: "application/pdf" }); const parts = []; const tu = now();
  if (desc.mode === "single") {
    const p = await fetch(desc.putUrl, { method: "PUT", headers: { "Content-Type": desc.mimeType }, body: blob }); if (!p.ok) throw new Error(`PUT HTTP ${p.status}`);
    const fin = await c.req(`/v1/ingest/direct/sessions/${s.body.sessionId}/files/complete`, { method: "POST", json: { fileId: desc.id, etag: p.headers.get("etag") ?? undefined } }); if (!fin.ok) throw new Error(`complete HTTP ${fin.status}`);
  } else {
    for (const part of desc.pendingParts ?? []) {
      const ps = desc.partSize ?? part.sizeBytes, a = (part.partNumber - 1) * ps, t1 = now();
      const p = await fetch(part.url, { method: "PUT", body: blob.slice(a, Math.min(size, a + part.sizeBytes)) }); if (!p.ok) throw new Error(`part ${part.partNumber} HTTP ${p.status}`);
      const etag = p.headers.get("etag"); if (!etag) throw new Error(`part ${part.partNumber} missing etag`); parts.push({ partNumber: part.partNumber, etag }); appendJsonl(join(d, "upload-parts.jsonl"), { part: part.partNumber, bytes: part.sizeBytes, ms: now() - t1 });
    }
    const fin = await c.req(`/v1/ingest/direct/sessions/${s.body.sessionId}/files/complete`, { method: "POST", json: { fileId: desc.id, parts } }); if (!fin.ok) throw new Error(`complete HTTP ${fin.status}`);
  }
  t.uploadMs = now() - tu; t.uploadMBps = +(size / 1048576 / (t.uploadMs / 1000)).toFixed(2);
  const cf = await c.req(`/v1/ingest/direct/sessions/${s.body.sessionId}/confirm`, { method: "POST", timeoutMs: 300000 }); if (!cf.ok) throw new Error(`confirm HTTP ${cf.status}: ${JSON.stringify(cf.body).slice(0, 400)}`);
  t.acceptedAt = now(); t.confirmMs = cf.ms; const doc = cf.body.documents?.[0];
  const rec = { file: f.id, sizeBytes: size, sha256: sha, mode: desc.mode, parts: parts.length, ...t, runId: cf.body.run?.id, documentId: doc?.id, rejected: cf.body.rejected ?? [],
    dedupedFromDocumentId: doc?.dedupedFromDocumentId ?? null, dedupScope: doc?.dedupScope ?? null, workspaceMatches: cf.body.workspace?.id === st.workspaceId, warnings: cf.body.warnings ?? [], temporalDeferred: cf.headers.get("x-temporal-deferred") === "true" };
  // Effective per-run config as the server stored it (run.pipeline), next to what was requested; null when the confirm payload omits it (report reads it from progress).
  const ep = cf.body.run?.pipeline; rec.requestedEmbedding = st.embedding ?? null;
  rec.effectiveRunConfig = ep ? { embedding: ep.embedding && { profile: ep.embedding.profile, modelUri: ep.embedding.modelUri, target: ep.embedding.target }, textModel: ep.textGeneration?.model, perOpModels: Object.keys(ep.textGeneration?.models ?? {}), visionModelUri: ep.vision?.modelUri, maxCostCents: ep.maxCostCents } : null;
  rec.embeddingConfigOk = st.embedding && ep ? embeddingMatches(ep.embedding, st.embedding) : null;
  if (rec.embeddingConfigOk === false) { process.exitCode = 6; log(`RUN EMBEDDING CONFIG MISMATCH (requested ${st.embedding.profile}, run has ${ep.embedding?.profile}/${ep.embedding?.modelUri}); run ${rec.runId} is already accepted: root decides, cancel: POST /v1/runs/${rec.runId}/control {"action":"cancel"}`); }
  if (!rec.runId || !rec.workspaceMatches) { writeJson(join(d, "upload.json"), rec); throw new Error("confirm did not create a run in the benchmark workspace; see upload.json"); }
  writeJson(join(d, "upload.json"), rec); saveState(d, { runId: rec.runId, documentId: rec.documentId, fileId: f.id, uploadStartedAt: t.startedAt, acceptedAt: t.acceptedAt }); c.save();
  console.log(JSON.stringify(rec, null, 2));
}

// Collect every string value stored under a key that looks like a model id, anywhere in a JSON tree.
function collectModels(node, out = new Map(), path = "") {
  if (Array.isArray(node)) node.forEach((x, i) => collectModels(x, out, `${path}[${i}]`));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string" && /^(model|modelId|textModel|llmModel|embeddingModel|visionModel|modelUri)$/i.test(k)) out.set(v, (out.get(v) ?? 0) + 1);
    else collectModels(v, out, `${path}.${k}`);
  }
  return out;
}
const durMs = (s) => (s.startedAt && s.completedAt ? Date.parse(s.completedAt.replace(" ", "T").replace(/\+00$/, "Z")) - Date.parse(s.startedAt.replace(" ", "T").replace(/\+00$/, "Z")) : null);

function summarizeProgress(p) {
  const st = p.stages ?? []; const embed = st.filter(s => s.stage === "embed" && s.documentId);
  const hits = embed.reduce((a, s) => a + (s.stats?.reuseHits ?? 0), 0), misses = embed.reduce((a, s) => a + (s.stats?.reuseMisses ?? 0), 0), prov = embed.reduce((a, s) => a + (s.stats?.providerInputs ?? 0), 0);
  return { status: p.run?.status, controlState: p.run?.controlState, stage: p.progress?.currentStage, pct: p.progress?.percentComplete, pages: p.progress?.pageRollup, cost: p.progress?.usageTotals?.costCents, billed: p.progress?.usageTotals?.billedCostCents, ai: p.progress?.usageTotals?.aiCostCents,
    fee: p.progress?.usageTotals?.feeCostCents, compute: p.progress?.usageTotals?.computeCostCents, inTok: p.progress?.usageTotals?.inputTokens, outTok: p.progress?.usageTotals?.outputTokens, res: p.progress?.resourceTotals, failedDocs: p.run?.failedDocuments,
    embed: embed.length ? { reuseHits: hits, reuseMisses: misses, providerInputs: prov, documentContextReused: embed.some(s => s.stats?.documentContextReused) } : null };
}

// Real run states: run.status is queued | processing | completed | failed (there is no "cancelled" status). A cancelled run ends as
// status=failed with controlState=cancelled (immediate: queued/paused) or controlState=cancel_requested -> worker stops -> failed.
const TERMINAL = new Set(["completed", "failed"]);
const isCancelled = (p) => p?.run?.controlState === "cancelled" || (p?.run?.status === "failed" && /cancel/i.test(`${p?.run?.controlState ?? ""} ${p?.run?.error ?? ""}`));

// Cancel the run and VERIFY it: POST control (retried), then poll progress until the run is terminal / cancelled or the deadline passes.
// Returns a record that is persisted to state.cancel; confirmed=false means root must act manually.
async function cancelRun(c, runId, reason, { verifyMs = 180000, pollMs = 5000, retries = 3 } = {}) {
  const rec = { reason, requestedAt: iso(), attempts: [], confirmed: false };
  for (let i = 0; i < retries && !rec.accepted; i++) {
    const r = await c.req(`/v1/runs/${runId}/control`, { method: "POST", json: { action: "cancel" }, timeoutMs: 30000 }).catch(e => ({ ok: false, status: 0, body: String(e.message ?? e) }));
    rec.attempts.push({ at: iso(), http: r.status, controlState: r.body?.controlState ?? null, runStatus: r.body?.status ?? null, error: r.ok ? undefined : String(typeof r.body === "string" ? r.body : r.body?.error ?? "").slice(0, 200) });
    if (r.ok) rec.accepted = true; else await sleep(3000);
  }
  const deadline = now() + verifyMs;
  while (rec.accepted && now() < deadline) {
    const pr = await c.req(`/v1/runs/${runId}/progress`, { timeoutMs: 30000 }).catch(() => null);
    if (pr?.ok) { rec.final = { status: pr.body.run?.status, controlState: pr.body.run?.controlState }; if (isCancelled(pr.body) || TERMINAL.has(pr.body.run?.status)) { rec.confirmed = true; break; } }
    await sleep(pollMs);
  }
  rec.confirmedAt = rec.confirmed ? iso() : null; return rec;
}

// Run the external read-only sampler (e.g. `node --env-file=... resource-sample.mjs`; stdout = JSON array of
// { role, memAvailableKiB, lowMemory, error }; exit 2 = low memory). Awaited, so a slow sampler delays the next poll by up to its timeout.
function runSampler(cmd, d, tMs, timeoutMs = 25000) {
  return new Promise((resolveP) => {
    const p = spawn("sh", ["-c", cmd], { timeout: timeoutMs }); let out = "", err = "";
    p.stdout.on("data", x => out += x); p.stderr.on("data", x => err += x);
    p.on("error", e => finish({ code: null, signal: null, spawnError: e.message }));
    p.on("close", (code, signal) => finish({ code, signal }));
    let done = false;
    function finish({ code, signal, spawnError }) {
      if (done) return; done = true; let samples = null, parseError = null;
      try { samples = JSON.parse(out); if (!Array.isArray(samples)) throw new Error("not a JSON array"); } catch (e) { parseError = e.message; }
      const lowMemory = code === 2 || (samples ?? []).some(s => s?.lowMemory === true);
      const errors = (samples ?? []).filter(s => s?.error).map(s => `${s.role ?? "?"}: ${s.error}`);
      const ok = !spawnError && !signal && (code === 0 || code === 2) && !parseError && errors.length === 0;
      const rec = { t: iso(), tMs, code, signal, lowMemory, ok, errors, parseError, spawnError,
        samples: (samples ?? []).map(({ role, memAvailableKiB, lowMemory: lm, error, at }) => ({ role, memAvailableKiB, lowMemory: lm, error, at })), stderr: err.slice(0, 500) };
      appendJsonl(join(d, "sampler.jsonl"), rec); resolveP(rec);
    }
  });
}

async function cmdWatch(o) { // poll run progress + periodic correctness probes + sampler; write timeline.jsonl; classify milestones; enforce abort gates
  requireGo(o); const d = runDir(o); const c = client(o, d); const st = loadState(d); if (!st.runId) throw new Error("no run; upload first");
  if (!st.documentId) throw new Error("no documentId in state (upload.json); cannot judge document-scoped correctness");
  const qs = queriesFor(loadQueries(o.queries ?? DEFAULTS.queries), st.fileId); if (!qs.length) throw new Error(`no queries for document ${st.fileId}`);
  const bad = qs.flatMap(q => oracleProblems(q).map(p => `${q.id}: ${p}`)); if (bad.length) throw new Error(`invalid query oracles: ${bad.join("; ")}`);
  const ctx = { documentId: st.documentId };
  const gates = { maxWallMs: +(o["max-wall-min"] ?? 150) * 60000, maxCostCents: +(o["max-cost-cents"] ?? st.budgetCents ?? 250), feeReserve: +(o["fee-reserve-cents"] ?? st.feeReserveCents ?? 0), maxProbeCalls: +(o["max-probes"] ?? 400), maxProgressFailures: +(o["max-progress-failures"] ?? 6), maxSamplerFailures: +(o["max-sampler-failures"] ?? 3) };
  const progEvery = +(o["progress-s"] ?? 5) * 1000, probeEvery = +(o["probe-s"] ?? 30) * 1000, sampleEvery = +(o["sample-s"] ?? 30) * 1000;
  const ms = loadState(d).milestones ?? {}; const t0 = st.uploadStartedAt; let lastProbe = 0, probes = 0, rr = 0, lastSample = 0, tripped = null, lastProg = null, progFails = 0, sampFails = 0, final = null;
  const mark = (k, extra) => { if (!ms[k]) { ms[k] = { atMs: now() - t0, at: iso(), ...extra }; saveState(d, { milestones: ms }); log(`MILESTONE ${k} +${(ms[k].atMs / 1000).toFixed(1)}s`); } };
  const trip = (why) => { if (!tripped) tripped = why; };
  mark("uploadAccepted", { note: "confirm returned a run" }); ms.uploadAccepted.atMs = st.acceptedAt - t0;
  const positions = [...new Set(qs.map(q => q.position).filter(Boolean))]; const byPos = Object.fromEntries(positions.map(p => [p, false]));
  const allDone = () => positions.every(p => byPos[p]); const models = new Map();
  const search = async (q) => { const r = await c.req(`/v1/search?q=${encodeURIComponent(q.q)}&workspaceId=${st.workspaceId}&limit=${q.k}`, { timeoutMs: 60000 }); probes++;
    return { r, j: r.ok ? judge(q, r.body.results ?? [], ctx) : { correct: false, error: r.status } }; };
  while (true) {
    const tick = now(); const pr = await c.req(`/v1/runs/${st.runId}/progress`, { timeoutMs: 30000 }).catch(e => ({ ok: false, status: 0, body: String(e) }));
    if (pr.ok) { progFails = 0; lastProg = pr.body; const sm = summarizeProgress(pr.body); appendJsonl(join(d, "timeline.jsonl"), { t: iso(), tMs: tick - t0, apiMs: pr.ms, ...sm }); collectModels(pr.body).forEach((n, m) => models.set(m, n));
      if (sm.pages?.completed > 0) mark("firstPageProcessed", { pages: sm.pages });
      if (TERMINAL.has(sm.status)) { final = sm.status === "completed" ? "completed" : (isCancelled(pr.body) ? "cancelled" : "failed");
        mark(final === "completed" ? "runCompleted" : `run_${final}`, sm);
        { const billed = sm.billed ?? sm.cost ?? 0, budget = st.budgetCents ?? null; // terminal budget check: reported, never claimed as prevented
          const b = { budgetCents: budget, billedCents: billed, feeCents: sm.fee ?? 0, aiCents: sm.ai ?? 0, computeCents: sm.compute ?? 0, exceeded: budget != null && billed > budget, overByCents: budget != null && billed > budget ? +(billed - budget).toFixed(4) : 0 };
          saveState(d, { budget: b }); if (b.exceeded) { process.exitCode = process.exitCode || 7; log(`BUDGET EXCEEDED at terminal: billed ${billed.toFixed(2)}c > ${budget}c (fee ${b.feeCents}c, AI ${b.aiCents}c, compute ${b.computeCents}c); the run had already completed`); } }
        if (final === "completed") for (const q of qs.filter(x => !byPos[x.position])) { // one last correctness pass so every position gets a verdict
          const { r, j } = await search(q);
          appendJsonl(join(d, "probes.jsonl"), { t: iso(), tMs: now() - t0, phase: "post-completion", query: q.id, position: q.position, ms: r.ms, ...j });
          if (j.correct && q.position) { byPos[q.position] = true; mark(`queryable_${q.position}`, { query: q.id, postCompletion: true }); if (allDone()) mark("allPositionsQueryable", { postCompletion: true, query: q.id }); } }
        if (final === "completed" && allDone()) mark("allPositionsQueryable", { postCompletion: true });
        break; }
      // Gate on spend before the page base fee (provider usage + compute) plus the fee still to come: the fee is booked in completeRun right
      // before the run turns completed, so it cannot be prevented by polling and must not be compared with the pre-completion spend.
      const preFee = (sm.cost ?? 0) - (sm.fee ?? 0), feeToCome = Math.max(0, gates.feeReserve - (sm.fee ?? 0)), gateCost = preFee + feeToCome;
      const projected = sm.pages?.total ? preFee * (sm.pages.total / Math.max(1, sm.pages.completed)) + gates.feeReserve : null;
      if (gateCost > gates.maxCostCents) trip(`cost ${preFee.toFixed(2)}c pre-fee + ${feeToCome.toFixed(2)}c fee reserve > ${gates.maxCostCents}c`);
      else if (sm.pages?.completed >= 0.25 * (sm.pages?.total || Infinity) && projected && projected > gates.maxCostCents * 1.5) trip(`projected cost ${projected.toFixed(0)}c > 1.5x ${gates.maxCostCents}c`);
      if (tick - t0 > gates.maxWallMs) trip(`wall > ${gates.maxWallMs / 60000}min`);
      if (sm.failedDocs > 0) trip(`failed documents: ${sm.failedDocs}`);
    } else { progFails++; appendJsonl(join(d, "timeline.jsonl"), { t: iso(), tMs: tick - t0, error: `progress HTTP ${pr.status}` });
      if (progFails >= gates.maxProgressFailures) trip(`progress unreachable ${progFails}x (cost no longer visible)`); }
    if (o["sampler-cmd"] && !tripped && tick - lastSample >= sampleEvery) { lastSample = tick; const sr = await runSampler(o["sampler-cmd"], d, tick - t0);
      if (sr.lowMemory) trip(`low memory (sampler: ${sr.samples.filter(s => s.lowMemory).map(s => `${s.role} ${s.memAvailableKiB}KiB`).join(", ") || `exit ${sr.code}`})`);
      sampFails = sr.ok || sr.lowMemory ? 0 : sampFails + 1; if (sampFails >= gates.maxSamplerFailures) trip(`sampler failed ${sampFails}x in a row (host memory unobserved): ${sr.errors.join("; ") || sr.parseError || sr.spawnError || `exit ${sr.code}`}`); }
    if (tripped) { log(`ABORT GATE TRIPPED: ${tripped}`); saveState(d, { abortGate: tripped });
      if (o["auto-cancel"]) { const rec = await cancelRun(c, st.runId, tripped, { verifyMs: +(o["cancel-verify-s"] ?? 180) * 1000, pollMs: Math.min(5000, progEvery) }); saveState(d, { cancel: rec }); log(rec.confirmed ? `cancel CONFIRMED (${JSON.stringify(rec.final)})` : `CANCEL NOT CONFIRMED (accepted=${!!rec.accepted}); cancel manually: POST /v1/runs/${st.runId}/control {"action":"cancel"}`);
        if (!rec.confirmed) process.exitCode = 5; }
      else log(`NOT cancelling (no --auto-cancel); run ${st.runId} keeps spending. Cancel: POST /v1/runs/${st.runId}/control {"action":"cancel"}`);
      mark("abortGate", { tripped }); if (!process.exitCode) process.exitCode = 4; break; }
    // Probes (each is one search call; hybrid search embeds the query = small paid call). Rotate over positions not yet satisfied.
    if (tick - lastProbe >= probeEvery && probes < gates.maxProbeCalls && !allDone()) {
      lastProbe = tick; const pending = qs.filter(q => !byPos[q.position]); if (pending.length) {
        const q = pending[rr++ % pending.length]; const { r, j } = await search(q);
        appendJsonl(join(d, "probes.jsonl"), { t: iso(), tMs: tick - t0, query: q.id, position: q.position, ms: r.ms, availability: r.body?.availability, noMatch: r.body?.noMatch, serverTimings: r.body?.timings, usage: r.body?.usage, nResults: r.body?.results?.length, ...j });
        if (j.correct) { mark("firstCorrectResult", { query: q.id, position: q.position, rank: j.rank, pagesProcessedAtThatTime: lastProg?.progress?.pageRollup, availability: ((a) => a && { status: a.status, keywordOnly: a.keywordOnly, indexedDocuments: a.coverage?.indexedDocuments, searchableDocuments: a.coverage?.searchableDocuments, keywordOnlyDocuments: a.coverage?.keywordOnlyDocuments })(r.body?.availability) });
          if (q.position) { byPos[q.position] = true; mark(`queryable_${q.position}`, { query: q.id }); } if (allDone()) mark("allPositionsQueryable", {}); } }
    }
    await sleep(Math.max(0, progEvery - (now() - tick)));
  }
  if (lastProg) writeJson(join(d, "final-progress.json"), lastProg);
  saveState(d, { modelsSeenInProgress: Object.fromEntries(models), probes, finalState: final ?? "aborted" }); c.save(); await cmdReport({ ...o, "no-net": true });
}

async function cmdProbe(o) { // one-off query with timing (use after completion for latency distributions: --repeat N)
  requireGo(o); const d = runDir(o); const c = client(o, d); const st = loadState(d); if (!st.documentId) throw new Error("no documentId in state; upload first");
  const qs = queriesFor(loadQueries(o.queries ?? DEFAULTS.queries), st.fileId); const rep = +(o.repeat ?? 1); const rows = []; const ctx = { documentId: st.documentId };
  for (const q of qs.filter(x => !o.query || x.id === o.query)) for (let i = 0; i < rep; i++) {
    const r = await c.req(`/v1/search?q=${encodeURIComponent(q.q)}&workspaceId=${st.workspaceId}&limit=${q.k}`); const j = r.ok ? judge(q, r.body.results ?? [], ctx) : { correct: false, error: r.status };
    const row = { query: q.id, position: q.position, i, ms: r.ms, serverTimings: r.body?.timings, cacheHint: i > 0, ...j }; rows.push(row); appendJsonl(join(d, "probes-post.jsonl"), { t: iso(), ...row });
  }
  const acc = rows.filter(r => r.correct).length; console.log(JSON.stringify({ n: rows.length, correct: acc, p50: pct(rows.map(r => r.ms), .5), p95: pct(rows.map(r => r.ms), .95) }));
}
// Post-completion quality pass: the first query, then every other query of the ingested file, once each, identical retrieval flags in every arm.
// The API has no vector-only switch (SearchOptions / parseRetrievalQueryFlags), so retrieval stays hybrid; the flags below remove LLM query
// rewriting, reranking, graph expansion and, because score scales differ across embedding models, the relevance floor (minScore=0).
export const QUALITY_FLAGS = "hyde=false&rerank=false&mmr=false&summarySeed=false&compression=false&queryRewrite=false&queryDecompose=false&stepback=false&selfQuery=false&iterativeMultiHop=false&graphExpansion=false&communityExpansion=false&minScore=0";
async function cmdQuality(o) {
  requireGo(o); const d = runDir(o); const c = client(o, d); const st = loadState(d); if (!st.documentId) throw new Error("no documentId in state; upload first");
  if (st.finalState !== "completed") throw new Error(`run finalState is ${st.finalState ?? "unknown"}, not completed: quality is only measured on a completed run`);
  const flags = typeof o["search-flags"] === "string" ? o["search-flags"] : QUALITY_FLAGS; const qs = queriesFor(loadQueries(o.queries ?? DEFAULTS.queries), st.fileId); const ctx = { documentId: st.documentId };
  if (existsSync(join(d, "quality.jsonl"))) throw new Error("quality.jsonl exists; refusing to mix passes (move it away first)");
  for (const [i, q] of qs.entries()) {
    const r = await c.req(`/v1/search?q=${encodeURIComponent(q.q)}&workspaceId=${st.workspaceId}&limit=10&${flags}`, { timeoutMs: 60000 }); const res = r.ok ? (r.body.results ?? []) : [];
    appendJsonl(join(d, "quality.jsonl"), { t: iso(), query: q.id, position: q.position, order: i, firstQuery: i === 0, ms: r.ms, http: r.status, flags, availability: r.body?.availability?.status, noMatch: r.body?.noMatch, nResults: res.length,
      topPages: res.map(x => x.citation?.pageNumber ?? null), lexicalRanks: res.flatMap((x, k) => (x.lexicalMatch ? [k + 1] : [])), ...(r.ok ? judge(q, res, ctx) : { correct: false, error: r.status }) });
  }
  console.log(JSON.stringify(readJsonl(join(d, "quality.jsonl")).map(({ query, position, correct, rank, ms }) => ({ query, position, correct, rank, ms }))));
}
const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));

// Offline verdict: candidate vs baseline quality. Not a pass unless the baseline completed and both arms answered the same queries with the same flags.
// A pass is a screen (n = number of queries), never a causal claim: the candidate changes the embedding model and runtime together.
async function cmdCompare(o) {
  const dir = (label) => join(o.out ?? DEFAULTS.out, label); const load = (label) => { const d = dir(label), qp = join(d, "quality.jsonl"); return { label, st: loadState(d), rows: existsSync(qp) ? readJsonl(qp) : [] }; };
  if (!o.label || !o.against) throw new Error("usage: compare --label <candidate> --against <baseline>"); const cand = load(o.label), base = load(o.against); const reasons = [];
  for (const a of [base, cand]) {
    if (a.st.finalState !== "completed") reasons.push(`${a.label}: run did not complete (finalState=${a.st.finalState ?? "unknown"}${a.st.cancel ? `, cancel confirmed=${a.st.cancel.confirmed}` : ""}${a.st.abortGate ? `, gate: ${a.st.abortGate}` : ""})`);
    if (!a.rows.length) reasons.push(`${a.label}: no quality.jsonl`);
  }
  if (base.st.fileId !== cand.st.fileId) reasons.push(`different source files (${base.st.fileId} vs ${cand.st.fileId}): not a matched pair`);
  if (base.rows.length && cand.rows.length && (base.rows.length !== cand.rows.length || base.rows.some((r, i) => r.query !== cand.rows[i].query || r.flags !== cand.rows[i].flags))) reasons.push("query set or retrieval flags differ between arms");
  const stats = (rows) => ({ n: rows.length, correct: rows.filter(r => r.correct).length, mrr: rows.length ? +(rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rows.length).toFixed(3) : null, firstQueryMs: rows[0]?.ms ?? null, p50Ms: pct(rows.map(r => r.ms), .5) });
  const out = { candidate: { label: cand.label, embedding: cand.st.embeddingProfile ?? "default (good-fast-local)", ...stats(cand.rows) }, baseline: { label: base.label, embedding: base.st.embeddingProfile ?? "default (good-fast-local)", ...stats(base.rows) },
    perQuery: cand.rows.map((r, i) => ({ query: r.query, position: r.position, baselineRank: base.rows[i]?.rank ?? null, candidateRank: r.rank ?? null })),
    caveats: ["embedding model and runtime change together (local bge-m3 vs hosted OpenAI): a quality or speed difference is not attributable to the model alone", "retrieval stays hybrid (no vector-only API switch): lexical matches can mask embedding differences, so equal results do not prove equal embeddings",
      "small n: this screens for regressions, it does not rank models", "no end-to-end causal claim: arms differ in file reuse state and cost accounting; see report.json reuseDetail"] };
  if (!reasons.length) { const lost = out.perQuery.filter(p => p.baselineRank && !p.candidateRank).map(p => p.query);
    if (out.baseline.correct < out.baseline.n) reasons.push(`baseline itself missed ${out.baseline.n - out.baseline.correct} queries; gate requires every query correct`);
    if (out.candidate.correct < out.candidate.n) reasons.push(`candidate missed ${out.candidate.n - out.candidate.correct} queries`);
    if (lost.length) reasons.push(`candidate lost queries the baseline answered: ${lost.join(", ")}`); }
  out.verdict = reasons.length ? "not-pass" : "pass"; out.reasons = reasons; console.log(JSON.stringify(out, null, 2)); if (reasons.length) process.exitCode = 2;
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

async function cmdReport(o) { // classification + stage table + cold/warm + model verification; offline unless run is live
  const d = runDir(o); const st = loadState(d); const up = existsSync(join(d, "upload.json")) ? readJson(join(d, "upload.json")) : null; let prog = null;
  if (!o["no-net"] && o.go && st.runId) { const c = client(o, d); const r = await c.req(`/v1/runs/${st.runId}/progress`); if (r.ok) { prog = r.body; writeJson(join(d, "final-progress.json"), prog); } }
  else if (existsSync(join(d, "final-progress.json"))) prog = readJson(join(d, "final-progress.json"));
  if (!prog && st.runId && o.go) { const c = client(o, d); const r = await c.req(`/v1/runs/${st.runId}/progress`); if (r.ok) { prog = r.body; writeJson(join(d, "final-progress.json"), prog); } }
  const sm = prog ? summarizeProgress(prog) : null; const stages = (prog?.stages ?? []).map(s => ({ stage: s.stage, doc: s.documentId ? "doc" : "run", status: s.status, attempts: s.attempts, ms: durMs(s), startedAt: s.startedAt, durationMsStat: s.stats?.durationMs, error: s.error }));
  const models = prog ? Object.fromEntries(collectModels(prog)) : {}; const textLike = Object.keys(models).filter(m => /\//.test(m) || /glm|qwen|gpt|claude/i.test(m));
  let reuse = "unknown"; if (sm?.embed) { const e = sm.embed; reuse = (e.reuseHits === 0 && !e.documentContextReused && !up?.dedupedFromDocumentId) ? "cold" : (e.reuseMisses === 0 && e.providerInputs === 0 ? "warm-full-reuse" : "warm-partial-reuse"); }
  if (up?.dedupedFromDocumentId) reuse = `deduped-${up.dedupScope}`;
  const ms = st.milestones ?? {}; const mf = loadManifest(o.manifest ?? DEFAULTS.manifest).find(f => f.id === st.fileId);
  const rep = { finalState: st.finalState ?? null, cancel: st.cancel ?? null, pagesExpected: mf?.pageCount ?? null, pagesMatchManifest: mf?.pageCount && sm?.pages?.total != null ? sm.pages.total === mf.pageCount : null,
    uploadWarnings: up?.warnings ?? null, label: o.label, runId: st.runId, workspaceId: st.workspaceId, profile: st.profile, file: up && { id: up.file, sizeBytes: up.sizeBytes, sha256: up.sha256 }, classification: reuse, coldClaimAllowed: reuse === "cold",
    upload: up && { mode: up.mode, uploadMs: up.uploadMs, MBps: up.uploadMBps, sessionMs: up.sessionMs, confirmMs: up.confirmMs },
    milestonesSecFromUploadStart: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, +(v.atMs / 1000).toFixed(1)])), abortGate: st.abortGate ?? null, final: sm, stages,
    pagesPerMin: sm?.pages?.total && ms.runCompleted ? +(sm.pages.total / ((ms.runCompleted.atMs - (ms.uploadAccepted?.atMs ?? 0)) / 60000)).toFixed(1) : null,
    modelCheck: { expectedText: st.textModel, expectedVisionUri: VISION_MODEL_URI, modelsSeenInRunPayloads: models, nonExpectedTextLike: textLike.filter(m => m !== st.textModel), note: "progress payloads omit per-call models; authoritative check is usage_events / [ai-usage] logs (see plan.md section 'Model verification')" } };
  // Embedding arm record + reuse split. `classification` above is derived from embed stats alone; for a new embedding model chunk vectors are cold
  // by construction (vector fingerprint includes provider/model/dimensions) while the LLM document context (key excludes the embedding model) and
  // extraction/source caches may be warm. Never fold these into one "cold" claim.
  const rp = prog?.run?.pipeline?.embedding, e = sm?.embed;
  rep.embedding = { flag: st.embeddingProfile ?? null, requested: st.embedding ?? null, uploadEffective: up?.effectiveRunConfig?.embedding ?? null, uploadConfigOk: up?.embeddingConfigOk ?? null,
    progressEffective: rp ? { profile: rp.profile, modelUri: rp.modelUri, target: rp.target } : null, progressMatches: st.embedding && rp ? embeddingMatches(rp, st.embedding) : null };
  rep.reuseDetail = { dedup: up?.dedupedFromDocumentId ? up.dedupScope : null,
    extractionSourceCache: (prog?.stages ?? []).filter(s => s.documentId && s.stats && ("cacheHit" in s.stats || "sourceCacheHit" in s.stats)).map(s => ({ stage: s.stage, cacheHit: s.stats.cacheHit, sourceCacheHit: s.stats.sourceCacheHit })),
    embeddingVectors: e ? (e.reuseHits === 0 ? "cold" : e.reuseMisses === 0 && e.providerInputs === 0 ? "full-reuse" : "partial-reuse") : "unknown", documentContext: e ? (e.documentContextReused ? "reused" : "fresh") : "unknown" };
  // Early publication: was a correct result served before embedding finished, and how (keyword-only vs vector)? Times are seconds from upload start.
  const ts = (x) => (x ? Date.parse(String(x).replace(" ", "T").replace(/\+00$/, "Z")) : null), sec = (t) => (t != null && st.uploadStartedAt ? +((t - st.uploadStartedAt) / 1000).toFixed(1) : null);
  const stg = (name) => (prog?.stages ?? []).find(x => x.stage === name && x.documentId); const fc = ms.firstCorrectResult, embedDone = sec(ts(stg("embed")?.completedAt));
  rep.earlyPublication = { firstCorrectSec: fc ? +(fc.atMs / 1000).toFixed(1) : null, firstCorrectQuery: fc?.query ?? null, firstCorrectAvailability: fc?.availability ?? null, firstCorrectKeywordOnly: fc?.availability?.keywordOnly ?? null,
    embedStartedSec: sec(ts(stg("embed")?.startedAt)), embedCompletedSec: embedDone, indexCompletedSec: sec(ts(stg("index")?.completedAt)), runCompletedSec: ms.runCompleted ? +(ms.runCompleted.atMs / 1000).toFixed(1) : null,
    firstCorrectBeforeEmbedComplete: fc && embedDone != null ? fc.atMs / 1000 < embedDone : null };
  // Budget, customer ledger vs provider usage kept apart. fee = per-page base fee booked at completion; provider = aiCostCents; compute = billed worker compute.
  rep.ledger = sm && { billedCents: sm.billed, feeCents: sm.fee, aiCents: sm.ai, computeCents: sm.compute, note: "provider usage = aiCents; customer ledger total = billedCents (fee and compute are internal debits, not API charges)" };
  rep.budget = st.budget ?? (st.budgetCents != null && sm ? { budgetCents: st.budgetCents, billedCents: sm.billed, exceeded: sm.billed > st.budgetCents } : null);
  const rd = (f) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []), samp = rd("sampler.jsonl"), health = rd("health.jsonl");
  const minMem = (role) => samp.flatMap(r => r.samples ?? []).filter(x => x.role === role && x.memAvailableKiB != null).reduce((m, x) => Math.min(m, x.memAvailableKiB), Infinity);
  rep.resources = { samplerPolls: samp.length, samplerFailures: samp.filter(r => !r.ok && !r.lowMemory).length, lowMemoryPolls: samp.filter(r => r.lowMemory).length, minWorkerMemAvailableMiB: Number.isFinite(minMem("worker")) ? Math.round(minMem("worker") / 1024) : null, minAppMemAvailableMiB: Number.isFinite(minMem("app")) ? Math.round(minMem("app") / 1024) : null,
    readinessPolls: health.filter(r => "ready" in r).length, readinessFailures: health.filter(r => r.ready === false).length, maxConsecutiveReadinessFailures: Math.max(0, ...health.map(r => r.consecutiveFailures ?? 0)) };
  writeJson(join(d, "report.json"), rep); if (!o.quiet) console.log(JSON.stringify(rep, null, 2)); return rep;
}

const COMMANDS = { check: cmdCheck, login: cmdLogin, preflight: cmdPreflight, prepare: cmdPrepare, upload: cmdUpload, watch: cmdWatch, probe: cmdProbe, quality: cmdQuality, compare: cmdCompare, report: cmdReport };
if (import.meta.url === `file://${process.argv[1]}`) {
  const { cmd, o } = parseArgs(process.argv.slice(2));
  if (!COMMANDS[cmd]) { console.error(`usage: bench.mjs <${Object.keys(COMMANDS).join("|")}> --label L [--go] ...`); process.exit(1); }
  COMMANDS[cmd](o).catch(e => { console.error(`[bench] ERROR: ${e.message}`); process.exit(1); });
}
