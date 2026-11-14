/**
 * Reuse experiment: how much of a document's tree survives a new version.
 * Grouping and hashing only; no summary is generated.
 *
 *   tsx scripts/summary-tree-eval/reuse.mts MANIFEST OUTPUT.json
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

import { groupLeaves, hashTree, meanVector, STANDIN_GROUP_OPTIONS, type Tree, type TreeNode } from "./grouping-standin.mts";
import { buildDocument, leavesOf, loadManifest, sourceText } from "./lib.mts";
import { paginate } from "./prepare-sources.mts";
import { HASH_SETTINGS } from "./tree.mts";

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

type Built = { tree: Tree; hashes: string[][]; leafHashes: string[] };
async function build(base: { id: string; title: string }, text: string | undefined, documentId: string): Promise<Built> {
  const document = await buildDocument(base, { text, documentId, step: "reuse" });
  const { leaves, chunks } = leavesOf(document);
  const leafVectors = chunks.map((chunk) => chunk.vector);
  const tree = await groupLeaves(leaves, leafVectors, STANDIN_GROUP_OPTIONS, (nodes: TreeNode[]) => nodes.map((node) => meanVector(leafVectors.slice(node.leafStart, node.leafEnd + 1))));
  return { tree, hashes: hashTree(tree, HASH_SETTINGS), leafHashes: leaves.map((leaf) => leaf.hash) };
}

const boundaries = (built: Built, levelIndex: number) => new Set(built.tree.levels[levelIndex]!.slice(1).map((node) => `${built.leafHashes[node.leafStart - 1]}|${built.leafHashes[node.leafStart]}`));
const share = (part: number, whole: number) => whole ? Math.round((1000 * part) / whole) / 10 : null;

export function compare(prior: Built, next: Built) {
  const priorLeaves = new Set(prior.leafHashes);
  const levels = next.tree.levels.map((nodes, levelIndex) => {
    // A node hash covers its level, so reuse is looked up in every prior level's set of that node level.
    const priorHashes = new Set(prior.hashes.flat());
    const own = nodes.map((node, i) => ({ node, hash: next.hashes[levelIndex]![i]! })).filter(({ node }) => !node.promoted);
    const reused = own.filter(({ hash }) => priorHashes.has(hash)).length;
    const nextBoundaries = boundaries(next, levelIndex);
    const priorBoundaries = levelIndex < prior.tree.levels.length ? boundaries(prior, levelIndex) : new Set<string>();
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
  writeFileSync(output!, JSON.stringify({ grouping: "stand-in", upperLevelVectors: "mean of leaf vectors (proxy for summary vectors)", options: STANDIN_GROUP_OPTIONS, hashSettings: HASH_SETTINGS, rows }, null, 2) + "\n");
  process.exit(0);
}
