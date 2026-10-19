import test from "node:test";
import assert from "node:assert/strict";
import { fuseEqualRankLists } from "./fuse-diagnostic.mjs";
const a = { citation: { documentId: "a", chunkIndex: 1 } };
const b = { citation: { documentId: "b", chunkIndex: 1 } };
const c = { citation: { documentId: "a", chunkIndex: 2 } };
test("equal rank fusion preserves document identity and rewards agreement", () => {
 assert.deepEqual(fuseEqualRankLists([[a, c], [b, c]]), [c, a, b]);
 assert.throws(() => fuseEqualRankLists([[a, a]]), /Duplicate/);
 assert.throws(() => fuseEqualRankLists([[{ citation: {} }]]), /identity/);
});
