#!/usr/bin/env node
// Packs start-up variants of the inline chart guest (bundled, so no node_modules are needed) and the slice into a Modal
// `runtime: "vm"` sandbox shaped like the parser VM (2 vCPU, 4 GiB: the provider defaults; network blocked, no secrets)
// and runs bench-vm.mjs there.
//   node performance/chart-export-inline/run-in-modal-vm.mjs <slice dir> <out.json> [runs=5] [baseline pack dir]
// Variants: `before` = <baseline pack dir> (a variant dir of an earlier pack, run as it shipped then), and `now` = this
// tree as the host runs it (--disallow-code-generation-from-strings). Both get a compile cache built inside the VM at its
// own paths. Earlier runs: results-vm-steps.json (v0-v3 of round 1). Needs MODAL_TOKEN_ID / MODAL_TOKEN_SECRET and a built worker.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const [slice, outPath, runs = "5", baseline] = process.argv.slice(2);
const req = createRequire(`${repo}worker/package.json`);
const { build } = req("esbuild");
const pack = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "inline-pack-"));
const common = { bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning", absWorkingDir: `${repo}worker` };
async function variant(name, { prestart }) {
  const w = (p) => path.join(pack, name, "worker", p);
  mkdirSync(w("scripts"), { recursive: true });
  mkdirSync(w("dist/chart-export"), { recursive: true });
  await build({ ...common, entryPoints: [`${repo}worker/scripts/quarantine-inspect.mjs`], outfile: w("scripts/quarantine-inspect.mjs"), external: ["./chart-inline.mjs"] });
  await build({ ...common, entryPoints: [`${repo}worker/scripts/chart-inline.mjs`], outfile: w("scripts/chart-inline.mjs") });
  for (const f of ["chart-export-worker.mjs", "chart-guest-bundle.mjs"]) copyFileSync(`${repo}worker/scripts/${f}`, w(`scripts/${f}`));
  copyFileSync(`${repo}worker/dist/chart-export/guest.bundle.mjs`, w("dist/chart-export/guest.bundle.mjs"));
  // The SVG pre-start variant (v3) was measured at ~1 ms per SVG and removed from the guest; v1/v2 remain.
  void prestart;
}
// The earlier shipped guest (a variant dir of an earlier pack), and this tree as the host runs it now (V8 flag).
if (baseline) cpSync(baseline, path.join(pack, "before"), { recursive: true });
await variant("now", { prestart: false });
for (const f of ["bench-vm.mjs", "probe-vm.mjs"]) copyFileSync(`${repo}performance/chart-export-inline/${f}`, path.join(pack, f));
mkdirSync(path.join(pack, "slice"));
for (const f of readdirSync(slice)) copyFileSync(path.join(slice, f), path.join(pack, "slice", f));
const tar = `${pack}.tar`;
execFileSync("tar", ["-cf", tar, "--owner=0", "--group=0", "-C", pack, "."]);

const { ModalClient } = req("modal");
const client = new ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
const app = await client.apps.fromName("docslurp-bench-chart-export", { createIfMissing: true });
const image = client.images.fromRegistry("node:24-trixie-slim");
const started = Date.now();
const vm = await client.sandboxes.create(app, image, {
  runtime: "vm", command: ["sleep", "infinity"], cpu: 2, cpuLimit: 2, memoryMiB: 4096, memoryLimitMiB: 4096,
  timeoutMs: 30 * 60_000, blockNetwork: true, env: {}, secrets: [],
});
const sh = async (cmd, timeoutMs = 120_000) => {
  const p = await vm.exec(["sh", "-c", cmd], { mode: "text", timeoutMs });
  const [out, err, code] = await Promise.all([p.stdout.readText(), p.stderr.readText(), p.wait()]);
  if (code !== 0) throw new Error(`${cmd}: ${err}`);
  return out;
};
try {
  await vm.filesystem.writeBytes(readFileSync(tar), "/bench.tar");
  await sh("mkdir -p /bench && tar -xf /bench.tar -C /bench");
  // As production builds and uses it: the compile cache is built as root at "image build" (filled as the parser user,
  // uid 10001, then root-owned and read-only), and the bench runs as uid 10001, the parser VM's command user, so the
  // inline path finds it read-only. Arms: `nocache` (the same tree with no cache) and `now` (the read-only cache);
  // a `before` baseline pack, when given, runs as it shipped (its cache, if any, was built for another uid).
  await sh("chmod -R a+rX /bench && cp -a /bench/now /bench/nocache");
  await sh("cd /bench/now/worker && node -e \"import('./scripts/chart-guest-bundle.mjs').then((m) => m.buildCompileCache())\" && ls -la dist/chart-export/compile-cache dist/chart-export/compile-cache/*/ >&2");
  await sh("rm -rf /bench/nocache/worker/dist/chart-export/compile-cache");
  const flag = ":--disallow-code-generation-from-strings";
  const variants = [...(baseline ? ["before=/bench/before" + flag] : []), "nocache=/bench/nocache" + flag, "now=/bench/now" + flag].join(",");
  const asParser = "setpriv --reuid=10001 --regid=10001 --clear-groups";
  // PROBE=1: the fixed-cost probe (probe-vm.mjs) on this tree's bundle instead of the slice bench.
  writeFileSync(outPath, await sh(process.env.PROBE === "1" ? `${asParser} node /bench/probe-vm.mjs /bench/now ${runs}` : `${asParser} node /bench/bench-vm.mjs ${variants} /bench/slice ${runs}`, 28 * 60_000));
} finally {
  await vm.terminate();
  console.log(`vm_seconds=${((Date.now() - started) / 1000).toFixed(1)}`);
}
