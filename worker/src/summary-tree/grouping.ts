import { normalizeHeadingPath } from "./hash.js";
import { resolveSummaryTreeLimits, SummaryTreeInputError, type SummaryTreeLimits } from "./limits.js";

/** The fields of a leaf that grouping reads. It never reads leaf text, so a caller need not hold it. */
export interface SummaryTreeLeafRef {
  chunkIndex: number;
  headingPath: readonly string[];
  pageStart: number | null;
  pageEnd: number | null;
}

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
  /** False: too few siblings for a parent of their own; the items are carried to the next layer as they are. */
  merge: boolean;
  /** False: the run becomes one node whatever its size (the last allowed level). */
  cut: boolean;
}

/** A leaf group being formed: leaves `[from, to)` by position, and the heading path its leaves share. */
interface LeafUnit {
  from: number;
  to: number;
  path: string[];
}

function commonPrefix(a: readonly string[], b: readonly string[]): string[] {
  const shared: string[] = [];
  for (let i = 0; i < a.length && i < b.length && a[i] === b[i]; i++) shared.push(a[i]!);
  return shared;
}

/**
 * Joins a small group to its neighbour: left to right, two adjacent groups become one when at least one of them
 * is under `min` and together they are at most `max`. The joined group carries the heading path both share.
 */
