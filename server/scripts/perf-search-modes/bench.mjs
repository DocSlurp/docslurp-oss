// Search-mode cost bench: node bench.mjs <config.json>
// Each session = fresh API server process (no warm response cache), warm-up queries, then a measured pass of
// authenticated GET /v1/search requests. CPU is read from /proc (API process) and the cgroups of the Postgres, MinIO
// and Redis containers; idle CPU measured before the pass is subtracted. Statement counts from pg_stat_statements.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import postgres from "postgres";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const env = { ...process.env, ...cfg.env };
const sql = postgres(cfg.adminDatabaseUrl ?? env.DATABASE_URL, { max: 2, onnotice: () => {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK = 100; // CLK_TCK
const procCpuMs = (pid) => { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return (Number(f[11]) + Number(f[12])) * 1000 / TICK; };
const cg = Object.fromEntries(cfg.containers.map((name) => [name, `/sys/fs/cgroup/system.slice/docker-${JSON.parse(readFileSync(`${cfg.out}/ids.json`, "utf8"))[name]}.scope/cpu.stat`]));
const cgMs = (name) => Number(/usage_usec (\d+)/.exec(readFileSync(cg[name], "utf8"))[1]) / 1000;
import { readdirSync } from "node:fs";
const threadCpu = (pid) => { const out = {}; for (const t of readdirSync(`/proc/${pid}/task`)) { try { const raw = readFileSync(`/proc/${pid}/task/${t}/stat`, "utf8"); const name = raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")")).replace(/[0-9]+$/, "#"); const f = raw.split(") ")[1].split(" "); out[name] = (out[name] ?? 0) + (Number(f[11]) + Number(f[12])) * 1000 / TICK; } catch {} } return out; };
const snap = (pid) => ({ t: performance.now(), api: procCpuMs(pid), ...Object.fromEntries(cfg.containers.map((n) => [n, cgMs(n)])) });
const diff = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, b[k] - a[k]]));

async function makeKey(mode) {
  const raw = `dslp_priv_${randomBytes(32).toString("hex")}`;
  const id = `bench-${mode}-${randomBytes(4).toString("hex")}`;
  await sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes, rate_limit_ppd)
    values (${id}, 'benchu', 'benchorg', ${createHash("sha256").update(raw).digest("hex")}, ${id}, 'server', ${"{search:" + mode + "}"}::text[], 100000000)`;
  return raw;
}

async function startServer(extraEnv, nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, "--import", "tsx", "src/main.ts"], { cwd: extraEnv.__serverDir ?? cfg.serverDir, env: { ...env, ...extraEnv, PORT: String(cfg.port) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 300; i++) {
    await sleep(200);
    try { const r = await fetch(`http://127.0.0.1:${cfg.port}/health`); if (r.ok) return { child, log: () => log }; } catch {}
    if (child.exitCode !== null) break;
  }
  throw new Error(`server did not start:\n${log.slice(-3000)}`);
}

async function one(key, project, mode, q) {
  const u = new URL(`http://127.0.0.1:${cfg.port}/v1/search`);
  u.searchParams.set("q", q.q); u.searchParams.set("project", project); u.searchParams.set("limit", "10");
  if (cfg.sendMode !== false) u.searchParams.set("mode", mode);
  for (const [k, v] of Object.entries(cfg.query ?? {})) u.searchParams.set(k, v);
  const t = performance.now();
  const r = await fetch(u, { headers: { authorization: `Bearer ${key}` } });
  const body = await r.text();
  const wall = performance.now() - t;
  let j = null; try { j = JSON.parse(body); } catch {}
  const results = j?.results ?? [];
  return { id: q.id, status: r.status, wall, mode: j?.mode ?? j?.searchMode, ids: results.map((x) => x.id ?? `${x.citation?.documentId}-${x.citation?.chunkIndex}`), docs: results.map((x) => x.citation?.documentId ?? x.documentId), err: r.ok ? undefined : body.slice(0, 300) };
}

