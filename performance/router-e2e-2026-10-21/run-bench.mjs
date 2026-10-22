// End-to-end paired benchmark orchestration: real API upload -> Temporal worker -> MinIO + Postgres.
// Arm A: production routing policy (router shadow, layout off). Arm B: same + layout shadow with audits.
// Orchestration only. Usage (from core root):
//   node performance/router-e2e-2026-10-21/run-bench.mjs <run-dir> [--blocks 4] [--limit N] [--spend-cap-usd 4.5]
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const postgres = require("postgres");
const here = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const run = path.resolve(args[0] ?? "");
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const blocks = Number(opt("blocks", 4));
const limit = Number(opt("limit", 0));
const spendCapUsd = Number(opt("spend-cap-usd", 4.5));
const tag = opt("tag", "e2e");
if (!existsSync(path.join(run, "corpus/corpus.json"))) throw new Error("run dir must contain corpus/corpus.json");

const env = Object.fromEntries(readFileSync(path.join(run, "env/base.env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const api = env.API_URL;
const sql = postgres(env.DATABASE_URL, { max: 2, onnotice: () => {} });
const minioToken = readFileSync(path.join(run, "env/minio-prom.token"), "utf8").trim();
const out = path.join(run, `raw-${tag}`);
mkdirSync(out, { recursive: true });
const samplesFile = path.join(out, "samples.jsonl");
const log = (...m) => { const line = `[bench ${new Date().toISOString()}] ${m.join(" ")}`; console.log(line); appendFileSync(path.join(out, "bench.log"), `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- accounts ----------
async function signIn() {
  const res = await fetch(`${api}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: api }, body: JSON.stringify({ email: "admin@docslurp.local", password: "testtest" }) });
  if (!res.ok) throw new Error(`sign-in ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function ensureOrg(cookie, orgId) {
  const [user] = await sql`select id from "user" where email = 'admin@docslurp.local'`;
  await sql`insert into organizations (id,name,slug,is_personal,created_by_user_id,credit_balance_cents,monthly_budget_cents)
    values (${orgId}, ${orgId}, ${orgId}, false, ${user.id}, 1000000, 1000000) on conflict (id) do nothing`;
  await sql`insert into org_memberships (org_id,user_id,role) values (${orgId}, ${user.id}, 'owner') on conflict do nothing`;
  // Default pipeline ('{}'): the product defaults a new user workspace gets.
  await sql`insert into workspaces (id,org_id,user_id,name,pipeline,is_default,monthly_budget_cents)
    values (${`${orgId}-ws`}, ${orgId}, ${user.id}, ${orgId}, '{}'::jsonb, true, 1000000) on conflict (id) do nothing`;
  await sql`insert into workspace_members (workspace_id,user_id,role,invited_by_user_id) values (${`${orgId}-ws`}, ${user.id}, 'admin', ${user.id}) on conflict do nothing`;
  const res = await fetch(`${api}/v1/api-keys`, { method: "POST", headers: { "content-type": "application/json", origin: api, cookie }, body: JSON.stringify({ name: `bench-${orgId}`, orgId }) });
  if (!res.ok) throw new Error(`api key ${res.status} ${await res.text()}`);
  return { orgId, workspaceId: `${orgId}-ws`, key: (await res.json()).rawKey };
}

// ---------- process + storage meters ----------
const clk = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
function procStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(status)?.[1] ?? 0);
    // utime, stime, cutime, cstime (children reaped by the worker: pdftoppm, tesseract, ...)
    return { cpuSec: (Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14])) / clk, rssKb: kb("VmRSS"), hwmKb: kb("VmHWM") };
  } catch { return null; }
}
async function minio() {
  const res = await fetch(`${env.AWS_ENDPOINT_URL_S3}/minio/v2/metrics/cluster`, { headers: { authorization: `Bearer ${minioToken}` } });
  const text = await res.text();
  const requests = {};
  let sent = 0, received = 0;
  for (const line of text.split("\n")) {
    let m = /^minio_s3_requests_total\{api="([^"]+)"[^}]*\} ([0-9.e+]+)/.exec(line);
    if (m) requests[m[1]] = (requests[m[1]] ?? 0) + Number(m[2]);
    m = /^minio_s3_traffic_sent_bytes\{[^}]*\} ([0-9.e+]+)/.exec(line); if (m) sent += Number(m[1]);
    m = /^minio_s3_traffic_received_bytes\{[^}]*\} ([0-9.e+]+)/.exec(line); if (m) received += Number(m[1]);
  }
  return { requests, sent, received };
}
const diff = (a, b) => ({ requests: Object.fromEntries(Object.keys({ ...a.requests, ...b.requests }).map((k) => [k, (b.requests[k] ?? 0) - (a.requests[k] ?? 0)]).filter(([, v]) => v)), sentBytes: b.sent - a.sent, receivedBytes: b.received - a.received });

// ---------- worker lifecycle ----------
const pidFile = path.join(run, "logs/worker.pid");
const layoutPid = Number(readFileSync(path.join(run, "logs/layout-service.pid"), "utf8"));
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function stopWorker() {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (!alive(pid)) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 600 && alive(pid); i++) await sleep(500);
  if (alive(pid)) throw new Error(`worker ${pid} did not stop`);
}
async function startWorker(arm) {
  await stopWorker();
  const logFile = path.join(run, `logs/worker-${arm}.log`);
  const before = existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0;
  const r = spawnSync(path.join(here, "start-worker.sh"), [arm, run], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`start-worker failed: ${r.stderr}`);
  for (let i = 0; i < 240; i++) {
    const text = readFileSync(logFile, "utf8").slice(before);
    if (text.includes("state: 'RUNNING'")) break;
    if (i === 239) throw new Error("worker did not reach RUNNING");
    await sleep(500);
  }
  await sleep(3000); // let startup sweeps settle before measuring
  return Number(readFileSync(pidFile, "utf8"));
}

// ---------- spend guard ----------
async function benchSpendUsd() {
  const [row] = await sql`select coalesce(sum(cost_cents),0)::float8 as cents from usage_attribution where org_id like 'bench-%' and provider not in ('local','local-compute','docslurp')`;
  return row.cents / 100;
}

// ---------- one document ----------
async function ingest(account, item, arm, block, workerPid, warmup = false) {
  const file = path.join(run, "corpus/files", item.file);
  const bytes = readFileSync(file);
  const form = new FormData();
  form.set("workspaceId", account.workspaceId);
  form.append("files", new Blob([bytes]), item.file);
  const m0 = await minio(); const w0 = procStat(workerPid); const l0 = procStat(layoutPid);
  let peakWorkerRssKb = w0?.rssKb ?? 0, peakLayoutRssKb = l0?.rssKb ?? 0;
  const t0 = Date.now();
  const res = await fetch(`${api}/v1/uploads/bulk`, { method: "POST", headers: { authorization: `Bearer ${account.key}`, origin: api }, body: form });
  const uploadMs = Date.now() - t0;
  const body = await res.json().catch(() => ({}));
  const runId = body.runId ?? body.run?.id ?? body.runs?.[0]?.id ?? body.jobs?.[0]?.runId;
  if (!res.ok || !runId) return { arm, block, item: item.file, error: `upload ${res.status} ${JSON.stringify(body).slice(0, 300)}` };
  let status = "queued", timedOut = false;
  const deadline = Date.now() + 15 * 60_000;
  while (true) {
    const [r] = await sql`select status from workspace_runs where id = ${runId}`;
    status = r?.status;
    const w = procStat(workerPid); const l = procStat(layoutPid);
    if (w) peakWorkerRssKb = Math.max(peakWorkerRssKb, w.rssKb);
    if (l) peakLayoutRssKb = Math.max(peakLayoutRssKb, l.rssKb);
    if (status === "completed" || status === "failed") break;
    if (Date.now() > deadline) { timedOut = true; break; }
    await sleep(250);
  }
  const wallMs = Date.now() - t0;
  await sleep(1500); // let trailing async writes (usage flush, artifact ledger) land
  const m1 = await minio(); const w1 = procStat(workerPid); const l1 = procStat(layoutPid);
  const [times] = await sql`select created_at, workflow_started_at, updated_at from workspace_runs where id = ${runId}`;
  const sample = { arm, block, warmup, source: item.source, id: item.id, kind: item.kind, file: item.file, pages: item.pages, orgId: account.orgId, runId, status, timedOut,
    uploadMs, wallMs, runCreatedAt: times?.created_at, runWorkflowStartedAt: times?.workflow_started_at, runUpdatedAt: times?.updated_at,
    storage: diff(m0, m1),
    workerCpuSec: w0 && w1 ? w1.cpuSec - w0.cpuSec : null, layoutCpuSec: l0 && l1 ? l1.cpuSec - l0.cpuSec : null,
    peakWorkerRssKb, peakLayoutRssKb, workerHwmKb: w1?.hwmKb ?? null, layoutHwmKb: l1?.hwmKb ?? null };
  appendFileSync(samplesFile, `${JSON.stringify(sample)}\n`);
  return sample;
}

// ---------- schedule ----------
const corpus = JSON.parse(readFileSync(path.join(run, "corpus/corpus.json"), "utf8"));
let items = [...corpus.items].sort((a, b) => createHash("sha256").update(`${tag}:${a.sha256}`).digest("hex").localeCompare(createHash("sha256").update(`${tag}:${b.sha256}`).digest("hex")));
if (limit) items = items.slice(0, limit);
const blockItems = Array.from({ length: blocks }, (_, b) => items.filter((_, i) => i % blocks === b));
const abba = ["AB", "BA", "BA", "AB"];
const warmups = corpus.warmup ?? [];

const cookie = await signIn();
const accounts = { A: await ensureOrg(cookie, `bench-${tag}-a`), B: await ensureOrg(cookie, `bench-${tag}-b`), W: await ensureOrg(cookie, `bench-${tag}-warm`) };
const spendStart = await benchSpendUsd();
log(`start tag=${tag} documents=${items.length} pages=${items.reduce((n, i) => n + i.pages, 0)} blocks=${blocks} spendSoFarUsd=${spendStart.toFixed(4)} capUsd=${spendCapUsd}`);
writeFileSync(path.join(out, "schedule.json"), JSON.stringify({ tag, blocks: blockItems.map((b, i) => ({ order: abba[i % 4], items: b.map((x) => x.file) })), warmups: warmups.map((w) => w.file) }, null, 2));

let currentArm = null, workerPid = null, stopped = false;
for (let b = 0; b < blocks && !stopped; b++) {
  for (const arm of abba[b % 4]) {
    if (arm !== currentArm) {
      workerPid = await startWorker(arm); currentArm = arm;
      log(`worker arm=${arm} pid=${workerPid}; warmup ${warmups.length}`);
      for (const w of warmups) await ingest(accounts.W, w, arm, b, workerPid, true);
    }
    for (const item of blockItems[b]) {
      const spent = await benchSpendUsd();
      if (spent >= spendCapUsd) { log(`STOP spend ${spent.toFixed(4)} >= cap ${spendCapUsd}`); stopped = true; break; }
      const s = await ingest(accounts[arm], item, arm, b, workerPid);
      log(`block=${b} arm=${arm} ${item.file} status=${s.status ?? s.error} wallMs=${s.wallMs} spentUsd=${spent.toFixed(4)}`);
    }
    if (stopped) break;
  }
}
await stopWorker();
log(`done spendUsd=${(await benchSpendUsd()).toFixed(4)}`);
await sql.end();
