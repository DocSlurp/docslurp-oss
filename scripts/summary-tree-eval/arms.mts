/**
 * Run the phase-0 quality arms over a case file and keep every raw output.
 *
 *   DATABASE_URL=… LANCEDB_URI=… tsx scripts/summary-tree-eval/arms.mts CASES RUN_DIR [--arms a,b] [--no-answers] [--confirmation]
 *
 * Arms (k = 10 throughout):
 *   current-default product hybrid search as a new project runs it: provider-backed options off, project search
 *                   settings at their defaults (which collapse results to one per document when several documents match)
 *   current         the same with the project's `dedupeByFilename` setting off; every arm below uses this setting
 *   summary-seed    the same with summarySeed
 *   document-order  the current arm's ten results presented in document order (zero build)
 *   long-context    the whole gold document(s) as context, when they fit the reader's window; answer only
 *   tree-guide      SIMULATED: summary hits select chunk ranges, fused with the chunk leg; real chunks only
 *   tree-include    SIMULATED: tree-guide with the top summaries returned in a capped share of the slots
 *   product-guide   product summary-tree leg, real fusion and provisional deadline
 *   product-include product leg with separately capped generated summaries
 *   closed-book     no context; measures how much the reader already knows (answer only)
 *
 * The tree arms are a harness simulation over the frozen stand-in tree: the
 * product retrieval leg does not exist yet. Their fusion rule is fixed here
 * and was not tuned. Retrieval is scored with the existing scorer
 * (scripts/retrieval-quality/eval.mjs `score`); answers with the existing
 * deterministic check (scripts/multisearch-quality/score.mjs `scoreCase`,
 * its `answer` check). This file only aggregates their outputs.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";


import { scoreCase } from "../multisearch-quality/score.mjs";
import { score } from "../retrieval-quality/eval.mjs";
import { loadCases, type EvalCase } from "./cases.mts";
import { cosine } from "./grouping-standin.mts";
import { embedQueries, generateWithRefusalFallback, loadDocument, need, ORG, PROJECT, readJson, USER, type EvalChunk, type EvalDocument } from "./lib.mts";
import { skipPath, treePath, type StoredNode, type StoredTree } from "./tree.mts";

export const K = 10;
/** Summary hits considered, chunks taken per hit, and slots `include` gives to summaries: fixed before any run. */
export const TREE_RULE = { summaryHits: 5, chunksPerHit: 3, includeSummarySlots: 3, rrfK: 60, chunkLegDepth: 50 };
const READER_TOKENS = 400;
/** Reader context budget in characters for long-context (the default text model's window, less headroom). */
const LONG_CONTEXT_MAX_CHARS = 3_200_000;
const ALL_ARMS = ["current-default", "current", "summary-seed", "document-order", "long-context", "tree-guide", "tree-include", "product-guide", "product-include", "closed-book"] as const;
type Arm = typeof ALL_ARMS[number];
type Result = { text: string; citation: { documentId: string; chunkIndex?: number; pageNumber: number | null; pageNumbers: number[] }; kind?: "chunk" | "summary"; summary?: { id: string; level: number; chunkStart: number; chunkEnd: number } };

const BASE_OPTIONS = {
  limit: K, minScore: 0, useRerank: false, queryRewrite: false, selfQuery: false, parentRetrieval: true, useHyDE: false,
  stepback: false, iterativeMultiHop: false, enableGraphExpansion: false, enableCommunityExpansion: false, summarySeed: false, queryDecompose: false,
  useMmr: false, resultOrder: "relevance" as const, searchMode: "hybrid" as const, suppressSessionLog: true,
};
const SCOPE = { orgId: ORG, projectIds: "org", modeCeiling: null, actor: { type: "session" } } as const;

const documents = new Map<string, EvalDocument>();
const document = (id: string) => { if (!documents.has(id)) documents.set(id, loadDocument(id)); return documents.get(id)!; };
const chunkResult = (documentId: string, chunk: EvalChunk): Result => ({ kind: "chunk", text: chunk.text, citation: { documentId, chunkIndex: chunk.index, pageNumber: chunk.pageNumber, pageNumbers: chunk.pageNumbers } });

