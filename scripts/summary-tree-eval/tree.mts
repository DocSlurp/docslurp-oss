/**
 * Build one frozen summary tree per corpus document.
 *
 *   tsx scripts/summary-tree-eval/tree.mts MANIFEST [--dry-run]
 *
 * Grouping and hashing come from grouping-standin.mts (STAND-IN until the
 * product library exists). The summary contract follows the plan: source
 * language, line 1 a short title, then about N words; reasoning at the floor;
 * one retry at double the output budget on truncation, both attempts counted;
 * a truncated node is never stored. Each group is committed as it finishes
 * (one file per node hash), so a stopped build resumes with only the missing
 * calls. `--dry-run` groups level 1 only and prints the size of the paid work.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildTrustedDocumentTaskPrompt } from "../../worker/src/lib/trusted-llm-task.js";
import { coverageProblems, groupLeafLevel, groupLeaves, hashTree, nodeHash, STANDIN_GROUP_OPTIONS, type HashSettings, type TreeNode } from "./grouping-standin.mts";
import { embedDocuments, generateWithRefusalFallback, leavesOf, loadDocument, loadManifest, readJson, ROOT, sha, TEXT_MODEL } from "./lib.mts";

export const SUMMARY_WORDS = 120;
export const HASH_SETTINGS: HashSettings = { treeKeyVersion: "eval-standin-1", promptVersion: "eval-standin-prompt-1", model: TEXT_MODEL, textSettings: "reasoning=none", lengthTarget: SUMMARY_WORDS };
export const INSTRUCTION = "Summarize this part of a document for a search index. Write in the language of the source.";
export const OUTPUT_CONTRACT = `Line 1: a short title. Then a summary of about ${SUMMARY_WORDS} words. Keep names, numbers, dates and defined terms. Return only the title line and the summary.`;
const OUTPUT_TOKENS = 400;
const CONCURRENCY = 8;

export type StoredNode = {
  id: string; documentId: string; level: number; headingPath: string[]; leafStart: number; leafEnd: number;
  chunkStart: number; chunkEnd: number; pageStart: number | null; pageEnd: number | null; text: string; vector: number[];
};
export type StoredTree = { documentId: string; settings: HashSettings; options: typeof STANDIN_GROUP_OPTIONS; grouping: "stand-in"; leafChunkIndexes: number[]; nodes: StoredNode[]; rootId: string; calls: number; reused: number };
type NodeSummary = { text: string; attempts: Array<{ inputTokens: number; outputTokens: number; ms: number; finishReason: string; model: string; refused: boolean }> };

const summaryDir = () => { const dir = join(ROOT(), "tree", "summaries"); mkdirSync(dir, { recursive: true }); return dir; };
export const treePath = (documentId: string) => join(ROOT(), "tree", `${documentId}.tree.json`);

async function pool<T, R>(items: T[], worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const index = next++; out[index] = await worker(items[index]!, index); }
  }));
  return out;
}

async function summarize(hash: string, title: string, headingPath: string[], level: number, content: string): Promise<{ summary: NodeSummary; reused: boolean }> {
  const file = join(summaryDir(), `${hash}.json`);
  if (existsSync(file)) return { summary: readJson<NodeSummary>(file), reused: true };
  const task = buildTrustedDocumentTaskPrompt({
    instruction: INSTRUCTION, outputContract: OUTPUT_CONTRACT, untrustedContent: content,
    untrustedContentLabel: level === 1 ? "document section" : "section summaries, in document order",
    trustedContext: [{ label: "Document", value: title }, ...(headingPath.length ? [{ label: "Section", value: headingPath.join(" > ") }] : [])],
  });
  if (task.truncated) throw new Error(`Group ${hash} exceeds the prompt content limit; grouping produced an oversized group`);
  const attempts: NodeSummary["attempts"] = [];
  for (const budget of [OUTPUT_TOKENS, OUTPUT_TOKENS * 2]) {
    const result = await generateWithRefusalFallback("tree:summary", task.system, task.prompt, budget);
    attempts.push({ inputTokens: result.inputTokens, outputTokens: result.outputTokens, ms: result.ms, finishReason: result.finishReason, model: result.model, refused: result.refused });
    if (result.finishReason !== "length" && result.text.trim()) {
      const summary = { text: result.text.trim(), attempts };
      writeFileSync(file, JSON.stringify(summary));
      return { summary, reused: false };
    }
  }
  throw new Error(`Group ${hash} was truncated twice; not stored`);
}

if (process.argv[1]?.endsWith("tree.mts")) {
  const [manifestPath, flag] = process.argv.slice(2);
  const only = process.env.SUMMARY_TREE_EVAL_ONLY?.split(",");
  const sources = loadManifest(manifestPath!).sources.filter((source) => source.role === "corpus" && (!only || only.includes(source.id)));
  let totalGroups = 0;
  for (const source of sources) {
    const document = loadDocument(source.id);
    const { leaves, chunks } = leavesOf(document);
    const vectors = chunks.map((chunk) => chunk.vector);
    if (flag === "--dry-run") {
      const level1 = groupLeafLevel(leaves, vectors, STANDIN_GROUP_OPTIONS);
      totalGroups += level1.length;
      console.log(source.id, leaves.length, "leaves", level1.length, "level-1 groups", level1.filter((node) => node.children.length === 1).length, "single-leaf");
      continue;
    }
    const levelHashes: string[][] = [];
    const levelTexts: string[][] = [];
    const levelVectors: ArrayLike<number>[][] = [];
    let calls = 0, reused = 0;
    // Summaries of a level must exist before the level above can be cut, so each level is built inside the grouping callback.
    const finishLevel = async (nodes: TreeNode[], levelIndex: number) => {
      const belowHashes = levelIndex === 0 ? leaves.map((leaf) => leaf.hash) : levelHashes[levelIndex - 1]!;
      const belowTexts = levelIndex === 0 ? chunks.map((chunk) => chunk.rawText) : levelTexts[levelIndex - 1]!;
      const hashes = nodes.map((node) => node.promoted ? belowHashes[node.children[0]!]! : nodeHash(HASH_SETTINGS, node.level, node.headingPath, node.children.map((child) => belowHashes[child]!)));
      const texts = await pool(nodes, async (node, i) => {
        if (node.promoted) return belowTexts[node.children[0]!]!;
        const { summary, reused: hit } = await summarize(hashes[i]!, document.title, node.headingPath, node.level, node.children.map((child) => belowTexts[child]!).join("\n\n"));
        if (hit) reused += 1; else calls += summary.attempts.length;
        return summary.text;
      });
      // The summary vector is keyed by text and embedding model only, so a new embedding model re-embeds without re-summarizing.
      const embedded = await embedDocuments(texts, "tree:embed");
      const bad = embedded.findIndex((vector) => vector.length !== vectors[0]!.length || !vector.every(Number.isFinite));
      if (bad >= 0) throw new Error(`Summary vector ${bad} at level ${levelIndex + 1} is not a finite ${vectors[0]!.length}-d vector (length ${embedded[bad]!.length})`);
      levelHashes[levelIndex] = hashes; levelTexts[levelIndex] = texts; levelVectors[levelIndex] = embedded;
      return embedded;
    };
    const tree = await groupLeaves(leaves, vectors, STANDIN_GROUP_OPTIONS, finishLevel);
    await finishLevel(tree.levels[tree.levels.length - 1]!, tree.levels.length - 1);
    const problems = coverageProblems(tree);
    if (problems.length) throw new Error(`Coverage invariant failed for ${source.id}: ${problems.join("; ")}`);
    const check = hashTree(tree, HASH_SETTINGS);
    if (JSON.stringify(check) !== JSON.stringify(levelHashes)) throw new Error("Hash mismatch between build and hashTree");
    const seen = new Set<string>();
    const nodes: StoredNode[] = [];
    tree.levels.forEach((level, levelIndex) => level.forEach((node, i) => {
      const id = levelHashes[levelIndex]![i]!;
      if (node.promoted || seen.has(id)) return;
      seen.add(id);
      const covered = chunks.slice(node.leafStart, node.leafEnd + 1);
      const pages = covered.flatMap((chunk) => chunk.pageNumbers);
      nodes.push({ id, documentId: document.id, level: node.level, headingPath: node.headingPath, leafStart: node.leafStart, leafEnd: node.leafEnd,
        chunkStart: covered[0]!.index, chunkEnd: covered[covered.length - 1]!.index, pageStart: pages.length ? Math.min(...pages) : null, pageEnd: pages.length ? Math.max(...pages) : null,
        text: levelTexts[levelIndex]![i]!, vector: Array.from(levelVectors[levelIndex]![i]!) });
    }));
    const stored: StoredTree = { documentId: document.id, settings: HASH_SETTINGS, options: STANDIN_GROUP_OPTIONS, grouping: "stand-in", leafChunkIndexes: chunks.map((chunk) => chunk.index), nodes, rootId: levelHashes[levelHashes.length - 1]![0]!, calls, reused };
    writeFileSync(treePath(document.id), JSON.stringify(stored));
    console.log(JSON.stringify({ document: document.id, pages: document.pages, leaves: leaves.length, nodes: nodes.length, levels: tree.levels.length, byLevel: tree.levels.map((level) => level.filter((node) => !node.promoted).length), calls, reused, treeSha256: sha(JSON.stringify(nodes.map((node) => [node.id, node.text]))) }));
  }
  if (flag === "--dry-run") console.log("level-1 groups", totalGroups);
  process.exit(0);
}
