import { test } from "node:test";
import assert from "node:assert/strict";
import { extractChatResponse } from "./response.mjs";
import { actualCostUsd } from "./run.mjs";

test("reads PR #65 tool-call evidencePages, queries and the tool cost split", () => {
  const extracted = extractChatResponse({
    answer: "x [1]", citations: [],
    usage: { inputTokens: 10, outputTokens: 2, costCents: 1.5, costSource: "provider", toolCostCents: 0.25 },
    debug: { toolCalls: [{ id: "c1", name: "search", status: "ok", queries: ["a", "b"], resultCount: 3, zeroHit: false, evidencePages: [{ documentId: "d1", pageNumber: 4 }] }] },
  });
  const call = extracted.toolCalls[0];
  assert.deepEqual(call.queries, ["a", "b"]);
  assert.equal(call.zeroHit, false);
  assert.equal(call.evidence.length, 1);
  assert.equal(call.evidence[0].documentId, "d1");
  assert.deepEqual(call.evidence[0].pages, [4]);
  assert.equal(actualCostUsd(200, extracted, null).usd, 0.0175);
});
