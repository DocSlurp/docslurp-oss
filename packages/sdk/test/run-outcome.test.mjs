import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient, DocSlurpRunError, runOutcome } from "../dist/index.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = (fetch, options = {}) => createDocSlurpClient({ apiUrl: "https://example.test/", apiKey: "key", fetch, ...options });

test("wait returns a completed run with failed documents as partial, and can treat it as an error", async () => {
  const partial = { id: "run", status: "completed", totalDocuments: 10, failedDocuments: 5, outcome: "partial" };
  const returned = await client(async () => json({ run: partial })).waitForRun("run", { pollIntervalMs: 1 });
  assert.equal(returned.status, "completed");
  assert.equal(runOutcome(returned), "partial");
  await assert.rejects(client(async () => json({ run: partial })).waitForRun("run", { failOnDocumentFailures: true }), (error) => {
    assert.ok(error instanceof DocSlurpRunError);
    assert.match(error.message, /5 of 10 documents in this run failed/);
    assert.deepEqual(error.run, partial);
    return true;
  });
  // An older server without `outcome`: derived from status and failedDocuments.
  assert.equal(runOutcome({ status: "completed", failedDocuments: 2 }), "partial");
  assert.equal(runOutcome({ status: "completed", failedDocuments: 0 }), "succeeded");
  assert.equal(runOutcome({ status: "failed" }), "failed");
  assert.equal(runOutcome({ status: "processing" }), null);
  const clean = { id: "run", status: "completed", totalDocuments: 2, failedDocuments: 0, outcome: "succeeded" };
  assert.equal((await client(async () => json({ run: clean })).waitForRun("run", { failOnDocumentFailures: true })).status, "completed");
});