async function session(arm, mode, project, queries, warm, rep) {
  const key = await makeKey(mode);
  const srv = await startServer({ ...(arm.env ?? {}), ...(arm.serverDir ? { __serverDir: arm.serverDir } : {}) }, arm.nodeArgs ?? []);
  const pid = srv.child.pid;
  try {
    for (const q of warm) await one(key, project, mode, q);
    await sleep(1500);
    const i0 = snap(pid); await sleep(cfg.idleMs ?? 4000); const i1 = snap(pid);
    const idleRate = Object.fromEntries(Object.entries(diff(i0, i1)).map(([k, v]) => [k, k === "t" ? v : v / (i1.t - i0.t)]));
    await sql`select pg_stat_statements_reset()`;
    const s0 = snap(pid);
    const th0 = threadCpu(pid);
    const runs = [];
    let i = 0;
    await Promise.all(Array.from({ length: cfg.concurrency }, async () => { for (;;) { const q = queries[i++]; if (!q) return; runs.push(await one(key, project, mode, q)); } }));
    const tRun = performance.now() - s0.t;
    await sleep(cfg.drainMs ?? 2500);
    const s1 = snap(pid);
    const th1 = threadCpu(pid);
    const threads = Object.fromEntries(Object.entries(th1).map(([k, v]) => [k, (v - (th0[k] ?? 0)) / runs.length]).filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1]));
    // Idle again after the pass; background bursts (autovacuum, sweeps) in either window inflate it, so use the lower.
    await sleep(cfg.idleMs ?? 4000); const s2 = snap(pid);
    const post = diff(s1, s2);
    for (const k of Object.keys(idleRate)) if (k !== "t") idleRate[k] = Math.min(idleRate[k], post[k] / post.t);
    const d = diff(s0, s1);
    const cpu = Object.fromEntries(Object.entries(d).filter(([k]) => k !== "t").map(([k, v]) => [k, (v - idleRate[k] * d.t) / runs.length]));
    const [st] = await sql`select coalesce(sum(calls),0)::float as calls, coalesce(sum(total_exec_time),0)::float as exec_ms from pg_stat_statements where query not ilike '%pg_stat_statements%'`;
    const top = await sql`select calls, round(total_exec_time::numeric,1)::float as ms, left(regexp_replace(query, '\\s+', ' ', 'g'), 140) as q from pg_stat_statements where query not ilike '%pg_stat_statements%' order by calls desc limit 25`;
    // Gate: an empty search is not a fast sample.
    const withResults = runs.filter((r) => r.status === 200 && r.ids.length > 0).length / runs.length;
    if (withResults < (cfg.minWithResults ?? 0.9)) throw new Error(`only ${(withResults * 100).toFixed(0)}% of searches returned results; corpus or setup is broken`);
    const walls = runs.map((r) => r.wall).sort((a, b) => a - b);
    const pct = (p) => walls[Math.min(walls.length - 1, Math.floor(p * walls.length))];
    const res = { withResults, threads, arm: arm.name, mode, project, rep, n: runs.length, conc: cfg.concurrency, wallRunMs: tRun, qps: runs.length / (tRun / 1000),
      errors: runs.filter((r) => r.status !== 200).length, modes: [...new Set(runs.map((r) => r.mode))], errSample: runs.find((r) => r.err)?.err,
      cpuMsPerSearch: cpu, idleRatePerSec: Object.fromEntries(Object.entries(idleRate).filter(([k]) => k !== "t").map(([k, v]) => [k, v * 1000])),
      pg: { statementsPerSearch: st.calls / runs.length, execMsPerSearch: st.exec_ms / runs.length, top },
      latency: { p50: pct(0.5), p95: pct(0.95), mean: walls.reduce((a, b) => a + b, 0) / walls.length }, runs };
    console.log(`${arm.name.padEnd(14)} ${mode.padEnd(8)} ${project} rep${rep} n=${res.n} err=${res.errors} qps=${res.qps.toFixed(1)} cpu/search ms: ` +
      Object.entries(cpu).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ") + ` | pg stmts=${res.pg.statementsPerSearch.toFixed(1)} exec=${res.pg.execMsPerSearch.toFixed(2)}ms | p50=${res.latency.p50.toFixed(0)}ms`);
    console.log("  threads ms/search:", Object.entries(threads).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" "));
    if (res.errors) console.log("  err:", res.errSample, srv.log().slice(-1500));
    return res;
  } finally {
    if (cfg.keepLog) writeFileSync(`${cfg.out}/runs/${cfg.label}-${arm.name}-${mode}-${project}-r${rep}.log`, srv.log());
    srv.child.kill("SIGTERM");
    await new Promise((r) => { if (srv.child.exitCode !== null) r(); else srv.child.on("exit", r); setTimeout(r, 8000); });
  }
}

mkdirSync(`${cfg.out}/runs`, { recursive: true });
const all = [];
for (let rep = 0; rep < cfg.reps; rep++) {
  for (const project of cfg.projects) {
    const qs = JSON.parse(readFileSync(`${cfg.out}/corpus/${project}/queries-${cfg.split ?? "dev"}.json`, "utf8"));
    const warm = qs.slice(-cfg.warm);
    const measured = qs.slice(0, cfg.n);
    for (const mode of cfg.modes) for (const arm of (rep % 2 ? [...cfg.arms].reverse() : cfg.arms)) {
      const r = await session(arm, mode, project, measured, warm, rep);
      all.push(r);
      writeFileSync(`${cfg.out}/runs/${cfg.label}-${arm.name}-${mode}-${project}-r${rep}.json`, JSON.stringify(r));
    }
  }
}
await sql.end();
process.exit(0);
