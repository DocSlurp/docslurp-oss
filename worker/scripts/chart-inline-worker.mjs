// Parser VM only: the worker thread of inline chart extraction (chart-inline.mjs). Reads customer bytes; holds no
// credentials. Same bundle, same input shape and same options as the standalone guest (chart-export-extract.mjs), so its
// output is the standalone output for the same file.
import { parentPort, workerData } from "node:worker_threads";
import { extractDeterministicVisuals } from "../dist/chart-export/guest.bundle.mjs";

const { kind, packaged, diagrams } = workerData;
// Trusted start-up is done: the host-side deadline covers only the work on customer bytes from here.
parentPort.postMessage("ready");
const bytes = Buffer.from(workerData.bytes.buffer, workerData.bytes.byteOffset, workerData.bytes.byteLength);
const input = packaged ? { kind, bytes } : { kind, text: bytes.toString("utf8") };
parentPort.postMessage(JSON.stringify(extractDeterministicVisuals(input, { diagrams: diagrams !== false })));
