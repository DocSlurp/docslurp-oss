import test from "node:test";
import assert from "node:assert/strict";
import { reconstructRelevanceOrder } from "./reconstruct-order.mjs";
test("invert complete odd and even presentation permutations", () => {
 assert.deepEqual(reconstructRelevanceOrder([1, 3, 5, 4, 2]), [1, 2, 3, 4, 5]);
 assert.deepEqual(reconstructRelevanceOrder([1, 3, 5, 6, 4, 2]), [1, 2, 3, 4, 5, 6]);
 assert.deepEqual(reconstructRelevanceOrder([]), []);
 assert.deepEqual(reconstructRelevanceOrder([1]), [1]);
});
