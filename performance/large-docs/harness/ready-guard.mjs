// Polls /ready every 30 s for one benchmark run (arg: label); after 2 consecutive failures cancels the run (POST /v1/runs/:id/control) and exits 3. Exits 0 when the run is terminal.
import { readFileSync, appendFileSync } from "node:fs";
const label = process.argv[2]; if (!label) { console.error("usage: ready-guard.mjs <label>"); process.exit(1); }
const dir = `${process.env.BENCH_ROOT ?? "/tmp/docslurp-large-docs"}/runs/${label}`, base = process.env.BENCH_BASE_URL ?? "https://docslurp.io";
const st = () => JSON.parse(readFileSync(`${dir}/state.json`, "utf8"));
const ck = Object.entries(JSON.parse(readFileSync(`${dir}/.cookies.json`, "utf8"))).map(([k, v]) => `${k}=${v}`).join("; ");
const log = (o) => appendFileSync(`${dir}/health.jsonl`, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
let fails = 0;
while (true) {
  const ok = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(15000) }).then(async r => (r.ok && (await r.json()).ok === true) ? true : false).catch(() => false);
  fails = ok ? 0 : fails + 1; log({ ready: ok, consecutiveFailures: fails });
  if (fails >= 2) {
    const r = await fetch(`${base}/v1/runs/${st().runId}/control`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: ck, Origin: base }, body: JSON.stringify({ action: "cancel" }), signal: AbortSignal.timeout(30000) }).catch(e => ({ status: 0, statusText: String(e) }));
    log({ action: "cancel-after-2-failed-ready", http: r.status }); console.log("READY FAILED TWICE; cancel http", r.status); process.exit(3);
  }
  if (["completed", "cancelled", "failed", "aborted"].includes(st().finalState)) { log({ done: st().finalState }); process.exit(0); }
  await new Promise(r => setTimeout(r, 30000));
}
