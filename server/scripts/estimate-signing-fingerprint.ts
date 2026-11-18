// Operator check: prints this process environment's estimate signing key source and fingerprint (never the value),
// e.g. on a chat-executor machine, to compare with the API's GET /ops/estimate-signing. Exit 1 when no usable key.
import "../src/env.js";
import { estimateSigningKeyReport } from "../src/lib/estimate-signing-key.js";

try {
  console.log(JSON.stringify(estimateSigningKeyReport()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
