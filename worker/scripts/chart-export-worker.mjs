// Parser-VM guest worker (a worker_thread of scripts/chart-export-extract.mjs): runs one input's deterministic chart
// extraction and streams each finished unit (an SVG, an embedded-spec scan, an Office chart part) to the parent as it
// completes, so a crash, out-of-memory or overrun in one unit loses only that unit. Reads customer bytes; runs only
// inside the parser VM in production, under the same V8 flags as the guest (--disallow-code-generation-from-strings is
// process-wide) and with zod jitless (the bundle's first import).
import { readFile } from "node:fs/promises";
import { parentPort } from "node:worker_threads";

import { extractDeterministicVisuals, setGuestDeadline } from "../dist/chart-export/guest.bundle.mjs";

// Fault injection for the containment tests and the VM proof runs only: inert unless set, and the production guest runs
// with an empty environment. "<crash|hang|oom>:<locator substring>" fails the first unit whose locator contains it.
const FAULT = /^(crash|hang|oom):(.+)$/.exec(process.env.DOCSLURP_CHART_GUEST_TEST_FAULT ?? "");
const injectFault = (locator) => {
  if (!FAULT || !locator.includes(FAULT[2])) return;
  if (FAULT[1] === "crash") process.exit(70); // like a native crash: the worker thread dies mid-unit
  if (FAULT[1] === "hang") for (;;);
  const hog = [];
  for (;;) hog.push(new Array(1_000_000).fill(hog.length));
};

parentPort.on("message", async (task) => {
  setGuestDeadline(task.deadline);
  const bytes = await readFile(task.path);
  const input = task.packaged ? { kind: task.kind, bytes } : { kind: task.kind, text: bytes.toString("utf8") };
  const units = {
    skip: new Map(task.skip),
    onStart: (id, locator, svgIndex, svg) => { parentPort.postMessage({ t: "start", id, locator, svgIndex, svg }); injectFault(locator); },
    onDone: (id, delta) => parentPort.postMessage({ t: "done", id, delta }),
  };
  parentPort.postMessage({ t: "result", result: extractDeterministicVisuals(input, { ...task.options, units }) });
});
