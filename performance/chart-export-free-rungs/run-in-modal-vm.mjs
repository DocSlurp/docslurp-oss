#!/usr/bin/env node
// Runs marker-cap-bench.mjs inside a Modal `runtime: "vm"` sandbox shaped like the parser VM (2 vCPU, 4 GiB, network
// blocked, no secrets) and prints its JSON. Needs MODAL_TOKEN_ID / MODAL_TOKEN_SECRET and a built worker.
//
//   node performance/chart-export-free-rungs/run-in-modal-vm.mjs [mode ...]   (modes: see marker-cap-bench.mjs)
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const { ModalClient } = createRequire(`${repo}worker/package.json`)("modal");
const client = new ModalClient({ tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET });
const app = await client.apps.fromName("docslurp-bench-chart-export", { createIfMissing: true });
const image = client.images.fromRegistry("node:24-trixie-slim");
const vm = await client.sandboxes.create(app, image, {
  runtime: "vm", command: ["sleep", "infinity"], cpu: 2, cpuLimit: 2, memoryMiB: 4096, memoryLimitMiB: 4096,
  timeoutMs: 15 * 60_000, blockNetwork: true, env: {}, secrets: [],
});
try {
  await vm.filesystem.makeDirectory("/bench");
  await vm.filesystem.writeBytes(await readFile(`${repo}worker/dist/chart-export/guest.bundle.mjs`), "/bench/guest.bundle.mjs");
  await vm.filesystem.writeBytes(await readFile(`${repo}performance/chart-export-free-rungs/marker-cap-bench.mjs`), "/bench/marker-cap-bench.mjs");
  // One fresh guest-like process per mode, with the host's V8 flag and V8's default heap, as the production guest runs.
  for (const mode of process.argv.slice(2).length ? process.argv.slice(2) : ["cmtScript64k", "cmtScript640k", "epubCmt3", "htmlSvgOpen1m", "htmlScript1m", "html2m", "epubScript200", "emptyCmt", "emptyCmtEpub90", "rgbStyleEpub8", "xsplitEpub9", "deepEpub300", "hiddenEpub20", "mermaidEpub200", "textEpub400", "rectEpub400", "legit"]) {
    const proc = await vm.exec(["node", "--disallow-code-generation-from-strings", "/bench/marker-cap-bench.mjs", "/bench/guest.bundle.mjs", mode], { mode: "text", timeoutMs: 5 * 60_000 });
    const [out, err, code] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
    process.stdout.write(out);
    if (code !== 0) { process.stderr.write(`${mode}: exit ${code}\n${err.slice(-2000)}`); process.exitCode = 1; }
  }
} finally {
  await vm.terminate();
}
