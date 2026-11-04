import "../src/env.js";
import { sql } from "../src/db.js";
import { runNativeChatWorker } from "../src/agent-runtime/runtime.js";
const shutdown = new AbortController();
let deadline: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
  shutdown.abort();
  // One process-wide bound, including startup, global pools and native teardown.
  // Unsettled work retains output and converges through zero-retry lease recovery.
  deadline ??= setTimeout(() => process.exit(0), 5000).unref();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await runNativeChatWorker(shutdown.signal);
  await sql.end({ timeout: 1 });
  if (deadline) clearTimeout(deadline);
  process.exit(0);
} catch (error) {
  console.error("[native-chat] worker_failed", error instanceof Error ? error.name : "Error");
  process.exit(1);
}
