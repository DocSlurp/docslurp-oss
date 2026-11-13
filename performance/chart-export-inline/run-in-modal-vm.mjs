#!/usr/bin/env node
// Packs the built guest scripts (bundled, so no node_modules are needed) and the slice into a Modal `runtime: "vm"`
// sandbox shaped like the parser VM (2 vCPU, 4 GiB, network blocked, no secrets) and runs bench-vm.mjs there.
//   node performance/chart-export-inline/run-in-modal-vm.mjs <slice dir> <out.json> [runs=5]
// Needs MODAL_TOKEN_ID / MODAL_TOKEN_SECRET and a built worker (pnpm --filter @docslurp/worker build).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const [slice, outPath, runs = "5"] = process.argv.slice(2);
const req = createRequire(`${repo}worker/package.json`);
const { build } = req("esbuild");
const pack = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "inline-pack-"));
const w = (p) => path.join(pack, "worker", p);
mkdirSync(w("scripts"), { recursive: true });
mkdirSync(w("dist/chart-export"), { recursive: true });
const common = { bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning", absWorkingDir: `${repo}worker` };
await build({ ...common, entryPoints: [`${repo}worker/scripts/quarantine-inspect.mjs`], outfile: w("scripts/quarantine-inspect.mjs"), external: ["./chart-inline.mjs"] });
await build({ ...common, entryPoints: [`${repo}worker/scripts/chart-inline.mjs`], outfile: w("scripts/chart-inline.mjs") });
for (const f of ["chart-inline-worker.mjs", "chart-export-extract.mjs"]) copyFileSync(`${repo}worker/scripts/${f}`, w(`scripts/${f}`));
copyFileSync(`${repo}worker/dist/chart-export/guest.bundle.mjs`, w("dist/chart-export/guest.bundle.mjs"));
for (const f of ["bench-vm.mjs", "probe-vm.mjs"]) copyFileSync(`${repo}performance/chart-export-inline/${f}`, path.join(pack, f));
mkdirSync(path.join(pack, "slice"));
for (const f of readdirSync(slice)) copyFileSync(path.join(slice, f), path.join(pack, "slice", f));
const tar = path.join(pack, "..", `${path.basename(pack)}.tar`);
execFileSync("tar", ["-cf", tar, "-C", pack, "."]);

const { ModalClient } = req("modal");
const client = new ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
const app = await client.apps.fromName("docslurp-bench-chart-export", { createIfMissing: true });
const image = client.images.fromRegistry("node:24-trixie-slim");
const started = Date.now();
const vm = await client.sandboxes.create(app, image, {
  runtime: "vm", command: ["sleep", "infinity"], cpu: 2, cpuLimit: 2, memoryMiB: 4096, memoryLimitMiB: 4096,
  timeoutMs: 20 * 60_000, blockNetwork: true, env: {}, secrets: [],
});
try {
  await vm.filesystem.writeBytes(readFileSync(tar), "/bench.tar");
  const untar = await vm.exec(["sh", "-c", "mkdir -p /bench && tar -xf /bench.tar -C /bench"], { timeoutMs: 120_000 });
  if ((await untar.wait()) !== 0) throw new Error(await untar.stderr.readText());
  // PROBE=1: the fixed-cost probe (probe-vm.mjs) instead of the slice bench.
  const argv = process.env.PROBE === "1" ? ["node", "/bench/probe-vm.mjs", "/bench", runs] : ["node", "/bench/bench-vm.mjs", "/bench", "/bench/slice", runs];
  const proc = await vm.exec(argv, { mode: "text", timeoutMs: 18 * 60_000 });
  const [out, err, code] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
  if (code !== 0) { process.stderr.write(err); process.exitCode = 1; }
  writeFileSync(outPath, out);
} finally {
  await vm.terminate();
  console.log(`vm_seconds=${((Date.now() - started) / 1000).toFixed(1)}`);
}
