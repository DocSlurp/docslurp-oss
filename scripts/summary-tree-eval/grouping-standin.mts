/**
 * STAND-IN grouping and hashing for the summary-tree phase-0 eval.
 *
 * The product grouping library was not available when this harness was
 * written. This file follows the grouping and hash rules of the plan literally
 * so the harness can run; it is evaluation tooling, not product code, and every
 * result produced with it is labelled "stand-in grouping". Replace it by
 * pointing `groupLeaves` / `nodeHash` at the product library: the harness uses
 * only the interface exported here.
 *
 *   groupLeaves(leaves, vectors, opts) -> Tree
 */
import { createHash } from "node:crypto";

export type Leaf = {
  /** Chunk index in the document's chunk stream. */
  index: number;
  hash: string;
  headingPath: string[];
  pageNumbers: number[];
};
export type TreeNode = {
  /** 1 = groups of leaves; higher levels group the level below. */
  level: number;
  headingPath: string[];
  /** Positions in the level below (leaf positions for level 1). */
  children: number[];
  /** Inclusive leaf-position range this node covers. */
  leafStart: number;
  leafEnd: number;
  /** Carried up from the level below without a new summary (a group of one). */
  promoted?: boolean;
};
export type Tree = { leaves: Leaf[]; levels: TreeNode[][] };
export type GroupOptions = { maxGroup: number; minGroup: number; fanIn: number; minFanIn: number };
export const STANDIN_GROUP_OPTIONS: GroupOptions = { maxGroup: 8, minGroup: 3, fanIn: 8, minFanIn: 2 };

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const normalizeText = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();
/** Leaf hash: normalized raw chunk text only (no preamble, ids or pages). */
export const leafHash = (rawText: string) => sha(normalizeText(rawText));
export type HashSettings = { treeKeyVersion: string; promptVersion: string; model: string; textSettings: string; lengthTarget: number };
/** Node hash: build settings, level, normalized heading path and ordered child hashes. */
export const nodeHash = (settings: HashSettings, level: number, headingPath: string[], childHashes: string[]) =>
  sha(JSON.stringify([settings.treeKeyVersion, settings.promptVersion, settings.model, settings.textSettings, settings.lengthTarget, level, headingPath.map(normalizeText), childHashes]));

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na * nb) || 1);
}

/**
 * Cut [start, end) into runs of at most `max`, each cut at the lowest adjacent
 * similarity that leaves both sides at least `min`. Relative minima only.
 */
export function similarityCuts(vectors: ArrayLike<number>[], start: number, end: number, max: number, min: number): Array<[number, number]> {
  const size = end - start;
  if (size <= max || size < 2 * min) return [[start, end]];
  let best = -1, bestSimilarity = Number.POSITIVE_INFINITY;
  for (let at = start + min; at <= end - min; at += 1) {
    const similarity = cosine(vectors[at - 1]!, vectors[at]!);
    if (similarity < bestSimilarity) { bestSimilarity = similarity; best = at; }
  }
  return [...similarityCuts(vectors, start, best, max, min), ...similarityCuts(vectors, best, end, max, min)];
}

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((part, i) => part === b[i]);
function runsBy<T>(items: T[], key: (item: T) => string[]): Array<{ start: number; end: number; path: string[] }> {
  const runs: Array<{ start: number; end: number; path: string[] }> = [];
  items.forEach((item, i) => {
    const path = key(item);
    const last = runs[runs.length - 1];
    if (last && samePath(last.path, path)) last.end = i + 1;
    else runs.push({ start: i, end: i + 1, path });
  });
  return runs;
}

/** Level 1: hard cut wherever the heading path changes; similarity cuts only inside an over-long section. */
export function groupLeafLevel(leaves: Leaf[], vectors: ArrayLike<number>[], opts: GroupOptions): TreeNode[] {
  return runsBy(leaves, (leaf) => leaf.headingPath).flatMap((run) =>
    similarityCuts(vectors, run.start, run.end, opts.maxGroup, opts.minGroup).map(([start, end]) => ({
      level: 1, headingPath: run.path, children: Array.from({ length: end - start }, (_, i) => start + i), leafStart: start, leafEnd: end - 1,
    })));
}

