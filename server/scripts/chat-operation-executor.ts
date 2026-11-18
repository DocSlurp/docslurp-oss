import "../src/env.js";
import { loadPricingProvider, pricingDurableStateFromSql } from "@docslurp/shared/pricing-loader";
import { startAutomaticCallPriceRefresh } from "@docslurp/shared";

import { sql } from "../src/db.js";
import { assertEstimateSigningKeyConfigured } from "../src/lib/estimate-signing-key.js";
import { PROJECT_CHAT_FAILOVER_MODELS } from "../src/services/project-chat.js";
import { NATIVE_CHAT_TEARDOWN_MS, nativeChatDrainMs, runNativeChatWorker } from "../src/agent-runtime/runtime.js";
const shutdown = new AbortController();
const force = new AbortController();
const drainMs = nativeChatDrainMs();
let deadline: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
  // First signal: drain. Claim nothing new; running turns get the drain window
  // (25 s by default) to finish. A second signal interrupts them at once.
  if (shutdown.signal.aborted) { force.abort(); return; }
  shutdown.abort();
  // One process-wide bound, including startup, global pools and native teardown.
  // Unsettled work retains output and converges through zero-retry lease recovery.
  deadline ??= setTimeout(() => process.exit(0), drainMs + NATIVE_CHAT_TEARDOWN_MS).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Chat proposals plan project changes and sign their estimates here, and the API verifies them: both must share one key.
// Production without DOCSLURP_ESTIMATE_SIGNING_SECRET (or a fallback secret) refuses to start; never a per-process key.
try {
  console.log(`[native-chat] estimate signing key source=${assertEstimateSigningKeyConfigured(process.env)}`);
} catch (error) {
  console.error("[native-chat] startup_refused estimate signing:", error instanceof Error ? error.message : String(error));
  await sql.end({ timeout: 1 }).catch(() => undefined);
  process.exit(1);
}
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
// Chat failover is an automatic call: the margin gate needs current endpoint prices for its candidates.
startAutomaticCallPriceRefresh(PROJECT_CHAT_FAILOVER_MODELS);
try {
  await runNativeChatWorker(shutdown.signal, { force: force.signal, drainMs });
  await sql.end({ timeout: 1 });
  if (deadline) clearTimeout(deadline);
  process.exit(0);
} catch (error) {
  console.error("[native-chat] worker_failed", error instanceof Error ? error.name : "Error");
  process.exit(1);
}
