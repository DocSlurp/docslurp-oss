import { headingPathKey, normalizeHeadingPath } from "./hash.js";
import type { SummaryTreeLeaf } from "./leaves.js";
import { resolveSummaryTreeLimits, SummaryTreeInputError, type SummaryTreeLimits } from "./limits.js";

/**
 * One summary node. Nodes are stored children-first, so a node's index is larger than every index under it
 * and a build can walk the array in order.
 */
export interface SummaryTreeNode {
  /** 1 for a group of leaves; otherwise one more than its highest child. */
  level: number;
  childKind: "leaf" | "node";
  /** In document order: chunk indexes for `leaf` children, node indexes for `node` children. */
  children: number[];
  /** Index of the parent node, null for the root (and for nodes whose parent is not built yet). */
  parent: number | null;
  /** First and last chunk index under the node, inclusive. Overlap and table chunks between them are in range. */
  chunkStart: number;
  chunkEnd: number;
  pageStart: number | null;
  pageEnd: number | null;
  /** Normalized heading path the node's children share. */
  headingPath: string[];
  /** Number of leaves under the node. */
  leafCount: number;
}

export interface SummaryTree {
  nodes: SummaryTreeNode[];
  /** Index of the root, null for a document with no leaves. */
  root: number | null;
  /** Chunk indexes of every leaf, in document order. */
  leafChunkIndexes: number[];
}

export type VectorLike = ArrayLike<number>;

