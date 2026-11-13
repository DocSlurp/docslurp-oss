// Parser-VM guest worker (a worker_thread of scripts/chart-export-extract.mjs): runs one input's deterministic chart
// extraction and streams each finished unit (an SVG, an embedded-spec scan, an Office chart part) to the parent as it
// completes, so a crash, out-of-memory or overrun in one unit loses only that unit. Reads customer bytes; runs only
// inside the parser VM in production, under the same V8 flags as the guest (--disallow-code-generation-from-strings is
// process-wide) and with zod jitless (the bundle's first import).
import { readFile } from "node:fs/promises";
import module from "node:module";
import { parentPort, workerData } from "node:worker_threads";

// Optional V8 compile cache, off unless the caller passes a directory (validated by the parent): enabled before the
// bundle loads, so each worker reuses the bundle's compiled code instead of compiling it again. It caches compilation
// of this fixed module file only; it does not touch --disallow-code-generation-from-strings or jitless.
if (typeof workerData?.compileCacheDir === "string") module.enableCompileCache(workerData.compileCacheDir);
// A fixed path, loaded after the cache is enabled. Messages sent before the listener below is attached are queued.
const { extractDeterministicVisuals, setGuestDeadline, testHooks } = await import("../dist/chart-export/guest.bundle.mjs");

// Fault injection for the containment tests only: `testHooks` is null in the production bundle (a build-time constant),
// so `task.fault` is ignored there whatever sends it. "<crash|hang|oom>:<locator substring>".
const injectFault = (fault, locator) => {
  const f = testHooks && fault ? /^(crash|hang|oom):(.+)$/.exec(fault) : null;
  if (!f || !locator.includes(f[2])) return;
  if (f[1] === "crash") process.exit(70); // like a native crash: the worker thread dies mid-unit
  if (f[1] === "hang") for (;;);
  const hog = [];
  for (;;) hog.push(new Array(1_000_000).fill(hog.length));
};

parentPort.on("message", async (task) => {
  setGuestDeadline(task.deadline);
  const bytes = await readFile(task.path);
  const input = task.packaged ? { kind: task.kind, bytes } : { kind: task.kind, text: bytes.toString("utf8") };
  const units = {
    skip: new Map(task.skip),
    onStart: (id, locator, svgIndex, svg) => { parentPort.postMessage({ t: "start", id, locator, svgIndex, svg }); injectFault(task.fault, locator); },
    onDone: (id, delta) => parentPort.postMessage({ t: "done", id, delta }),
  };
  parentPort.postMessage({ t: "result", result: extractDeterministicVisuals(input, { ...task.options, units, outputBudget: task.outputBudget }) });
});
