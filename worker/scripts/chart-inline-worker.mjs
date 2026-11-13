// Parser VM only: the worker thread of inline chart extraction (chart-inline.mjs). Reads customer bytes; holds no
// credentials. Same bundle, input shape and options as the standalone guest (chart-export-extract.mjs), so its output is
// the standalone output for the same file.
//
// Protocol: start up (compile cache, bundle import: our own code), post "ready", then wait for ONE message carrying the
// file (transferred, not copied), extract, post the JSON. The parent may start this worker before it has decided to run
// it; bytes arrive only after the plan passed.
import module from "node:module";
import { parentPort, workerData } from "node:worker_threads";

// A V8 compile cache baked into the image next to the bundle (read-only in the VM). Node checks each entry against the
// source and its own version, so a stale or foreign cache is ignored, never trusted.
if (workerData?.compileCache) {
  try { module.enableCompileCache?.(workerData.compileCache); } catch { /* no cache: same result, slower start */ }
}
const { extractDeterministicVisuals } = await import("../dist/chart-export/guest.bundle.mjs");
parentPort.postMessage("ready");
parentPort.once("message", (job) => {
  const bytes = Buffer.from(job.buffer);
  const input = job.packaged ? { kind: job.kind, bytes } : { kind: job.kind, text: bytes.toString("utf8") };
  parentPort.postMessage(JSON.stringify(extractDeterministicVisuals(input, { diagrams: job.diagrams !== false, ...(job.pages ? { pages: job.pages } : {}) })));
});
