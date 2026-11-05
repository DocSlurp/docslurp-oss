// Runs the Web Worker entry on a node:worker_threads thread for the tests.
import { parentPort } from "node:worker_threads";

import { attachEstimateWorker } from "../js/worker.mjs";

attachEstimateWorker({
  postMessage: (message) => parentPort.postMessage(message),
  addEventListener: (type, listener) => parentPort.on(type, (data) => listener({ data })),
});
