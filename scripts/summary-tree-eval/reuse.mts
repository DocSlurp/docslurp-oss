/**
 * Reuse experiment: how much of a document's tree survives a new version.
 * Grouping and hashing only; no summary is generated.
 *
 *   [SUMMARY_TREE_EVAL_GROUPING=product SUMMARY_TREE_EVAL_LIB=…] tsx scripts/summary-tree-eval/reuse.mts MANIFEST OUTPUT.json
 *
 * SUMMARY_TREE_EVAL_GROUPING=product uses the product summary-tree library
 * (see tree-product.mts); otherwise the stand-in.
 *
 * Version pairs per base document: identical bytes; one paragraph inserted;
 * one heading renamed; a different extractor (another rendition of the same
 * work listed in the manifest as `renditionOf`). Each version is chunked and
 * embedded exactly like the corpus, then grouped. Upper levels are cut over the
 * mean of each node's leaf vectors, a PROXY for summary vectors (which would
 * need model calls); level-1 grouping uses real chunk vectors.
 *
 * Reported per level: node reuse (share of the new version's nodes whose hash
 * the prior version already has) and boundary overlap (group boundaries,
 * identified by the leaf hashes on each side, shared with the prior version).
 */
import { writeFileSync } from "node:fs";

import { groupLeaves, hashTree, meanVector, STANDIN_GROUP_OPTIONS, type TreeNode } from "./grouping-standin.mts";
import { buildDocument, leavesOf, loadManifest, sourceText } from "./lib.mts";
import { paginate } from "./prepare-sources.mts";
import { HASH_SETTINGS } from "./tree.mts";
import { hashContext, loadLibrary, selectLeaves } from "./tree-product.mts";

const INSERTED_PARAGRAPH = "Editorial note added for this edition. The surrounding passage was compared against an earlier printing, and a small number of spelling variants were left as the first printer set them. Readers who consult both printings will find the pagination differs slightly, while the wording of the text itself is unchanged. No other alteration has been made to this part of the work.";

