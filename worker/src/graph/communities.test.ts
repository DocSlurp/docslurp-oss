import { describe, expect, it } from "vitest";

import { detectCommunities } from "./communities.js";

const node = (id: string) => ({ id, name: id, type: "concept", mentions: 1 });
const edge = (source: string, target: string, weight = 3) => ({ source, target, predicate: "relates_to", weight });

describe("detectCommunities", () => {
  it("splits one connected component into its dense clusters and rolls them up", () => {
    const nodes = ["a1", "a2", "a3", "b1", "b2", "b3", "solo"].map(node);
    const edges = [
      edge("a1", "a2"), edge("a2", "a3"), edge("a1", "a3"),
      edge("b1", "b2"), edge("b2", "b3"), edge("b1", "b3"),
      // A weak bridge keeps everything one component.
      edge("a3", "b1", 1),
    ];
    const communities = detectCommunities(nodes, edges);
    const level0 = communities.filter((community) => community.level === 0).map((community) => community.nodeIds);
    expect(level0).toEqual([["a1", "a2", "a3"], ["b1", "b2", "b3"]]);
    const [rollup] = communities.filter((community) => community.level === 1);
    expect(rollup?.nodeIds).toHaveLength(6);
    expect(rollup?.childHashes).toHaveLength(2);
  });

  it("gives identical membership the same hash so summaries can be reused", () => {
    const nodes = ["x", "y", "z"].map(node);
    const first = detectCommunities(nodes, [edge("x", "y"), edge("y", "z")]);
    const second = detectCommunities([...nodes].reverse(), [edge("y", "z"), edge("x", "y")]);
    expect(second.map((community) => community.memberHash)).toEqual(first.map((community) => community.memberHash));
  });
});