/**
 * One level up: nodes sharing a heading-path prefix one level shallower form a
 * section; once no headings remain, the whole sequence is one section. A
 * section over the fan-in is cut by similarity over the nodes' own vectors.
 */
export function groupUpperLevel(below: TreeNode[], vectors: ArrayLike<number>[], opts: GroupOptions): TreeNode[] {
  const depth = Math.max(...below.map((node) => node.headingPath.length));
  const level = Math.max(...below.map((node) => node.level)) + 1;
  const runs = runsBy(below, (node) => node.headingPath.slice(0, Math.max(0, Math.min(node.headingPath.length, depth - 1))));
  return runs.flatMap((run) => similarityCuts(vectors, run.start, run.end, opts.fanIn, opts.minFanIn).map(([start, end]) => {
    if (end - start === 1) return { ...below[start]!, headingPath: run.path, children: [start], promoted: true };
    return { level, headingPath: run.path, children: Array.from({ length: end - start }, (_, i) => start + i), leafStart: below[start]!.leafStart, leafEnd: below[end - 1]!.leafEnd };
  }));
}

/**
 * The whole tree. `upperVectors(level, nodes)` supplies one vector per node of
 * a finished level (summary vectors in a real build; a caller may pass a proxy
 * when no summaries exist, and must say so).
 */
export async function groupLeaves(
  leaves: Leaf[], vectors: ArrayLike<number>[], opts: GroupOptions,
  upperVectors: (nodes: TreeNode[], levelIndex: number) => Promise<ArrayLike<number>[]> | ArrayLike<number>[],
): Promise<Tree> {
  if (leaves.length === 0) return { leaves, levels: [] };
  const levels: TreeNode[][] = [groupLeafLevel(leaves, vectors, opts)];
  while (levels[levels.length - 1]!.length > 1) {
    const below = levels[levels.length - 1]!;
    const next = groupUpperLevel(below, await upperVectors(below, levels.length - 1), opts);
    // No heading left to drop and nothing merged cannot happen (one headless section always merges); guard anyway.
    if (next.length >= below.length && Math.max(...below.map((node) => node.headingPath.length)) === 0) throw new Error("Grouping made no progress");
    levels.push(next);
  }
  return { leaves, levels };
}

/** Every leaf under exactly one level-1 group and every node under exactly one parent. */
export function coverageProblems(tree: Tree): string[] {
  const problems: string[] = [];
  let size = tree.leaves.length;
  tree.levels.forEach((nodes, levelIndex) => {
    const seen = new Array<number>(size).fill(0);
    for (const node of nodes) for (const child of node.children) seen[child] = (seen[child] ?? 0) + 1;
    const bad = seen.findIndex((count) => count !== 1);
    if (bad >= 0) problems.push(`level ${levelIndex + 1}: child ${bad} has ${seen[bad]} parents`);
    size = nodes.length;
  });
  if (tree.levels.length && tree.levels[tree.levels.length - 1]!.length !== 1) problems.push("no single root");
  return problems;
}

export function meanVector(vectors: ArrayLike<number>[]): number[] {
  const out = new Array<number>(vectors[0]!.length).fill(0);
  for (const vector of vectors) for (let i = 0; i < out.length; i += 1) out[i]! += vector[i]! / vectors.length;
  return out;
}

/** Hashes for every node, bottom up. Promoted nodes keep the hash of the node they carry. */
export function hashTree(tree: Tree, settings: HashSettings): string[][] {
  const hashes: string[][] = [];
  let below = tree.leaves.map((leaf) => leaf.hash);
  for (const nodes of tree.levels) {
    const current = nodes.map((node) => node.promoted ? below[node.children[0]!]! : nodeHash(settings, node.level, node.headingPath, node.children.map((child) => below[child]!)));
    hashes.push(current);
    below = current;
  }
  return hashes;
}