/** Insert one paragraph at the paragraph boundary nearest `share` of the text, then page it again. */
export function insertParagraph(text: string, share = 0.4): string {
  const paragraphs = text.replaceAll("\f", "\n").replace(/\n{3,}/g, "\n\n").trim().split("\n\n");
  const target = text.length * share;
  let consumed = 0, at = 0;
  while (at < paragraphs.length && consumed < target) { consumed += paragraphs[at]!.length + 2; at += 1; }
  // Never directly under a heading line, so the insertion is a body edit.
  while (at < paragraphs.length && /^#{1,6} /.test(paragraphs[at - 1] ?? "")) at += 1;
  return paginate([...paragraphs.slice(0, at), INSERTED_PARAGRAPH, ...paragraphs.slice(at)].join("\n\n")).text;
}

/** Rename the heading line nearest the middle of the text; null when the text has no heading. */
export function renameHeading(text: string): string | null {
  const lines = text.split("\n");
  const headings = lines.flatMap((line, i) => /^#{1,6} \S/.test(line) ? [i] : []);
  if (!headings.length) return null;
  let offset = 0; const middle = text.length / 2; let best = headings[0]!, bestDistance = Infinity;
  lines.forEach((line, i) => { if (headings.includes(i) && Math.abs(offset - middle) < bestDistance) { bestDistance = Math.abs(offset - middle); best = i; } offset += line.length + 1; });
  lines[best] = `${lines[best]} (Revised)`;
  return lines.join("\n");
}

/** One version's tree reduced to what reuse needs: per level, each summarized node's hash and first leaf position. */
type Built = { leafHashes: string[]; levels: Array<Array<{ hash: string; leafStart: number }>> };
const useProductLibrary = process.env.SUMMARY_TREE_EVAL_GROUPING === "product";

async function build(base: { id: string; title: string }, text: string | undefined, documentId: string): Promise<Built> {
  const document = await buildDocument(base, { text, documentId, step: "reuse" });
  if (useProductLibrary) {
    const lib = await loadLibrary();
    const selection = selectLeaves(lib, document);
    if (selection.skipReason) throw new Error(`The library skips ${documentId}: ${selection.skipReason}`);
    const leaves = selection.leaves as Array<{ chunkIndex: number; rawText: string }>;
    const byIndex = new Map(document.chunks.map((chunk) => [chunk.index, chunk]));
    const position = new Map(leaves.map((leaf, i) => [leaf.chunkIndex, i]));
    const leafVectors = leaves.map((leaf) => byIndex.get(leaf.chunkIndex)!.vector);
    let builderNodes: Array<{ chunkStart: number; chunkEnd: number; level: number }> = [];
    const tree = await lib.buildSummaryTree({
      leaves, leafSimilarities: lib.adjacentSimilarities(leaves.length, (at: number) => leafVectors[at]),
      onLevel: (_indexes: number[], builder: { nodes: typeof builderNodes }) => { builderNodes = builder.nodes; },
      vectorOf: (index: number) => { const node = builderNodes[index]!; return meanVector(leafVectors.slice(position.get(node.chunkStart)!, position.get(node.chunkEnd)! + 1)); },
    });
    const leafHashByChunkIndex = lib.leafHashesByChunkIndex(leaves);
    const hashes: string[] = lib.hashSummaryTreeNodes({ nodes: tree.nodes, leafHashByChunkIndex, context: hashContext(lib) });
    const levels: Built["levels"] = [];
    (tree.nodes as typeof builderNodes).forEach((node, index) => { (levels[node.level - 1] ??= []).push({ hash: hashes[index]!, leafStart: position.get(node.chunkStart)! }); });
    return { leafHashes: leaves.map((leaf) => leafHashByChunkIndex.get(leaf.chunkIndex)!), levels: levels.map((level) => level ?? []) };
  }
  const { leaves, chunks } = leavesOf(document);
  const leafVectors = chunks.map((chunk) => chunk.vector);
  const tree = await groupLeaves(leaves, leafVectors, STANDIN_GROUP_OPTIONS, (nodes: TreeNode[]) => nodes.map((node) => meanVector(leafVectors.slice(node.leafStart, node.leafEnd + 1))));
  const hashes = hashTree(tree, HASH_SETTINGS);
  return { leafHashes: leaves.map((leaf) => leaf.hash), levels: tree.levels.map((nodes, levelIndex) => nodes.flatMap((node, i) => node.promoted ? [] : [{ hash: hashes[levelIndex]![i]!, leafStart: node.leafStart }])) };
}

/** Group boundaries of a level, each identified by the leaf hashes on its two sides. */
const boundaries = (built: Built, levelIndex: number) => new Set((built.levels[levelIndex] ?? []).filter((node) => node.leafStart > 0).map((node) => `${built.leafHashes[node.leafStart - 1]}|${built.leafHashes[node.leafStart]}`));
const share = (part: number, whole: number) => whole ? Math.round((1000 * part) / whole) / 10 : null;

export function compare(prior: Built, next: Built) {
  const priorLeaves = new Set(prior.leafHashes);
  // A node hash covers its level, so one set of every prior node hash is enough.
  const priorHashes = new Set(prior.levels.flat().map((node) => node.hash));
  const levels = next.levels.map((own, levelIndex) => {
    const reused = own.filter(({ hash }) => priorHashes.has(hash)).length;
    const nextBoundaries = boundaries(next, levelIndex);
    const priorBoundaries = boundaries(prior, levelIndex);
    const shared = [...nextBoundaries].filter((boundary) => priorBoundaries.has(boundary)).length;
    return { level: levelIndex + 1, nodes: own.length, reused, reusePercent: share(reused, own.length), newSummaryCalls: own.length - reused,
      boundaries: nextBoundaries.size, priorBoundaries: priorBoundaries.size, boundariesKeptPercent: share(shared, priorBoundaries.size), boundariesSharedOfNewPercent: share(shared, nextBoundaries.size) };
  });
  const leafReused = next.leafHashes.filter((hash) => priorLeaves.has(hash)).length;
  const nodes = levels.reduce((sum, level) => sum + level.nodes, 0), reused = levels.reduce((sum, level) => sum + level.reused, 0);
  return { leaves: next.leafHashes.length, priorLeaves: prior.leafHashes.length, leafReusePercent: share(leafReused, next.leafHashes.length), nodes, reused, nodeReusePercent: share(reused, nodes), newSummaryCalls: nodes - reused, levels };
}

if (process.argv[1]?.endsWith("reuse.mts")) {
  const [manifestPath, output] = process.argv.slice(2);
  const manifest = loadManifest(manifestPath!);
  // Which documents get version pairs is data: the manifest marks them `reuseBase`.
  const bases = manifest.sources.filter((entry) => (entry as { reuseBase?: boolean }).reuseBase).map((entry) => entry.id);
  if (!bases.length) throw new Error("No source in the manifest is marked reuseBase");
  const rows: Array<Record<string, unknown>> = [];
  for (const id of bases) {
    const source = manifest.sources.find((entry) => entry.id === id)!;
    const base = { id: source.id, title: source.title };
    const text = sourceText(id);
    const prior = await build(base, undefined, id);
    const variants: Array<[string, string | null]> = [
      ["identical bytes", text],
      ["one paragraph inserted", insertParagraph(text)],
      ["one heading renamed", renameHeading(text)],
      ...manifest.sources.filter((entry) => entry.renditionOf === id).map<[string, string]>((entry) => [`different extractor (${entry.converter})`, sourceText(entry.id)]),
    ];
    for (const [variant, variantText] of variants) {
      if (variantText === null) { rows.push({ document: id, variant, notApplicable: "document has no heading" }); continue; }
      const result = compare(prior, await build(base, variantText, `${id}-variant`));
      rows.push({ document: id, variant, ...result });
      console.log(id, "|", variant, "| leaves", result.leafReusePercent, "% | nodes", result.nodeReusePercent, "% | calls", result.newSummaryCalls, "|", result.levels.map((level) => `L${level.level} ${level.reusePercent}% b${level.boundariesKeptPercent}%`).join(" "));
    }
  }
  const settings = useProductLibrary ? { grouping: "product library", options: (await loadLibrary()).DEFAULT_SUMMARY_TREE_LIMITS } : { grouping: "stand-in", options: STANDIN_GROUP_OPTIONS, hashSettings: HASH_SETTINGS };
  writeFileSync(output!, JSON.stringify({ ...settings, upperLevelVectors: "mean of leaf vectors (proxy for summary vectors)", rows }, null, 2) + "\n");
  process.exit(0);
}
