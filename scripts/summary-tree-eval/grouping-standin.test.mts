// Synthetic checks of the stand-in grouping and hashing. Run: tsx --test scripts/summary-tree-eval/grouping-standin.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";

import { coverageProblems, groupLeafLevel, groupLeaves, hashTree, leafHash, meanVector, similarityCuts, STANDIN_GROUP_OPTIONS, type HashSettings, type Leaf, type TreeNode } from "./grouping-standin.mts";

const settings: HashSettings = { treeKeyVersion: "t", promptVersion: "p", model: "m", textSettings: "s", lengthTarget: 100 };
const unit = (angle: number) => [Math.cos(angle), Math.sin(angle)];
const leaf = (index: number, headingPath: string[], text = `leaf ${index}`): Leaf => ({ index, hash: leafHash(text), headingPath, pageNumbers: [1] });
const proxy = (vectors: number[][]) => (nodes: TreeNode[]) => nodes.map((node) => meanVector(vectors.slice(node.leafStart, node.leafEnd + 1)));

test("a heading change is a hard cut and a short section is one group", () => {
  const leaves = [leaf(0, ["A"]), leaf(1, ["A"]), leaf(2, ["B"]), leaf(3, ["B", "C"])];
  const groups = groupLeafLevel(leaves, leaves.map(() => unit(0)), STANDIN_GROUP_OPTIONS);
  assert.deepEqual(groups.map((group) => group.children), [[0, 1], [2], [3]]);
});

test("an over-long section is cut at the lowest adjacent similarity, never below the minimum size", () => {
  // Twelve leaves; the weakest link is between 1 and 2 (too close to the edge) and the next weakest between 6 and 7.
  const angles = [0, 0.01, 1.5, 1.51, 1.52, 1.53, 1.54, 2.6, 2.61, 2.62, 2.63, 2.64];
  const cuts = similarityCuts(angles.map(unit), 0, 12, 8, 3);
  assert.deepEqual(cuts, [[0, 7], [7, 12]]);
});

test("every leaf and node has exactly one parent, down to one root, with or without headings", async () => {
  for (const paths of [Array.from({ length: 40 }, () => [] as string[]), Array.from({ length: 40 }, (_, i) => ["Doc", `S${Math.floor(i / 7)}`, ...(i % 7 > 3 ? ["sub"] : [])])]) {
    const leaves = paths.map((path, i) => leaf(i, path));
    const vectors = leaves.map((_, i) => unit(i * 0.37));
    const tree = await groupLeaves(leaves, vectors, STANDIN_GROUP_OPTIONS, proxy(vectors));
    assert.deepEqual(coverageProblems(tree), []);
    assert.equal(tree.levels.at(-1)!.length, 1);
  }
});

test("hashes ignore ids and pages, and change with text, heading, prompt or model", async () => {
  const build = async (texts: string[], heading: string, override: Partial<HashSettings> = {}) => {
    const leaves = texts.map((text, i) => ({ ...leaf(i + 100, [heading], text), pageNumbers: [i + 9] }));
    const vectors = leaves.map((_, i) => unit(i));
    return hashTree(await groupLeaves(leaves, vectors, STANDIN_GROUP_OPTIONS, proxy(vectors)), { ...settings, ...override }).flat();
  };
  const base = await build(["a", "b"], "H");
  assert.deepEqual(await build(["a", " b  "], "H"), base);
  assert.notDeepEqual(await build(["a", "c"], "H"), base);
  assert.notDeepEqual(await build(["a", "b"], "Other"), base);
  assert.notDeepEqual(await build(["a", "b"], "H", { promptVersion: "p2" }), base);
  assert.notDeepEqual(await build(["a", "b"], "H", { model: "m2" }), base);
});
