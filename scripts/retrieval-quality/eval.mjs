import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
export const normalize = text => String(text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export const hash = data => createHash("sha256").update(data).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
export function score(test, results, k = 10) {
  if (!Number.isInteger(k) || k < 1) throw new Error("k must be positive integer");
  if (test.kind === "unanswerable") return { id: test.id, status: "requires_answer_abstention_review", retrievalHits: results.slice(0, k).length };
  if (!test.premises?.length) throw new Error("Missing premises");
  const premises = test.premises.map(p => {
    if (!p.quotes?.length || p.quotes.some(q => !normalize(q)) || !p.pages?.length || !p.documentId) throw new Error("Incomplete premise provenance");
    const matches = results.slice(0, k).map((r, i) => {
      const text = p.quotes.every(q => normalize(r.text).includes(normalize(q)));
      const document = r.citation?.documentId === p.documentId;
      const pages = [r.citation?.pageNumber, ...(r.citation?.pageNumbers ?? [])];
      return { rank: i + 1, text, document, page: p.pages.some(p => pages.includes(p)), primaryPage: p.pages.includes(r.citation?.pageNumber), sourceTracePage: p.pages.some(p => (r.citation?.sourceTrace?.pageNumbers ?? []).includes(p)) };
    });
    const hit = matches.find(m => m.text && m.document && m.page);
    return { rank: hit?.rank ?? null, primaryPageRank: matches.find(m => m.text && m.document && m.primaryPage)?.rank ?? null, sourceTracePageRank: matches.find(m => m.text && m.document && m.sourceTracePage)?.rank ?? null, expandedPageUnionRank: hit?.rank ?? null, textWithInvalidCitation: matches.filter(m => m.text && !(m.document && m.page)).map(m => m.rank), citedPageWithoutText: matches.filter(m => m.document && m.page && !m.text).map(m => m.rank) };
  });
  const correct = premises.every(p => p.rank !== null);
  return { id: test.id, citationMetric: "expanded_page_union_with_matching_chunk_text", correct, primaryPageCorrect: premises.every(p => p.primaryPageRank !== null), sourceTracePageCorrect: premises.every(p => p.sourceTracePageRank !== null), reciprocalRank: correct ? 1 / Math.max(...premises.map(p => p.rank)) : 0, premises, diagnosis: correct ? "support_retrieved" : premises.some(p => p.textWithInvalidCitation.length) ? "citation_metadata" : "unresolved_extraction_chunking_or_ranking" };
}
// Build only from explicitly supplied development inputs. Never discover held-out files.
export function build(manifestPath, queriesPath, runDirs, output) {
  const manifest = json(manifestPath), queries = json(queriesPath);
  mkdirSync(output, { recursive: true });
  const cases = [], sources = new Map();
  for (const dir of runDirs) {
    const state = json(join(dir, "state.json"));
    const rows = readFileSync(join(dir, "quality.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const source = manifest.documents.find(d => d.id === state.fileId);
    if (!source) throw new Error("Run source missing from manifest");
    if (!sources.has(source.id)) {
      if (hash(readFileSync(source.local_path)) !== source.sha256) throw new Error("Source PDF hash mismatch");
      sources.set(source.id, readFileSync(source.full_text_file, "utf8").split("\f"));
    }
    for (const row of rows) {
      const q = queries.queries.find(q => q.id === row.query && q.document === source.id);
      if (!q) throw new Error("Query missing from development inputs");
      const pages = q.support_pages.map(page => {
        const text = sources.get(source.id)[page - 1];
        if (text === undefined || !q.support_match_all.every(quote => normalize(text).includes(normalize(quote)))) throw new Error(`Source oracle mismatch: ${q.id} page ${page}`);
        return { page, sha256: hash(text), text };
      });
      cases.push({ id: q.id, version: 1, split: "development", kind: "explicit", question: q.question, expectedAnswer: q.expected_answer,
        premises: [{ documentId: state.documentId, pages: q.support_pages, quotes: q.support_match_all }],
        provenance: { sourceId: source.id, url: source.url, pdfSha256: source.sha256, extraction: source.text_extraction, pages },
        original: { query: q, quality: row, qualitySha256: hash(readFileSync(join(dir, "quality.jsonl"))), rawTrace: null, limitation: "Original harness retained summary only; replay is a new observation." },
        retrieval: { workspaceId: state.workspaceId, documentId: state.documentId, embedding: state.embedding, flags: row.flags, limit: 10 },
        diagnosis: row.correct ? "historical_support_retrieved" : "unresolved_extraction_chunking_or_ranking" });
    }
  }
  write(join(output, "development-v1.json"), { version: 1, inputHashes: { manifest: hash(readFileSync(manifestPath)), queries: hash(readFileSync(queriesPath)) }, cases });
  return cases.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build") { const [manifest, queries, output, ...runs] = args; console.log(build(manifest, queries, runs, output)); }
  else if (command === "score") { const [dataset, traces] = args; const records = json(traces); console.log(JSON.stringify(json(dataset).cases.map(test => { const trace = records.find(r => r.id === test.id); return trace ? score(test, trace.results) : { id: test.id, status: "not_measured" }; }), null, 2)); }
  else throw new Error("Usage: eval.mjs build MANIFEST QUERIES OUTPUT RUN... | score DATASET TRACES");
}
