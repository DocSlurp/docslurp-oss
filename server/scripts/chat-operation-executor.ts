import "../src/env.js";
import { loadPricingProvider, pricingDurableStateFromSql } from "@docslurp/shared/pricing-loader";

import { sql } from "../src/db.js";
import { NATIVE_CHAT_TEARDOWN_MS, nativeChatDrainMs, runNativeChatWorker } from "../src/agent-runtime/runtime.js";
const shutdown = new AbortController();
const force = new AbortController();
const drainMs = nativeChatDrainMs();
let deadline: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
  // First signal: drain. Claim nothing new; running turns finish up to the turn
  // deadline. A second signal stops the drain and interrupts them at once.
  if (shutdown.signal.aborted) { force.abort(); return; }
  shutdown.abort();
  // One process-wide bound, including startup, global pools and native teardown.
  // Unsettled work retains output and converges through zero-retry lease recovery.
  deadline ??= setTimeout(() => process.exit(0), drainMs + NATIVE_CHAT_TEARDOWN_MS).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Chat answers are priced and charged here: load the deployment's pricing provider (with its durable state) before
// claiming any operation. DOCSLURP_PRICING_REQUIRED=1 (fly.chat-executor.toml) without a provider refuses to start, so
// the executor never prices an answer with the open default (or at 0).
try {
  await loadPricingProvider(process.env, { durableState: pricingDurableStateFromSql(sql), sql });
} catch (error) {
  console.error("[native-chat] startup_refused pricing:", error instanceof Error ? error.message : String(error));
  await sql.end({ timeout: 1 }).catch(() => undefined);
  process.exit(1);
}
try {
  await runNativeChatWorker(shutdown.signal, { force: force.signal, drainMs });
  await sql.end({ timeout: 1 });
  if (deadline) clearTimeout(deadline);
  process.exit(0);
} catch (error) {
  console.error("[native-chat] worker_failed", error instanceof Error ? error.name : "Error");
  process.exit(1);
}
