#!/usr/bin/env node
// Runs repro inputs through the real parser-VM guest (worker/scripts/chart-export-extract.mjs, with its per-unit
// worker containment) exactly as production does: `node --disallow-code-generation-from-strings`, `budgetMs` 45 s, and
// killed at 60 s like the host. For each input it reports the exit code, wall time, peak RSS of the guest process (all
// its worker threads included), the result's size and every counted outcome in the result.
//
//   node guest-repro-run.mjs <worker root> <inputs dir>...     (each <inputs dir>/<name>/{input,meta.json})
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const [root, ...dirs] = process.argv.slice(2);
const guest = path.join(root, "scripts/chart-export-extract.mjs");
const peakOf = (pid) => { try { return Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0); } catch { return 0; } };

function run(dir) {
  const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
  const request = path.join(dir, "request.json"), output = path.join(dir, "out.json");
  writeFileSync(request, JSON.stringify({ kind: meta.kind, diagrams: true, budgetMs: 45_000 }));
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env };
    delete env.NODE_COMPILE_CACHE; // the guest refuses an inherited compile cache
    const child = spawn(process.execPath, ["--disallow-code-generation-from-strings", guest, path.join(dir, "input"), request, output], { stdio: ["ignore", "ignore", "pipe"], env });
    let peakKb = 0, err = "";
    child.stderr.on("data", (d) => { err = (err + d).slice(-400); });
    const poll = setInterval(() => { peakKb = Math.max(peakKb, peakOf(child.pid)); }, 25);
    const kill = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("exit", (code, signal) => {
      clearInterval(poll); clearTimeout(kill);
      const row = { name: path.basename(dir), inputMb: +(statSync(path.join(dir, "input")).size / 1e6).toFixed(2), exit: code ?? signal, ms: Date.now() - t0, peakRssMb: Math.round(peakKb / 1024) };
      if (code === 0 && existsSync(output)) {
        const r = JSON.parse(readFileSync(output, "utf8"));
        const reasons = (list) => { const o = {}; for (const x of list ?? []) o[x.reason] = (o[x.reason] ?? 0) + (x.count ?? 1); return o; };
        Object.assign(row, { resultBytes: statSync(output).size, visuals: r.visuals.length, truncated: r.visuals.filter((v) => v.reason === "truncated").length, refusals: reasons(r.refusals), deferred: reasons(r.deferred), overflow: r.overflow ?? 0 });
      } else row.stderr = err.trim().split("\n").slice(-2).join(" | ");
      resolve(row);
    });
  });
}

for (const base of dirs) for (const name of readdirSync(base).sort()) console.log(JSON.stringify(await run(path.join(base, name))));