function rrf(lists: string[][], k: number): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key);
}

/** Summary leg: exact cosine over every node of every frozen tree, restricted to the corpus documents. */
function summaryHits(nodes: StoredNode[], queryVector: ArrayLike<number>): StoredNode[] {
  return nodes.map((node) => ({ node, similarity: cosine(queryVector, node.vector) })).sort((a, b) => b.similarity - a.similarity).slice(0, TREE_RULE.summaryHits).map((hit) => hit.node);
}

/** A summary mapped to its leaves: what `include` is scored on beside the strict component. */
function mappedLeaves(node: StoredNode): Result {
  const chunks = document(node.documentId).chunks.filter((chunk) => chunk.index >= node.chunkStart && chunk.index <= node.chunkEnd);
  return { kind: "summary", text: chunks.map((chunk) => chunk.text).join("\n\n"), citation: { documentId: node.documentId, pageNumber: node.pageStart, pageNumbers: [...new Set(chunks.flatMap((chunk) => chunk.pageNumbers))] } };
}

const READER_SYSTEM = "Answer the question using only the provided context. Be specific and brief (at most four sentences). Use the source's own key terms. If the context does not contain the answer, say that it is not in the context.";
function contextBlock(results: Result[]): string {
  return results.map((result, i) => `[${i + 1}] ${result.kind === "summary" ? "(generated summary of a section, not source text) " : ""}${result.text}`).join("\n\n");
}