/** Cosine similarity; 0 when either vector has no length, so a blank vector never looks like a match. */
export function cosineSimilarity(a: VectorLike, b: VectorLike): number {
  if (a.length !== b.length) throw new SummaryTreeInputError(`cannot compare vectors of ${a.length} and ${b.length} dimensions`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  const similarity = denominator > 0 ? dot / denominator : 0;
  return Number.isFinite(similarity) ? similarity : 0;
}

/** `result[i]` is the similarity of item `i` and item `i + 1`. Vectors are read once and not retained. */
export function adjacentSimilarities(count: number, vectorAt: (position: number) => VectorLike): Float64Array {
  const similarities = new Float64Array(Math.max(0, count - 1));
  if (count < 2) return similarities;
  let previous = vectorAt(0);
  for (let position = 1; position < count; position++) {
    const current = vectorAt(position);
    similarities[position - 1] = cosineSimilarity(previous, current);
    previous = current;
  }
  return similarities;
}

/**
 * Cuts `count` ordered items into contiguous groups of at most `max`. The cut is the lowest similarity between
 * neighbours among the positions that leave both sides at least `min`, then each side is cut the same way
 * until it fits. Only relative minima decide: no similarity value is ever compared with a fixed threshold,
 * because embedded text shares a contextual preamble that lifts every similarity. Ties go to the earliest
 * position. Returns the start position of each group, in order.
 *
 * A sparse table answers each "lowest in range" query in constant time, so the work is O(n log n) whatever
 * the cut order: one heading-less section of tens of thousands of leaves does not degrade to a quadratic scan.
 */
export function cutBySimilarity(args: { count: number; similarityAt: (position: number) => number; min: number; max: number }): number[] {
  const { count, min, max } = args;
  if (count <= max) return count > 0 ? [0] : [];
  if (min < 1 || max < 2 * min - 1) throw new SummaryTreeInputError("similarity cut needs max >= 2 * min - 1 and min >= 1");
  const gaps = count - 1;
  const similarity = new Float64Array(gaps);
  for (let gap = 0; gap < gaps; gap++) {
    const value = args.similarityAt(gap);
    similarity[gap] = Number.isFinite(value) ? value : 0;
  }
  // table[k][i] = gap with the lowest similarity in [i, i + 2^k), earliest on a tie.
  const table: Int32Array[] = [Int32Array.from({ length: gaps }, (_, gap) => gap)];
  for (let width = 2; width <= gaps; width *= 2) {
    const below = table[table.length - 1]!;
    const row = new Int32Array(gaps - width + 1);
    for (let i = 0; i < row.length; i++) {
      const left = below[i]!;
      const right = below[i + width / 2]!;
      row[i] = similarity[right]! < similarity[left]! ? right : left;
    }
    table.push(row);
  }
  const lowestGap = (from: number, to: number) => {
    const k = 31 - Math.clz32(to - from + 1);
    const left = table[k]![from]!;
    const right = table[k]![to - (1 << k) + 1]!;
    return similarity[right]! < similarity[left]! ? right : left;
  };
  const starts: number[] = [];
  const pending: Array<[number, number]> = [[0, count]];
  while (pending.length > 0) {
    const [start, end] = pending.pop()!;
    if (end - start <= max) {
      starts.push(start);
      continue;
    }
    // Cutting after gap g leaves [start, g] and [g + 1, end): both sides keep `min` items.
    const cutAfter = lowestGap(start + min - 1, end - min - 1);
    pending.push([cutAfter + 1, end], [start, cutAfter + 1]);
  }
  return starts;
}

interface FrontierItem {
  node: number;
  /** The path this item is grouped by. Shortened one segment at a time; the node keeps its own path. */
  path: string[];
  key: string;
}

interface PlannedRun {
  start: number;
  end: number;
}

/**
 * Builds one document's tree a level at a time.
 *
 * Leaf groups (level 1) exist as soon as the builder is constructed: a hard cut wherever the heading path
 * changes, one group per section that fits, and similarity cuts inside a section that does not. Each
 * `advance()` then adds one layer of parents: neighbours with the same path merge first; when no two
 * neighbours share a path, the deepest paths lose their last segment and the merge is tried again. A run of
 * siblings over the fan-in maximum is cut by the similarity of the siblings' summary vectors, which is why
 * upper layers wait for the caller: `vectorsNeeded()` names the nodes whose summaries must be embedded first.
 * A lone sibling is carried up as it is rather than summarized again, so no node has exactly one child.
 */
export class SummaryTreeBuilder {
  readonly nodes: SummaryTreeNode[] = [];
  readonly leafChunkIndexes: number[];
  private readonly limits: SummaryTreeLimits;
  private frontier: FrontierItem[] = [];
  private plan: PlannedRun[] | null = null;

  constructor(leaves: readonly SummaryTreeLeaf[], leafSimilarities: ArrayLike<number>, limitOverrides?: Partial<SummaryTreeLimits>) {
    this.limits = resolveSummaryTreeLimits(limitOverrides);
    if (leaves.length > 0 && leafSimilarities.length !== leaves.length - 1) {
      throw new SummaryTreeInputError(`expected ${leaves.length - 1} leaf similarities, got ${leafSimilarities.length}`);
    }
    this.leafChunkIndexes = leaves.map((leaf) => leaf.chunkIndex);
    for (let i = 1; i < leaves.length; i++) {
      if (leaves[i]!.chunkIndex <= leaves[i - 1]!.chunkIndex) throw new SummaryTreeInputError("summary tree leaves must be in increasing chunk order");
    }
    const { minLeavesPerGroup: min, maxLeavesPerGroup: max } = this.limits;
    let sectionStart = 0;
    while (sectionStart < leaves.length) {
      const path = normalizeHeadingPath(leaves[sectionStart]!.headingPath);
      const key = JSON.stringify(path);
      let sectionEnd = sectionStart + 1;
      while (sectionEnd < leaves.length && headingPathKey(leaves[sectionEnd]!.headingPath) === key) sectionEnd++;
      const count = sectionEnd - sectionStart;
      const offset = sectionStart;
      const starts = cutBySimilarity({ count, similarityAt: (gap) => leafSimilarities[offset + gap]!, min, max });
      for (let i = 0; i < starts.length; i++) {
        const from = offset + starts[i]!;
        const to = offset + (starts[i + 1] ?? count);
        let pageStart: number | null = null;
        let pageEnd: number | null = null;
        const children: number[] = [];
        for (let position = from; position < to; position++) {
          const leaf = leaves[position]!;
          children.push(leaf.chunkIndex);
          if (leaf.pageStart !== null) pageStart = pageStart === null ? leaf.pageStart : Math.min(pageStart, leaf.pageStart);
          if (leaf.pageEnd !== null) pageEnd = pageEnd === null ? leaf.pageEnd : Math.max(pageEnd, leaf.pageEnd);
        }
        this.nodes.push({
          level: 1, childKind: "leaf", children, parent: null,
          chunkStart: children[0]!, chunkEnd: children[children.length - 1]!,
          pageStart, pageEnd, headingPath: path, leafCount: children.length,
        });
        this.frontier.push({ node: this.nodes.length - 1, path, key });
      }
      sectionStart = sectionEnd;
    }
  }

  /** True once a single root remains (or the document had no leaves). */
  get done(): boolean {
    return this.frontier.length <= 1;
  }

  get root(): number | null {
    return this.done && this.frontier.length === 1 ? this.frontier[0]!.node : null;
  }

  /** Runs of neighbours that share a path, shortening the deepest paths until at least one run can merge. */
  private planStep(): PlannedRun[] {
    if (this.plan) return this.plan;
    for (;;) {
      const runs: PlannedRun[] = [];
      let mergeable = false;
      for (let start = 0; start < this.frontier.length;) {
        let end = start + 1;
        while (end < this.frontier.length && this.frontier[end]!.key === this.frontier[start]!.key) end++;
        if (end - start > 1) mergeable = true;
        runs.push({ start, end });
        start = end;
      }
      if (mergeable) return (this.plan = runs);
      let deepest = 0;
      for (const item of this.frontier) deepest = Math.max(deepest, item.path.length);
      // Distinct neighbours cannot all have the empty path, so there is always a segment left to drop.
      if (deepest === 0) throw new SummaryTreeInputError("summary tree frontier cannot be reduced");
      this.frontier = this.frontier.map((item) => {
        if (item.path.length !== deepest) return item;
        const path = item.path.slice(0, -1);
        return { node: item.node, path, key: JSON.stringify(path) };
      });
    }
  }

  /**
   * Node indexes whose summary vectors the next `advance()` reads: the members of every run of siblings over
   * the fan-in maximum. Empty when the next layer follows from headings alone.
   */
  vectorsNeeded(): number[] {
    if (this.done) return [];
    const needed: number[] = [];
    for (const run of this.planStep()) {
      if (run.end - run.start <= this.limits.maxFanIn) continue;
      for (let position = run.start; position < run.end; position++) needed.push(this.frontier[position]!.node);
    }
    return needed;
  }

  /** Adds one layer of parents and returns the indexes of the nodes it created. */
  advance(vectorOf?: (nodeIndex: number) => VectorLike | undefined): number[] {
    if (this.done) return [];
    const runs = this.planStep();
    const { minFanIn: min, maxFanIn: max } = this.limits;
    const created: number[] = [];
    const next: FrontierItem[] = [];
    for (const run of runs) {
      const count = run.end - run.start;
      if (count === 1) {
        next.push(this.frontier[run.start]!);
        continue;
      }
      let starts = [0];
      if (count > max) {
        const vector = (position: number) => {
          const node = this.frontier[run.start + position]!.node;
          const found = vectorOf?.(node);
          if (!found || found.length === 0) throw new SummaryTreeInputError(`summary tree node ${node} needs a summary vector before the next level can be grouped`);
          return found;
        };
        const similarities = adjacentSimilarities(count, vector);
        starts = cutBySimilarity({ count, similarityAt: (gap) => similarities[gap]!, min, max });
      }
      const { path, key } = this.frontier[run.start]!;
      for (let i = 0; i < starts.length; i++) {
        const from = run.start + starts[i]!;
        const to = run.start + (starts[i + 1] ?? count);
        if (to - from === 1) {
          next.push(this.frontier[from]!);
          continue;
        }
        const parent = this.nodes.length;
        const children: number[] = [];
        let level = 0;
        let leafCount = 0;
        let pageStart: number | null = null;
        let pageEnd: number | null = null;
        for (let position = from; position < to; position++) {
          const childIndex = this.frontier[position]!.node;
          const child = this.nodes[childIndex]!;
          child.parent = parent;
          children.push(childIndex);
          level = Math.max(level, child.level);
          leafCount += child.leafCount;
          if (child.pageStart !== null) pageStart = pageStart === null ? child.pageStart : Math.min(pageStart, child.pageStart);
          if (child.pageEnd !== null) pageEnd = pageEnd === null ? child.pageEnd : Math.max(pageEnd, child.pageEnd);
        }
        this.nodes.push({
          level: level + 1, childKind: "node", children, parent: null,
          chunkStart: this.nodes[children[0]!]!.chunkStart, chunkEnd: this.nodes[children[children.length - 1]!]!.chunkEnd,
          pageStart, pageEnd, headingPath: path, leafCount,
        });
        created.push(parent);
        next.push({ node: parent, path, key });
      }
    }
    this.frontier = next;
    this.plan = null;
    return created;
  }

  /** The tree so far. Complete (one root, every other node with a parent) once `done` is true. */
  tree(): SummaryTree {
    return { nodes: this.nodes, root: this.root, leafChunkIndexes: this.leafChunkIndexes };
  }
}

/**
 * Drives a builder to its root. `onLevel` receives each new layer, lowest first, starting with the leaf
 * groups; a stage summarizes and embeds those nodes there. `vectorOf` is asked only for the nodes a
 * similarity cut needs, after `onLevel` has seen them.
 */
export async function buildSummaryTree(args: {
  leaves: readonly SummaryTreeLeaf[];
  leafSimilarities: ArrayLike<number>;
  limits?: Partial<SummaryTreeLimits>;
  onLevel?: (nodeIndexes: number[], builder: SummaryTreeBuilder) => void | Promise<void>;
  vectorOf?: (nodeIndex: number) => VectorLike | undefined;
}): Promise<SummaryTree> {
  const builder = new SummaryTreeBuilder(args.leaves, args.leafSimilarities, args.limits);
  let created = builder.nodes.map((_, index) => index);
  for (;;) {
    if (created.length > 0) await args.onLevel?.(created, builder);
    if (builder.done) return builder.tree();
    created = builder.advance(args.vectorOf);
  }
}
