// Imported by the chat executor right after ../src/env.js, before anything that loads ../src/config.js: chat proposals
// plan project changes and sign their estimates here, and the API verifies them, so both must share one key. A missing
// (production), too-short or weak key refuses to start with a clear line, before any database connection or claim.
import { estimateSigningKeyLogLine } from "../src/lib/estimate-signing-key.js";

try {
  console.log(estimateSigningKeyLogLine("native-chat"));
} catch (error) {
  console.error("[native-chat] startup_refused estimate signing:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
