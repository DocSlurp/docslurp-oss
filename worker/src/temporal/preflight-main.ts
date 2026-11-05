/*
 * `node worker/dist/temporal/preflight-main.js`: run the worker's startup configuration checks and exit (preflight.ts).
 * Exit 0 when the worker would start, 1 when a check refuses, 2 when the checks did not finish within
 * DOCSLURP_WORKER_PREFLIGHT_TIMEOUT_MS (default 120000). Never connects to Temporal or the database.
 */
import { runWorkerPreflight, WorkerPreflightError } from "./preflight.js";

const timeoutMs = Number(process.env.DOCSLURP_WORKER_PREFLIGHT_TIMEOUT_MS ?? 120_000);
const timer = setTimeout(() => {
  console.error(`[worker-preflight] FAILED: checks did not finish within ${timeoutMs} ms`);
  process.exit(2);
}, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000);
timer.unref();

try {
  const results = await runWorkerPreflight(process.env);
  for (const result of results) console.log(`[worker-preflight] ${result.status} ${result.step}: ${result.detail}`);
  console.log("[worker-preflight] PASSED");
  // Exit explicitly: a loaded provider may hold handles open, and preflight must never linger.
  process.exit(0);
} catch (error) {
  const step = error instanceof WorkerPreflightError ? error.step : "unknown";
  console.error(`[worker-preflight] FAILED step=${step}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
