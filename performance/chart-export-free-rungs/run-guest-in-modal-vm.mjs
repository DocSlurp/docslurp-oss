#!/usr/bin/env node
// The containment proof on a Modal `runtime: "vm"` sandbox shaped like the parser VM (2 vCPU, 4 GiB, network blocked,
// no secrets): uploads the built guest (bundle, chart-export-extract.mjs, chart-export-worker.mjs) and these benches,
// measures worker startup, generates the earlier rounds' repro inputs in the VM (marker-cap-bench.mjs --write), adds
// any extra input directories given (each <dir>/<name>/{input,meta.json}), runs every input through the real guest
// (guest-repro-run.mjs), then repeats ordinary inputs with an injected crash, hang and out-of-memory in one unit. The
// production bundle compiles the fault hooks out, so the fault runs use a second copy of the guest beside a bundle built
// with them in (as guest-bundle.test.ts does).
// Needs MODAL_TOKEN_ID / MODAL_TOKEN_SECRET and a built worker.
//
//   node performance/chart-export-free-rungs/run-guest-in-modal-vm.mjs [--startup-only] [extra inputs dir]...
// --startup-only measures worker and whole-guest startup with and without the optional compile cache, and stops.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const startupOnly = process.argv.includes("--startup-only");
const inputDirs = process.argv.slice(2).filter((a) => a !== "--startup-only");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const { ModalClient } = createRequire(`${repo}worker/package.json`)("modal");
const client = new ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
const app = await client.apps.fromName("docslurp-bench-chart-export", { createIfMissing: true });
const vm = await client.sandboxes.create(app, client.images.fromRegistry("node:24-trixie-slim"), {
  runtime: "vm", command: ["sleep", "infinity"], cpu: 2, cpuLimit: 2, memoryMiB: 4096, memoryLimitMiB: 4096,
  timeoutMs: 40 * 60_000, blockNetwork: true, env: {}, secrets: [],
});
const exec = async (args, env = {}) => {
  const proc = await vm.exec(args, { mode: "text", timeoutMs: 30 * 60_000, env });
  const [out, err, code] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
  if (code !== 0) process.stderr.write(`${args.join(" ")}: exit ${code}\n${err.slice(-1500)}\n`);
  return out;
};
const put = async (from, to) => { await vm.filesystem.makeDirectory(path.dirname(to), { createParents: true }); await vm.filesystem.writeBytes(readFileSync(from), to); };
const hookDir = mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "chart-guest-hooked-"));
const { build } = createRequire(`${repo}worker/package.json`)("esbuild");
await build({
  entryPoints: [`${repo}worker/dist/chart-export/extractors/guest-entry.js`], outfile: path.join(hookDir, "guest.bundle.mjs"),
  bundle: true, platform: "node", format: "esm", logLevel: "silent", absWorkingDir: `${repo}worker`, define: { __CHART_GUEST_TEST_HOOKS__: "true" },
});
try {
  await put(path.join(hookDir, "guest.bundle.mjs"), "/bench/hooked/dist/chart-export/guest.bundle.mjs");
  for (const f of ["chart-export-extract.mjs", "chart-export-worker.mjs"]) await put(`${repo}worker/scripts/${f}`, `/bench/hooked/scripts/${f}`);
  await put(`${repo}worker/dist/chart-export/guest.bundle.mjs`, "/bench/worker/dist/chart-export/guest.bundle.mjs");
  for (const f of ["chart-export-extract.mjs", "chart-export-worker.mjs"]) await put(`${repo}worker/scripts/${f}`, `/bench/worker/scripts/${f}`);
  await put(`${repo}worker/scripts/chart-guest-compile-cache.mjs`, "/bench/worker/scripts/chart-guest-compile-cache.mjs");
  for (const f of ["marker-cap-bench.mjs", "guest-repro-run.mjs", "worker-startup.mjs", "guest-startup.mjs"]) await put(`${here}${f}`, `/bench/${f}`);
  for (const dir of inputDirs) {
    for (const name of readdirSync(dir)) for (const f of ["input", "meta.json"]) await put(path.join(dir, name, f), `/in/${path.basename(dir)}/${name}/${f}`);
  }
  // Worker startup without and with the optional compile cache (cold, then warm), then the whole guest command.
  process.stdout.write(await exec(["node", "--disallow-code-generation-from-strings", "/bench/worker-startup.mjs", "/bench/worker", "15"]));
  for (let k = 0; k < 2; k++) process.stdout.write(await exec(["node", "--disallow-code-generation-from-strings", "/bench/worker-startup.mjs", "/bench/worker", "15", "/tmp/chart-compile-cache"]));
  process.stdout.write(await exec(["node", "/bench/guest-startup.mjs", "/bench/worker", "15"]));
  if (!startupOnly) {
    const modes = ["doc100", "held17", "hiddenEpub20", "nested200", "mermaidEpub200", "rgbStyleEpub8", "xsplitEpub9", "deepEpub300",
      "cmtScript640k", "epubCmt3", "htmlSvgOpen1m", "html2m", "epubScript200", "emptyCmtEpub90", "textEpub400", "rectEpub400", "legit"];
    for (const mode of modes) await exec(["node", "/bench/marker-cap-bench.mjs", "/bench/worker/dist/chart-export/guest.bundle.mjs", mode, "--write", "/in/gen"]);
    const extra = inputDirs.map((d) => `/in/${path.basename(d)}`);
    process.stdout.write(await exec(["node", "/bench/guest-repro-run.mjs", "/bench/worker", "/in/gen", ...extra]));
    // Injected faults in one unit of the ordinary 100-chart page: the other 99 must survive, the unit counted.
    await exec(["mkdir", "-p", "/in/fault"]);
    await exec(["cp", "-r", "/in/gen/legit", "/in/fault/legit"]);
    for (const [fault, extraEnv] of [["crash:svg[50]", {}], ["hang:svg[50]", { DOCSLURP_CHART_GUEST_TEST_UNIT_MS: "2000" }], ["oom:svg[50]", {}]]) {
      const out = await exec(["node", "/bench/guest-repro-run.mjs", "/bench/hooked", "/in/fault"], { DOCSLURP_CHART_GUEST_TEST_FAULT: fault, ...extraEnv });
      process.stdout.write(out.replace(/"name":"legit"/, `"name":"legit+${fault}"`));
    }
    // Council r10: a crash after a 64 KB part name (field caps on reassembly) and after the output budget fills (stable
    // unit ids on resume), when those inputs are among the extra directories.
    for (const [name, fault] of [["longLocEpub", "crash:z.xhtml#svg"], ["divergeEpub", "crash:c.xhtml#"]]) {
      for (const dir of extra) {
        if (!inputDirs.some((d) => existsSync(path.join(d, name)))) continue;
        await exec(["sh", "-c", `if test -d ${dir}/${name}; then mkdir -p /in/f-${name} && cp -r ${dir}/${name} /in/f-${name}/; fi`]);
      }
      if (!inputDirs.some((d) => existsSync(path.join(d, name)))) continue;
      const out = await exec(["node", "/bench/guest-repro-run.mjs", "/bench/hooked", `/in/f-${name}`], { DOCSLURP_CHART_GUEST_TEST_FAULT: fault });
      process.stdout.write(out.replace(`"name":"${name}"`, `"name":"${name}+${fault}"`));
    }
  }
} finally {
  await vm.terminate();
  rmSync(hookDir, { recursive: true, force: true });
}