function mergeSmallNeighbours(items: LeafUnit[], min: number, max: number): LeafUnit[] {
  const merged: LeafUnit[] = [];
  for (const item of items) {
    const previous = merged[merged.length - 1];
    const size = item.to - item.from;
    const previousSize = previous ? previous.to - previous.from : 0;
    if (previous && previousSize + size <= max && (previousSize < min || size < min)) {
      previous.to = item.to;
      previous.path = commonPrefix(previous.path, item.path);
    } else {
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Leaf groups of one document, as `[from, to)` leaf positions in order.
 *
 * 1. A section is a run of adjacent leaves with the same heading path. A section over `max` is cut at its
 *    lowest adjacent-similarity boundaries (`cutBySimilarity`); every piece keeps at least `min` leaves.
 * 2. A group under `min` leaves then joins a neighbour, deepest headings first: inside each heading, in document
 *    order, two adjacent groups are joined when at least one is under `min` and together they fit `max`. What is
 *    still small after its own heading has been tried is offered to its neighbours inside the parent heading,
 *    and so on up to the document. So a short section joins its sibling sections under the same parent before
 *    it can join anything further away, and it crosses a parent heading only when nothing nearer fits.
 *
 * Rule 2 relaxes the plan's "short sections never merge across a heading" on measured evidence: with one group
 * per section however small, 340 of 1,067 leaf groups in the phase-0 corpus held a single chunk, each paying a
 * model call to restate one chunk (docs/evals/summary-tree/phase0-2026-11-14.md, finding 9). A group that
 * cannot join anything without passing `max` stays small.
 *
 * The rule is a pure function of the leaves' order, heading paths and adjacent similarities: no token count,
 * page number or id takes part, so an edit moves boundaries only inside the heading it touches (or, for a group
 * that changes between small and not small, its neighbours in the enclosing heading).
 */
export function groupSummaryTreeLeaves(
  leaves: readonly SummaryTreeLeafRef[],
  leafSimilarities: ArrayLike<number>,
  limits: Pick<SummaryTreeLimits, "minLeavesPerGroup" | "maxLeavesPerGroup">,
): LeafUnit[] {
  const { minLeavesPerGroup: min, maxLeavesPerGroup: max } = limits;
  const units: LeafUnit[] = [];
  for (let sectionStart = 0; sectionStart < leaves.length;) {
    const path = normalizeHeadingPath(leaves[sectionStart]!.headingPath);
    const key = JSON.stringify(path);
    let sectionEnd = sectionStart + 1;
    while (sectionEnd < leaves.length && JSON.stringify(normalizeHeadingPath(leaves[sectionEnd]!.headingPath)) === key) sectionEnd++;
    const count = sectionEnd - sectionStart;
    const offset = sectionStart;
    const starts = cutBySimilarity({ count, similarityAt: (gap) => leafSimilarities[offset + gap]!, min, max });
    for (let i = 0; i < starts.length; i++) {
      units.push({ from: offset + starts[i]!, to: offset + (starts[i + 1] ?? count), path });
    }
    sectionStart = sectionEnd;
  }
  // `pack(lo, hi, depth)`: units lo..hi share their first `depth` path segments. Each run of units that also
  // share segment `depth` is a sub-heading, packed first; then everything directly inside this heading is merged.
  const pack = (lo: number, hi: number, depth: number): LeafUnit[] => {
    const items: LeafUnit[] = [];
    for (let i = lo; i < hi;) {
      const segment = units[i]!.path[depth];
      if (segment === undefined) {
        items.push(units[i]!);
        i++;
        continue;
      }
      let end = i + 1;
      while (end < hi && units[end]!.path[depth] === segment) end++;
      for (const item of pack(i, end, depth + 1)) items.push(item);
      i = end;
    }
    return mergeSmallNeighbours(items, min, max);
  };
  return pack(0, units.length, 0);
}

/**
 * Whether the run `[start, end)` and every adjacent item inside the heading one level up number at most `max`.
 * Such a run is not given a parent yet: once paths are shortened it joins those neighbours under one parent.
 */
function fitsEnclosingRun(frontier: readonly FrontierItem[], start: number, end: number, max: number): boolean {
  const path = frontier[start]!.path;
  if (path.length === 0) return false;
  const depth = path.length - 1;
  const inside = (item: FrontierItem) => {
    if (item.path.length < depth) return false;
    for (let i = 0; i < depth; i++) if (item.path[i] !== path[i]) return false;
    return true;
  };
  let size = end - start;
  for (let left = start - 1; left >= 0 && size <= max && inside(frontier[left]!); left--) size++;
  for (let right = end; right < frontier.length && size <= max && inside(frontier[right]!); right++) size++;
  return size <= max;
}

/** Fewest further layers that bring `count` siblings down to one when every parent may have as few as `minFanIn` children. */
function layersNeeded(count: number, minFanIn: number): number {
  let layers = 0;
  for (let capacity = 1; capacity < count; capacity *= minFanIn) layers++;
  return layers;
}

/**
 * Builds one document's tree a level at a time.
 *
 * Leaf groups (level 1) exist as soon as the builder is constructed (`groupSummaryTreeLeaves`). Each
 * `advance()` then adds one layer of parents:
 *
 * - Neighbours grouped by the same heading path form a run. A run of at least `minFanIn` siblings gets a parent,
 *   unless it and its neighbours inside the heading one level up would fit one parent together: then it waits
 *   for them. A smaller run is carried up as it is, and joins its parent heading's siblings once paths are
 *   shortened. When no run gets a parent, the deepest paths lose their last segment and the runs are formed
 *   again, until one does or every path is empty (the whole frontier is then one run and gets the root,
 *   however few it holds). So a deeply nested outline does not grow a chain of near-identical summaries above
 *   its real sections (the phase-0 eval measured a nine-level tree whose top five levels held one node each),
 *   and no node ever has exactly one child.
 * - A run over the fan-in maximum is cut by the similarity of the siblings' summary vectors, which is why upper
 *   layers wait for the caller: `vectorsNeeded()` names the nodes whose summaries must be embedded first.
 * - Depth is bounded by `maxLevels`. A layer shaped by headings may shrink the frontier very little, so it is
 *   taken only if the layers left after it would still suffice with every later parent at `minFanIn` children.
 *   Otherwise headings are ignored for that layer and the whole frontier is cut by similarity; at the last
 *   allowed level whatever remains goes under one root.
 */
export class SummaryTreeBuilder {
  readonly nodes: SummaryTreeNode[] = [];
  readonly leafChunkIndexes: number[];
  private readonly limits: SummaryTreeLimits;
  private frontier: FrontierItem[] = [];
  private plan: PlannedRun[] | null = null;
  /** Highest level of any node so far. */
  private top = 1;

  constructor(leaves: readonly SummaryTreeLeafRef[], leafSimilarities: ArrayLike<number>, limitOverrides?: Partial<SummaryTreeLimits>) {
    this.limits = resolveSummaryTreeLimits(limitOverrides);
    if (leaves.length > 0 && leafSimilarities.length !== leaves.length - 1) {
      throw new SummaryTreeInputError(`expected ${leaves.length - 1} leaf similarities, got ${leafSimilarities.length}`);
    }
    this.leafChunkIndexes = leaves.map((leaf) => leaf.chunkIndex);
    for (let i = 1; i < leaves.length; i++) {
      if (leaves[i]!.chunkIndex <= leaves[i - 1]!.chunkIndex) throw new SummaryTreeInputError("summary tree leaves must be in increasing chunk order");
    }
    for (const unit of groupSummaryTreeLeaves(leaves, leafSimilarities, this.limits)) {
      let pageStart: number | null = null;
      let pageEnd: number | null = null;
      const children: number[] = [];
      for (let position = unit.from; position < unit.to; position++) {
        const leaf = leaves[position]!;
        children.push(leaf.chunkIndex);
        if (leaf.pageStart !== null) pageStart = pageStart === null ? leaf.pageStart : Math.min(pageStart, leaf.pageStart);
        if (leaf.pageEnd !== null) pageEnd = pageEnd === null ? leaf.pageEnd : Math.max(pageEnd, leaf.pageEnd);
      }
      this.nodes.push({
        level: 1, childKind: "leaf", children, parent: null,
        chunkStart: children[0]!, chunkEnd: children[children.length - 1]!,
        pageStart, pageEnd, headingPath: unit.path, leafCount: children.length,
      });
      this.frontier.push({ node: this.nodes.length - 1, path: unit.path, key: JSON.stringify(unit.path) });
    }
  }

  /** True once a single root remains (or the document had no leaves). */
  get done(): boolean {
    return this.frontier.length <= 1;
  }

  get root(): number | null {
    return this.done && this.frontier.length === 1 ? this.frontier[0]!.node : null;
  }

  /** Nodes without a parent yet, in document order. */
  get frontierNodes(): number[] {
    return this.frontier.map((item) => item.node);
  }

  private planStep(): PlannedRun[] {
    if (this.plan) return this.plan;
    const { minFanIn, maxFanIn, maxLevels } = this.limits;
    const count = this.frontier.length;
    const remaining = maxLevels - this.top;
    const whole = (cut: boolean): PlannedRun[] => {
      this.frontier = this.frontier.map((item) => (item.path.length === 0 ? item : { node: item.node, path: [], key: "[]" }));
      return (this.plan = [{ start: 0, end: count, merge: true, cut }]);
    };
    // The last allowed level: one root over whatever is left.
    if (remaining <= 1) return whole(false);
    let frontier = this.frontier;
    for (;;) {
      const runs: PlannedRun[] = [];
      let mergeable = false;
      // Most items the next frontier can hold: a cut run leaves at most one piece per `minFanIn` siblings.
      let nextAtMost = 0;
      for (let start = 0; start < count;) {
        let end = start + 1;
        while (end < count && frontier[end]!.key === frontier[start]!.key) end++;
        const size = end - start;
        // Enough siblings for a parent, unless the enclosing heading's siblings would all fit one parent too: then
        // the run waits for them (below), and the tree gets one node instead of a node inside a node.
        const merge = size === count || (size >= minFanIn && !fitsEnclosingRun(frontier, start, end, maxFanIn));
        if (merge) mergeable = true;
        nextAtMost += !merge ? size : size <= maxFanIn ? 1 : Math.floor(size / minFanIn);
        runs.push({ start, end, merge, cut: true });
        start = end;
      }
      if (mergeable) {
        // A layer shaped by headings may shrink the frontier very little. Take it only if the layers left after
        // it would still do with every later parent at the minimum; otherwise cut the whole frontier by similarity.
        if (layersNeeded(nextAtMost, minFanIn) > remaining - 1) return whole(true);
        this.frontier = frontier;
        return (this.plan = runs);
      }
      let deepest = 0;
      for (const item of frontier) deepest = Math.max(deepest, item.path.length);
      // With every path empty the frontier is one run, which always merges, so there is a segment left to drop.
      if (deepest === 0) throw new SummaryTreeInputError("summary tree frontier cannot be reduced");
      frontier = frontier.map((item) => {
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
      if (!run.merge || !run.cut || run.end - run.start <= this.limits.maxFanIn) continue;
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
      if (!run.merge || count === 1) {
        for (let position = run.start; position < run.end; position++) next.push(this.frontier[position]!);
        continue;
      }
      let starts = [0];
      if (run.cut && count > max) {
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
        this.top = Math.max(this.top, level + 1);
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
  leaves: readonly SummaryTreeLeafRef[];
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
