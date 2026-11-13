#!/usr/bin/env node
// Inside the VM: where inline chart extraction's fixed cost goes. node probe-vm.mjs <pack dir> [n=10]. Prints JSON.
import { spawnSync } from "node:child_process";
import { mkdirSync, chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
const [pack, nArg] = process.argv.slice(2);
const n = Number(nArg ?? 10);
const bundle = path.join(pack, "worker/dist/chart-export/guest.bundle.mjs");
const node = process.execPath;
const ms = (args, env = {}) => { const t = process.hrtime.bigint(); const r = spawnSync(node, args, { env: { ...process.env, ...env }, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return Number(process.hrtime.bigint() - t) / 1e6; };
const med = (f) => { const a = Array.from({ length: n }, f).sort((x, y) => x - y); return +a[Math.floor(n / 2)].toFixed(1); };
const importOnly = `await import(${JSON.stringify(bundle)})`;
const tmp = "/tmp/probe"; mkdirSync(tmp, { recursive: true });
writeFileSync(`${tmp}/w-import.mjs`, `import { parentPort } from "node:worker_threads"; await import(${JSON.stringify(bundle)}); parentPort.postMessage(1);`);
writeFileSync(`${tmp}/w-empty.mjs`, `import { parentPort } from "node:worker_threads"; parentPort.postMessage(1);`);
const spawnWorker = (file) => `import { Worker } from "node:worker_threads"; await new Promise((r) => { const w = new Worker(${JSON.stringify(file)}); w.once("message", () => { w.terminate(); r(); }); });`;
writeFileSync(`${tmp}/m-import.mjs`, importOnly);
writeFileSync(`${tmp}/m-worker-import.mjs`, spawnWorker(`${tmp}/w-import.mjs`));
writeFileSync(`${tmp}/m-worker-empty.mjs`, spawnWorker(`${tmp}/w-empty.mjs`));
writeFileSync(`${tmp}/m-empty.mjs`, "");
const cc = "/tmp/cc"; mkdirSync(cc, { recursive: true });
const f = (name) => [`${tmp}/${name}.mjs`];
ms(f("m-import"), { NODE_COMPILE_CACHE: cc });
ms(f("m-worker-import"), { NODE_COMPILE_CACHE: cc });
chmodSync(cc, 0o555);
const FLAG = ["--disallow-code-generation-from-strings"];
const out = {
  nodeBoot: med(() => ms(f("m-empty"))),
  importBundle: med(() => ms(f("m-import"))),
  importBundleCompileCacheRO: med(() => ms(f("m-import"), { NODE_COMPILE_CACHE: cc })),
  emptyWorker: med(() => ms(f("m-worker-empty"))),
  workerImportBundle: med(() => ms(f("m-worker-import"))),
  workerImportBundleCompileCacheRO: med(() => ms(f("m-worker-import"), { NODE_COMPILE_CACHE: cc })),
  importBundleFlag: med(() => ms([...FLAG, ...f("m-import")])),
  importBundleFlagCompileCacheRO: med(() => ms([...FLAG, ...f("m-import")], { NODE_COMPILE_CACHE: cc })),
  workerImportBundleFlag: med(() => ms([...FLAG, ...f("m-worker-import")])),
  workerImportBundleFlagCompileCacheRO: med(() => ms([...FLAG, ...f("m-worker-import")], { NODE_COMPILE_CACHE: cc })),
};
console.log(JSON.stringify(out));
