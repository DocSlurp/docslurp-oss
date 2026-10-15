import { createDocSlurpClient } from "@docslurp/sdk";

// Usage: node watch-run.mjs RUN_ID
const runId = process.argv[2];
if (!runId) throw new Error("Pass the run ID printed by your upload.");
const client = createDocSlurpClient();
for await (const snapshot of client.streamProgress(runId, { timeoutMs: 600_000, idleTimeoutMs: 120_000 })) {
  console.log(JSON.stringify({
    status: snapshot.progress?.lifecycleStatus ?? snapshot.run.status,
    pages: snapshot.progress?.pageRollup,
    usage: snapshot.progress?.usageTotals,
    resources: snapshot.progress?.resourceTotals,
  }));
  if (snapshot.run.status === "failed" || ["cancelled", "dead-letter"].includes(snapshot.run.controlState ?? "")) {
    process.exitCode = 1;
  }
}
