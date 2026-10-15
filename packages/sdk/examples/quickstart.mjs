import { createReadStream } from "node:fs";
import { createDocSlurpClient } from "@docslurp/sdk";

// Usage: node quickstart.mjs ./handbook.pdf "What is the leave policy?"
const [filename, q = "What are the key points in this document?"] = process.argv.slice(2);
if (!filename) throw new Error("Pass a document path: node quickstart.mjs ./handbook.pdf");
if (!process.env.DOCSLURP_API_KEY) throw new Error("Set DOCSLURP_API_KEY first.");

// Without DOCSLURP_WORKSPACE_ID, upload and search use your organization's default workspace.
const client = createDocSlurpClient();
const { workspace, run, warnings } = await client.upload(createReadStream(filename));
// Save these IDs before waiting: processing can outlive this process.
console.error(JSON.stringify({ workspaceId: workspace.id, workspaceSlug: workspace.slug, runId: run.id }));
for (const warning of warnings ?? []) console.error(warning);
await client.waitForRun(run.id, { timeoutMs: 600_000 });

const evidence = await client.search({ q, limit: 5 });
if (evidence.availability?.status !== "complete") {
  console.error("Check corpus availability:", evidence.availability);
}
// Keep the complete response: citations, availability, and search session ID.
console.log(JSON.stringify(evidence, null, 2));
