// Usage: node bench.mjs <fixtureDir> <label> [outDir]
// Uploads every file in fixtureDir in ONE bulk request to the perf workspace, waits for the run to finish,
// and writes per-stage wall/CPU, DB transaction deltas and a quality fingerprint to <outDir>/<label>.json.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
const [dir, label, outDir = "results"] = process.argv.slice(2);
const D = "/home/dan/tmp/agents/perf-c";
const key = readFileSync(`${D}/key.txt`, "utf8").trim();
const workerPid = readFileSync(`${D}/worker.pid`, "utf8").trim();
const WS = "seed-shared-workspace";
const psql = (sql) => execFileSync("docker", ["exec", "docslurp-alt-postgres-1", "psql", "-U", "docslurp", "-d", "docslurp_perf_ingest", "-AtF", "\t", "-c", sql], { encoding: "utf8" }).trim();
const rows = (sql) => psql(sql).split("\n").filter(Boolean).map((l) => l.split("\t"));
function procTree(pid) { // exact descendants of the worker pid
  const out = [pid]; const q = [pid];
  while (q.length) { const p = q.shift(); try { for (const c of readFileSync(`/proc/${p}/task/${p}/children`, "utf8").trim().split(/\s+/).filter(Boolean)) { out.push(c); q.push(c); } } catch {} }
  return out;
}
const hz = 100;
function cpuSeconds() { let t = 0; for (const p of procTree(workerPid)) { try { const f = readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" "); t += (+f[11] + +f[12] + +f[13] + +f[14]) / hz; } catch {} } return t; }
function rssMb() { let t = 0; for (const p of procTree(workerPid)) { try { t += +/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p}/status`, "utf8"))[1] / 1024; } catch {} } return Math.round(t); }

// Fresh state: remove prior documents so source-hash dedup cannot short-circuit the run.
psql(`delete from documents where workspace_id='${WS}'`);
const xact0 = +psql("select xact_commit+xact_rollback from pg_stat_database where datname=current_database()");
const cpu0 = cpuSeconds();
const form = new FormData();
form.set("workspace", WS);
const files = readdirSync(dir).sort();
for (const f of files) form.append("files", new Blob([readFileSync(path.join(dir, f))]), f);
const t0 = Date.now();
const res = await fetch("http://127.0.0.1:8797/v1/uploads/bulk", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
const up = await res.json();
const uploadMs = Date.now() - t0;
const runId = up.runId ?? up.run?.id ?? up.runs?.[0]?.id ?? up.documents?.[0]?.runId;
if (!runId) { console.error(JSON.stringify(up).slice(0, 800)); process.exit(1); }
let status = "", peakRss = 0;
while (Date.now() - t0 < 25 * 60e3) {
  await new Promise((r) => setTimeout(r, 500));
  peakRss = Math.max(peakRss, rssMb());
  status = psql(`select status from workspace_runs where id='${runId}'`);
  if (["completed", "failed", "completed_with_errors", "cancelled", "dead_lettered"].includes(status)) break;
}
const wallMs = Date.now() - t0;
const cpu1 = cpuSeconds();
await new Promise((r) => setTimeout(r, 1500));
const xact1 = +psql("select xact_commit+xact_rollback from pg_stat_database where datname=current_database()");
const run = rows(`select status, pages_total, pages_processed, total_documents, extract(epoch from (updated_at-created_at)), coalesce(extract(epoch from (workflow_started_at-created_at)),-1), spent_cents from workspace_runs where id='${runId}'`)[0];
const stages = rows(`select stage_name, count(*), round(extract(epoch from (max(completed_at)-min(started_at)))::numeric,2), round(sum(extract(epoch from (completed_at-started_at)))::numeric,2), min(started_at)::text from document_run_stage_states where run_id='${runId}' group by stage_name order by min(started_at)`)
  .map(([name, docs, span, sumdoc, first]) => ({ name, docs: +docs, spanS: +span, sumDocS: +sumdoc, first }));
const quality = rows(`select d.filename, d.status, d.page_count, d.chunk_count, md5(coalesce((select string_agg(text, '|' order by page_number) from document_pages p where p.document_id=d.id),'')), md5(coalesce((select string_agg(text, '|' order by chunk_index) from document_chunks c where c.document_id=d.id),'')), (select count(*) from document_page_vectors v where v.document_id=d.id) from documents d where d.run_id='${runId}' order by d.filename`)
  .map(([filename, st, pages, chunks, pagesMd5, chunksMd5, vecs]) => ({ filename, status: st, pages: +pages, chunks: +chunks, pagesMd5, chunksMd5, pageVectors: +vecs }));
const pages = +run[1];
const out = { label, runId, files, status, runStatus: run[0], pages, docs: +run[3], wallS: wallMs / 1000, uploadMs, runRowS: +run[4], startLagS: +run[5], pagesPerMin: +(pages / (wallMs / 60000)).toFixed(2), min100pages: +(100 / (pages / (wallMs / 60000))).toFixed(2), workerCpuS: +(cpu1 - cpu0).toFixed(1), peakRssMb: peakRss, dbXacts: xact1 - xact0, dbXactsPerDoc: +((xact1 - xact0) / Math.max(1, +run[3])).toFixed(1), spentCents: +run[6], stages, quality };
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ label, status, pages, wallS: out.wallS, pagesPerMin: out.pagesPerMin, cpuS: out.workerCpuS, xacts: out.dbXacts, rssMb: peakRss }));
console.log(stages.map((s) => `${s.name}:${s.spanS}s(sum ${s.sumDocS})`).join("  "));
