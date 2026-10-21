import { test } from "node:test";
import assert from "node:assert/strict";
import { pairNeighbourPages, normalizePage } from "./dataset.mjs";

const text = (topic) => `${topic} requirements credit hours advising department policy `.repeat(30);
const page = (doc, n, body) => normalizePage({ sourceDoc: doc, page: n, markdown: body }, { tier: "large-58k", workspaceId: "w" });

test("pairs a sampled page with its most similar same-document neighbour", () => {
  const sample = [page("a", 10, text("nursing"))];
  const neighbours = new Map([["a#11", page("a", 11, text("nursing"))], ["a#12", page("a", 12, "unrelated ".repeat(60))], ["b#11", page("b", 11, text("nursing"))]]);
  const pairs = pairNeighbourPages(sample, neighbours, { seed: "s" });
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].pages.map((p) => `${p.sourceDoc}#${p.page}`), ["a#10", "a#11"]);
});

test("skips pages with no similar neighbour", () => {
  const pairs = pairNeighbourPages([page("a", 1, text("x"))], new Map([["a#2", page("a", 2, "zzz qqq ".repeat(60))]]), { seed: "s" });
  assert.equal(pairs.length, 0);
});
