/**
 * Build the frozen trees with the product summary-tree library instead of the
 * stand-in: its leaf selection, grouping, hashing, prompt, output parser and
 * truncation rule, at its default limits.
 *
 *   SUMMARY_TREE_EVAL_TREE_DIR=tree-product [SUMMARY_TREE_EVAL_LIB=/abs/path/worker/src/summary-tree/index.ts] \
 *     tsx scripts/summary-tree-eval/tree-product.mts MANIFEST [--dry-run]
 *
 * The library is loaded at run time (default: this checkout's
 * worker/src/summary-tree), so the harness also runs before the library is
 * merged by pointing SUMMARY_TREE_EVAL_LIB at a checkout that has it. Trees
 * are written in the same format as tree.mts, to SUMMARY_TREE_EVAL_TREE_DIR,
 * so arms.mts reads either. A document the library skips gets a skip record
 * with the library's reason instead of a tree.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { embedDocuments, generateWithRefusalFallback, loadDocument, loadManifest, readJson, sha, TEXT_MODEL, type EvalDocument } from "./lib.mts";
import { skipPath, treeDir, treePath, type StoredNode, type StoredTree } from "./tree.mts";

const CONCURRENCY = 8;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the library is resolved at run time; its types are not on this branch yet.
type Library = any;
export const loadLibrary = async (): Promise<Library> => import(process.env.SUMMARY_TREE_EVAL_LIB ?? "../../worker/src/summary-tree/index.js");

async function pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => { while (next < items.length) await worker(items[next++]!); }));
}

export function selectLeaves(lib: Library, document: EvalDocument) {
  const chunks = lib.summaryTreeChunksFromEmbeddingChunks(document.chunks.map((chunk) => ({
    index: chunk.index, headingPath: chunk.headingPath, pageNumber: chunk.pageNumber, pageNumbers: chunk.pageNumbers,
    tableGranularity: chunk.metadata.tableGranularity ?? null, evidenceType: chunk.metadata.evidenceType ?? null, metadata: chunk.metadata,
  })));
  return lib.selectSummaryTreeLeaves({ normalizedFormat: "markdown", mimeType: "text/markdown" }, chunks);
}

export const hashContext = (lib: Library) => ({ modelId: TEXT_MODEL, textGeneration: { reasoningEffort: lib.SUMMARY_TREE_REASONING_EFFORT }, lengthTargetWords: lib.DEFAULT_SUMMARY_TREE_LIMITS.summaryLengthWords });

type Summary = { title: string; text: string; attempts: Array<{ inputTokens: number; outputTokens: number; ms: number; finishReason: string; model: string; refused: boolean }> };

if (process.argv[1]?.endsWith("tree-product.mts")) {
  const [manifestPath, flag] = process.argv.slice(2);
  const lib = await loadLibrary();
  const limits = lib.DEFAULT_SUMMARY_TREE_LIMITS;
  const summaryDir = join(treeDir(), "summaries"); mkdirSync(summaryDir, { recursive: true });
  for (const source of loadManifest(manifestPath!).sources.filter((entry) => entry.role === "corpus")) {
    const document = loadDocument(source.id);
    const selection = selectLeaves(lib, document);
    if (selection.skipReason) {
      if (flag !== "--dry-run") writeFileSync(skipPath(document.id), JSON.stringify({ documentId: document.id, skipReason: selection.skipReason, excluded: selection.excluded, stats: selection.stats }));
      console.log(JSON.stringify({ document: document.id, skipped: selection.skipReason, stats: selection.stats }));
      continue;
    }
    const leaves = selection.leaves as Array<{ chunkIndex: number; rawText: string }>;
    const chunkByIndex = new Map(document.chunks.map((chunk) => [chunk.index, chunk]));
    const position = new Map(leaves.map((leaf, i) => [leaf.chunkIndex, i]));
    const leafVectors = leaves.map((leaf) => chunkByIndex.get(leaf.chunkIndex)!.vector);
    const similarities = lib.adjacentSimilarities(leaves.length, (at: number) => leafVectors[at]);
    if (flag === "--dry-run") {
      const builder = new lib.SummaryTreeBuilder(leaves, similarities);
      console.log(source.id, leaves.length, "leaves", builder.nodes.length, "level-1 groups", JSON.stringify(selection.excluded));
      continue;
    }
    const leafHashByChunkIndex = lib.leafHashesByChunkIndex(leaves);
    const context = lib.summaryTreeContextKey(hashContext(lib));
    let hashes: string[] = [];
    const summaries: Summary[] = [];
    const vectors: ArrayLike<number>[] = [];
    let calls = 0, reused = 0;
    const tree = await lib.buildSummaryTree({
      leaves, leafSimilarities: similarities,
      onLevel: async (indexes: number[], builder: { nodes: Array<{ childKind: string; children: number[]; headingPath: string[] }> }) => {
        hashes = lib.hashSummaryTreeNodes({ nodes: builder.nodes, leafHashByChunkIndex, context, known: hashes });
        await pool(indexes, async (index) => {
          const file = join(summaryDir, `${hashes[index]}.json`);
          if (existsSync(file)) { summaries[index] = readJson<Summary>(file); reused += 1; return; }
          const node = builder.nodes[index]!;
          const parts = node.childKind === "leaf" ? node.children.map((chunkIndex) => ({ text: chunkByIndex.get(chunkIndex)!.rawText })) : node.children.map((child) => ({ title: summaries[child]!.title, text: summaries[child]!.text }));
          const task = lib.buildSummaryTreePrompt({ parts, headingPath: node.headingPath, lengthTargetWords: limits.summaryLengthWords });
          if (task.truncated) throw new Error(`Node ${hashes[index]} exceeds the prompt content limit`);
          const attempts: Summary["attempts"] = [];
          const outcome = await lib.generateSummaryWithRetry({
            maxOutputTokens: lib.summaryOutputTokenBudget(limits.summaryLengthWords),
            call: async (maxOutputTokens: number) => {
              const result = await generateWithRefusalFallback("tree-product:summary", task.system, task.prompt, maxOutputTokens);
              attempts.push({ inputTokens: result.inputTokens, outputTokens: result.outputTokens, ms: result.ms, finishReason: result.finishReason, model: result.model, refused: result.refused });
              return { text: result.text, finishReason: result.finishReason, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens } };
            },
          });
          calls += attempts.length;
          if (outcome.status !== "ok") throw new Error(`Node ${hashes[index]} not stored: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}${outcome.error ? ` ${String(outcome.error).slice(0, 300)}` : ""}`);
          summaries[index] = { title: outcome.summary.title, text: outcome.summary.text, attempts };
          writeFileSync(file, JSON.stringify(summaries[index]));
        });
        const embedded = await embedDocuments(indexes.map((index) => `${summaries[index]!.title}\n${summaries[index]!.text}`), "tree-product:embed");
        indexes.forEach((index, i) => { vectors[index] = embedded[i]!; });
      },
      vectorOf: (index: number) => vectors[index],
    });
    const violations = lib.checkSummaryTreeCoverage(tree);
    if (Array.isArray(violations) ? violations.length : violations?.violations?.length) throw new Error(`Coverage check failed for ${document.id}: ${JSON.stringify(violations).slice(0, 400)}`);
    const nodes = (tree.nodes as Array<{ level: number; headingPath: string[]; chunkStart: number; chunkEnd: number; pageStart: number | null; pageEnd: number | null }>).map<StoredNode>((node, index) => ({
      id: hashes[index]!, documentId: document.id, level: node.level, headingPath: node.headingPath, leafStart: position.get(node.chunkStart)!, leafEnd: position.get(node.chunkEnd)!,
      chunkStart: node.chunkStart, chunkEnd: node.chunkEnd, pageStart: node.pageStart, pageEnd: node.pageEnd, text: `${summaries[index]!.title}\n${summaries[index]!.text}`, vector: Array.from(vectors[index]!),
    }));
    const stored: StoredTree = { documentId: document.id, settings: hashContext(lib), options: limits, grouping: `product library (key version ${lib.SUMMARY_TREE_KEY_VERSION}, ${lib.SUMMARY_TREE_PROMPT_VERSION})`, leafChunkIndexes: tree.leafChunkIndexes, nodes, rootId: hashes[tree.root]!, calls, reused };
    writeFileSync(treePath(document.id), JSON.stringify(stored));
    const byLevel: Record<number, number> = {};
    for (const node of nodes) byLevel[node.level] = (byLevel[node.level] ?? 0) + 1;
    console.log(JSON.stringify({ document: document.id, pages: document.pages, leaves: leaves.length, excluded: selection.excluded, nodes: nodes.length, byLevel, calls, reused, treeSha256: sha(JSON.stringify(nodes.map((node) => [node.id, node.text]))) }));
  }
  process.exit(0);
}
