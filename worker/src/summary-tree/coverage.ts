/** The node fields the coverage check reads; `SummaryTreeNode` satisfies it. */
export interface CoverageNode {
  childKind: "leaf" | "node";
  children: readonly number[];
  parent?: number | null;
}

export type SummaryTreeCoverageViolation =
  | { kind: "leaf-without-group"; chunkIndex: number }
  | { kind: "leaf-in-multiple-groups"; chunkIndex: number; nodes: number[] }
  | { kind: "unknown-leaf"; chunkIndex: number; node: number }
  | { kind: "node-without-parent"; node: number }
  | { kind: "node-with-multiple-parents"; node: number; parents: number[] }
  | { kind: "unknown-child"; node: number; child: number }
  | { kind: "child-not-before-parent"; node: number; child: number }
  | { kind: "parent-pointer-mismatch"; node: number; recorded: number | null; actual: number | null }
  | { kind: "empty-node"; node: number }
  | { kind: "missing-root" }
  | { kind: "root-mismatch"; recorded: number };

/**
 * The coverage invariant of a finished tree: every leaf is under exactly one group, every node except the
 * root is under exactly one parent, and there is one root. Returns every violation found; an empty array
 * means the tree may be served. Children-before-parents ordering rules out cycles.
 */
export function checkSummaryTreeCoverage(tree: {
  nodes: readonly CoverageNode[];
  root: number | null;
  leafChunkIndexes: readonly number[];
}): SummaryTreeCoverageViolation[] {
  const violations: SummaryTreeCoverageViolation[] = [];
  const leafGroups = new Map<number, number[]>();
  for (const chunkIndex of tree.leafChunkIndexes) leafGroups.set(chunkIndex, []);
  const parents: number[][] = tree.nodes.map(() => []);

  tree.nodes.forEach((node, index) => {
    if (node.children.length === 0) violations.push({ kind: "empty-node", node: index });
    for (const child of node.children) {
      if (node.childKind === "leaf") {
        const groups = leafGroups.get(child);
        if (groups) groups.push(index);
        else violations.push({ kind: "unknown-leaf", chunkIndex: child, node: index });
      } else if (!Number.isInteger(child) || child < 0 || child >= tree.nodes.length) {
        violations.push({ kind: "unknown-child", node: index, child });
      } else {
        if (child >= index) violations.push({ kind: "child-not-before-parent", node: index, child });
        parents[child]!.push(index);
      }
    }
  });

  for (const [chunkIndex, groups] of leafGroups) {
    if (groups.length === 0) violations.push({ kind: "leaf-without-group", chunkIndex });
    else if (groups.length > 1) violations.push({ kind: "leaf-in-multiple-groups", chunkIndex, nodes: groups });
  }

  const parentless: number[] = [];
  parents.forEach((found, index) => {
    if (found.length > 1) violations.push({ kind: "node-with-multiple-parents", node: index, parents: found });
    if (found.length === 0) parentless.push(index);
    const recorded = tree.nodes[index]!.parent;
    const actual = found.length === 1 ? found[0]! : null;
    if (recorded !== undefined && found.length <= 1 && recorded !== actual) {
      violations.push({ kind: "parent-pointer-mismatch", node: index, recorded, actual });
    }
  });

  const rootValid = tree.root !== null && Number.isInteger(tree.root) && tree.root >= 0 && tree.root < tree.nodes.length
    && parents[tree.root]!.length === 0;
  if (tree.root !== null && !rootValid) violations.push({ kind: "root-mismatch", recorded: tree.root });
  if (tree.root === null && tree.nodes.length > 0) violations.push({ kind: "missing-root" });
  // The root is the one node allowed to have no parent; any other parentless node is an orphan.
  for (const index of parentless) {
    if (index !== tree.root) violations.push({ kind: "node-without-parent", node: index });
  }
  return violations;
}