if (process.argv[1]?.endsWith("arms.mts")) {
  const args = process.argv.slice(2);
  const [casesPath, runDir] = args;
  const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const arms = (option("--arms")?.split(",") ?? [...ALL_ARMS]) as Arm[];
  const answers = !args.includes("--no-answers");
  const { split, cases } = loadCases(casesPath!, { confirmation: args.includes("--confirmation") });
  mkdirSync(runDir!, { recursive: true });
  if (arms.some(arm => arm.startsWith("product-"))) process.env.DOCSLURP_SUMMARY_TREE_SERVE = "on";
  const { sql } = await import("../../server/src/db.js");
  const documentIds = (await sql<{ id: string }[]>`select id from documents where project_id = ${PROJECT}`).map((row) => row.id);
  const trees = documentIds.filter((id) => existsSync(treePath(id))).map((id) => readJson<StoredTree>(treePath(id)));
  const nodes = trees.flatMap((tree) => tree.nodes);
  const treeArms = arms.some((arm) => arm.startsWith("tree-") || arm.startsWith("product-"));
  // A document the grouping library skipped has no nodes and is served by the chunk leg alone, as in the product.
  const untreed = documentIds.filter((id) => !existsSync(treePath(id)) && !existsSync(skipPath(id)));
  if (treeArms && untreed.length) throw new Error(`No frozen tree or recorded skip for ${untreed.length} of ${documentIds.length} documents`);
  if (arms.some(arm => arm.startsWith("product-"))) process.env.DOCSLURP_SUMMARY_TREE_SERVE = "on";
  const search = await import("../../server/src/services/search.js");
  const controls = await import("../../server/src/services/search-controls.js");
  let dedupeNow: boolean | null = null;
  const setDedupe = async (value: boolean) => {
    if (dedupeNow === value) return;
    await controls.upsertProjectSearchSettings({ ...(await controls.getProjectSearchSettings(PROJECT, USER)), dedupeByFilename: value });
    dedupeNow = value;
  };
  const session = await import("../../server/src/search/session.js");
  const queryVectors = await embedQueries(cases.map((item) => item.question), "arms:embed-query");

  const rows: Array<Record<string, unknown>> = [];
  for (const [caseIndex, item] of cases.entries()) {
    const queryVector = Array.from(queryVectors[caseIndex]!);
    const run = async (options: Record<string, unknown>, dedupe = false) => {
      await setDedupe(dedupe);
      const started = performance.now();
      const response = await search.hybridSearch(item.question, USER, { ...BASE_OPTIONS, ...options, queryVector, filters: { projectId: PROJECT } } as never, SCOPE);
      const ms = performance.now() - started;
      await session.drainSearchSessionWrites();
      return { results: response.results as unknown as Result[], ms, outcome: response.summaryTree, summaries: response.summaries ?? [], timings: response.timings };
    };
    const cache = new Map<string, Awaited<ReturnType<typeof run>>>();
    const once = async (key: string, options: Record<string, unknown>) => { if (!cache.has(key)) cache.set(key, await run(options)); return cache.get(key)!; };
    for (const arm of arms) {
      const file = join(runDir!, `${arm}--${item.id}.json`);
      if (existsSync(file)) { rows.push(readJson(file)); continue; }
      let results: Result[] | null = null, mapped: Result[] | null = null, ms = 0, context: string | null = null, skipped: string | undefined, trace: Record<string, unknown> | undefined;
      if (arm === "current") ({ results, ms } = await once("current", {}));
      else if (arm === "current-default") ({ results, ms } = await run({}, true));
      else if (arm === "summary-seed") ({ results, ms } = await once("seed", { summarySeed: true }));
      else if (arm === "document-order") {
        const base = await once("current", {});
        results = [...base.results].sort((a, b) => a.citation.documentId.localeCompare(b.citation.documentId) || (a.citation.chunkIndex ?? 0) - (b.citation.chunkIndex ?? 0));
        ms = base.ms;
      } else if (arm === "product-guide" || arm === "product-include") {
        const actual = await run({ summaryTree: arm === "product-guide" ? "guide" : "include" });
        results = actual.results;
        ms = actual.ms;
        trace = { outcome: actual.outcome, timings: actual.timings, summaries: actual.summaries };
        // Product include carries summaries separately; strict retrieval still scores its real cited chunks.
        // Mapped evidence is an additional diagnostic, never substituted into the strict component.
        if (arm === "product-include") mapped = [...results, ...actual.summaries.map(summary => {
          const chunks = document(summary.documentId).chunks.filter(chunk => chunk.index >= summary.chunkStart && chunk.index <= summary.chunkEnd);
          return { kind: "summary" as const, text: chunks.map(chunk => chunk.text).join("\n\n"),
            citation: { documentId: summary.documentId, pageNumber: summary.pageStart, pageNumbers: [...new Set(chunks.flatMap(chunk => chunk.pageNumbers))] } };
        })];
      } else if (arm === "tree-guide" || arm === "tree-include") {
        const started = performance.now();
        const leg = await once("deep", { limit: TREE_RULE.chunkLegDepth, candidateDepth: TREE_RULE.chunkLegDepth });
        const hits = summaryHits(nodes, queryVector);
        const key = (documentId: string, chunkIndex: number) => `${documentId}\u0000${String(chunkIndex).padStart(6, "0")}`;
        const guided = hits.flatMap((node) => document(node.documentId).chunks
          .filter((chunk) => chunk.index >= node.chunkStart && chunk.index <= node.chunkEnd)
          .map((chunk) => ({ chunk, similarity: cosine(queryVector, chunk.vector) })).sort((a, b) => b.similarity - a.similarity)
          .slice(0, TREE_RULE.chunksPerHit).map(({ chunk }) => key(node.documentId, chunk.index)));
        // The chunk leg keeps the product's own top-K order (the `current` arm) and continues with the deeper fetch,
        // so a tree arm differs from `current` only by what the summary leg adds. A deeper fetch alone reorders the top.
        const top = await once("current", {});
        const legByKey = new Map([...top.results, ...leg.results].map((result) => [key(result.citation.documentId, result.citation.chunkIndex ?? -1), result] as const).filter(([, ], i, all) => all.findIndex(([other]) => other === all[i]![0]) === i));
        const fused = rrf([[...legByKey.keys()], [...new Set(guided)]], TREE_RULE.rrfK);
        const asResult = (fusedKey: string): Result => {
          const fromLeg = legByKey.get(fusedKey);
          if (fromLeg) return { ...fromLeg, kind: "chunk" };
          const [documentId, index] = fusedKey.split("\u0000");
          return chunkResult(documentId!, document(documentId!).chunks.find((chunk) => chunk.index === Number(index))!);
        };
        const readable = (fusedKey: string) => fusedKey.replace("\u0000", "#").replace(/#0+(\d)/, "#$1");
        trace = { chunkLeg: [...legByKey.keys()].slice(0, 2 * K).map(readable), guided: [...new Set(guided)].map(readable), summaryHits: hits.map((node) => ({ id: node.id.slice(0, 12), document: node.documentId, level: node.level, chunkStart: node.chunkStart, chunkEnd: node.chunkEnd })) };
        if (arm === "tree-guide") results = fused.slice(0, K).map(asResult);
        else {
          const summaries = hits.slice(0, TREE_RULE.includeSummarySlots);
          const chunksOnly = fused.slice(0, K - summaries.length).map(asResult);
          const summaryResults = summaries.map<Result>((node) => ({ kind: "summary", text: node.text, citation: { documentId: node.documentId, pageNumber: node.pageStart, pageNumbers: [] }, summary: { id: node.id, level: node.level, chunkStart: node.chunkStart, chunkEnd: node.chunkEnd } }));
          results = [...chunksOnly, ...summaryResults];
          mapped = [...chunksOnly, ...summaries.map(mappedLeaves)];
        }
        ms = top.ms + leg.ms + (performance.now() - started);
      } else if (arm === "long-context") {
        const texts = [...new Set(item.premises.map((premise) => premise.documentId))].map((id) => `# ${document(id).title}\n\n${document(id).text.replaceAll("\f", "\n")}`);
        if (texts.join("").length > LONG_CONTEXT_MAX_CHARS) skipped = "does-not-fit";
        else context = texts.join("\n\n");
      }
      // The strict component reads returned text only; a summary cannot contain the gold quote and is never rewritten to.
      const retrieval = results ? score(item, results.map((result) => result.kind === "summary" ? { ...result, text: "" } : result), K) : null;
      const mappedRetrieval = mapped ? score(item, mapped, arm === "product-include" ? mapped.length : K) : null;
      let answer: Record<string, unknown> | null = null;
      if (answers && !skipped) {
        const prompt = arm === "closed-book" ? `Question: ${item.question}` : `Context:\n${context ?? contextBlock(results!)}\n\nQuestion: ${item.question}`;
        const system = arm === "closed-book" ? "Answer the question briefly (at most four sentences) from your own knowledge." : READER_SYSTEM;
        const reply = await generateWithRefusalFallback(`arms:reader:${arm}`, system, prompt, READER_TOKENS);
        const checked = scoreCase({ id: item.id, requiredPatterns: item.requiredPatterns }, { answer: reply.text, citations: [] }, {});
        answer = { text: reply.text, finishReason: reply.finishReason, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, ms: reply.ms, model: reply.model, refused: reply.refused, answerCheck: checked.checks.answer };
      }
      const row = { id: item.id, arm, split, class: item.class, slice: item.slice, searchMs: Math.round(ms), skipped, retrieval, mappedRetrieval, answer, trace,
        results: results?.map((result) => ({ kind: result.kind ?? "chunk", citation: result.citation, summary: result.summary, text: result.text })) };
      writeFileSync(file, JSON.stringify(row, null, 2), { flag: "wx" });
      rows.push(row);
      console.log(arm, item.id, retrieval ? (retrieval as { correct: boolean }).correct : "-", answer ? answer.answerCheck : "-");
    }
    await session.drainSearchSessionWrites();
  }
  await sql.end({ timeout: 5 });
  process.exit(0);
}
