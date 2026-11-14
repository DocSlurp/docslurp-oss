import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(async () => []), { array: vi.fn(), json: vi.fn() }) }));

const { annotateEvidenceRelevance, contentTerms, lexicalRelevance, phraseRelevance, queryPhraseWindows, termCoverage, LEXICAL_MIN_COVERAGE } =
  await import("../search/relevance.js");
const { foldText, hasCjk } = await import("../search/text-fold.js");
import type { SearchChunk } from "../services/search.js";

/*
 * REFERENCE ORACLE. These are verbatim copies of the pre-optimization implementations (split into a word Set,
 * sharesRoot across every word, terms and windows re-derived on each call). They must never be "fixed" or
 * optimized: the optimized module has to return exactly the same numbers.
 */
const INFLECTION = /^(?:s|e|es|ed|d|ing|ings|er|ers|ation|ations|ion|ions|ive|ly|y|ies|al|ment|ments)?$/;
function refFold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC");
}
function refStem(term: string): string {
  if (term.length <= 4) return term;
  const stripped = term.replace(/(ations?|ings?|edly|ies|es|ed|s|ly)$/, "");
  return stripped.length >= 3 ? stripped : term;
}
function refSharesRoot(word: string, root: string): boolean {
  if (word === root) return true;
  if (!word.startsWith(root)) return false;
  const rest = word.slice(root.length);
  return INFLECTION.test(rest) || (rest[0] === root.at(-1) && INFLECTION.test(rest.slice(1)));
}
function refTermCoverage(query: string, text: string): number {
  const terms = contentTerms(query);
  if (terms.length === 0) return 0;
  const folded = refFold(text);
  const words = new Set(folded.split(/[^\p{L}\p{N}\p{M}-]+/u).filter(Boolean));
  const matched = terms.filter((term) => {
    if (hasCjk(term)) return folded.includes(term);
    if (!/^[a-z]+$/.test(term)) return words.has(term);
    const root = refStem(term);
    for (const word of words) if (refSharesRoot(word, root)) return true;
    return false;
  });
  return matched.length / terms.length;
}
function refLexicalRelevance(query: string, text: string): number {
  const coverage = refTermCoverage(query, text);
  return coverage > 0.5 ? coverage : 0;
}
function refPhraseRelevance(query: string, text: string): number {
  for (const window of queryPhraseWindows(query)) {
    if (contentTerms(window).length >= 2 && refTermCoverage(window, text) === 1) return 1;
  }
  return refLexicalRelevance(query, text);
}

let seed = 987654321;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;

const WORDS = [
  "tax", "taxes", "taxed", "taxation", "taxi", "run", "running", "runner", "policy", "policies", "refund", "refunds", "refunded",
  "enterprise", "invoice", "invoices", "class", "classes", "class-action", "state-of-the-art", "2024", "12", "3.5", "x", "a", "the",
  "of", "and", "not", "no", "never", "allowed", "allow", "allowing", "stopped", "stop", "stopping", "payment", "payments", "payment-terms",
  "Müller", "muller", "Gebühren", "gebuhren", "café", "cafe", "naïve", "résumé", "Straße", "ΣΊΣΥΦΟΣ", "İstanbul", "налог", "налоговая",
  "декларация", "東京", "日本の首都", "税金", "こんにちは", "한국어", "😀", "𝒳tax", "tax𝒳", "́", "é", "ﬁnance", "ǅ", "-", "--", "a-", "-b",
];
const SEPARATORS = [" ", "  ", "\n", "\t", ", ", ". ", " | ", " - ", "; ", "/", "(", ")", "_", "·", " ", "​", "—"];

function randomText(): string {
  const length = pick([0, 1, 2, 3, 5, 8, 20, 60, 200, 800]);
  let out = "";
  for (let i = 0; i < length; i += 1) out += (rnd() < 0.08 ? pick(["", "S", "ing", "ES"]) : "") + pick(WORDS) + pick(SEPARATORS);
  return rnd() < 0.2 ? out.trim() : out;
}
function randomQuery(): string {
  const length = pick([0, 1, 1, 2, 3, 3, 4, 6, 8, 12, 40]);
  const parts: string[] = [];
  for (let i = 0; i < length; i += 1) parts.push(pick(WORDS));
  return parts.join(pick([" ", " ", ", ", "  ", "\n"])) + pick(["", "", "?", "!", " ..."]);
}

const FIXED_QUERIES = [
  "", "   ", "the of and", "a", "tax", "taxes", "tax clauses", "refund policy enterprise", "how do I reset my password",
  "zxqvbn nonsense gibberish", "refunds not allowed", "Muller Gebuhren", "налоговая декларация", "東京 首都", "日本の首都", "???", "---",
  "tax tax tax", "Tax TAX tax", "class action settlement", "state-of-the-art", "x", "run running ran",
];
const FIXED_TEXTS = [
  "", " ", "...", "---", "-", "The taxation clause applies.", "To reset a password, open settings.", "A nonsense clause about taxes.",
  "Die Müller Gebühren steigen", "Налоговая декларация подана", "東京は日本の首都です", "今日の天気は晴れ", "The taxi arrives at nine", "running costs",
  "refunds allowed", "tax", "taxx", "taxxing", "tax-free", "pretax", "TAX", "Tax́", "a".repeat(100_000), `${"word ".repeat(40_000)}tax`,
  "😀tax", "tax😀", "\ud83dtax", "tax\ude00", "\ud83d", "\ude00x",
];

describe("relevance equivalence against the pre-optimization reference", () => {
  it("returns identical termCoverage / lexicalRelevance / phraseRelevance on fixed adversarial inputs", () => {
    let comparisons = 0;
    for (const query of FIXED_QUERIES) for (const text of FIXED_TEXTS) {
      expect(termCoverage(query, text), `coverage ${JSON.stringify(query)}`).toBe(refTermCoverage(query, text));
      expect(lexicalRelevance(query, text), `lexical ${JSON.stringify(query)}`).toBe(refLexicalRelevance(query, text));
      expect(phraseRelevance(query, text), `phrase ${JSON.stringify(query)}`).toBe(refPhraseRelevance(query, text));
      comparisons += 3;
    }
    expect(comparisons).toBeGreaterThan(1500);
  });

  it("returns identical scores on 20,000 randomized query/text pairs, repeated so cached queries are exercised", () => {
    const queries = Array.from({ length: 400 }, randomQuery);
    for (let i = 0; i < 20_000; i += 1) {
      const query = queries[i % queries.length]!;
      const text = randomText();
      const expectedCoverage = refTermCoverage(query, text);
      expect(termCoverage(query, text), JSON.stringify([query, text])).toBe(expectedCoverage);
      expect(lexicalRelevance(query, text), JSON.stringify([query, text])).toBe(refLexicalRelevance(query, text));
      expect(phraseRelevance(query, text), JSON.stringify([query, text])).toBe(refPhraseRelevance(query, text));
    }
  }, 120_000);

  it("returns identical scores for queries drawn from the text itself (high coverage cases)", () => {
    for (let i = 0; i < 4_000; i += 1) {
      const text = randomText();
      const words = text.split(/\s+/).filter(Boolean);
      const query = Array.from({ length: pick([1, 2, 3, 4, 6]) }, () => (words.length ? pick(words) : "tax")).join(" ");
      expect(termCoverage(query, text)).toBe(refTermCoverage(query, text));
      expect(lexicalRelevance(query, text)).toBe(refLexicalRelevance(query, text));
      expect(phraseRelevance(query, text)).toBe(refPhraseRelevance(query, text));
    }
  });

  it("honours the strict-majority boundary exactly", () => {
    expect(LEXICAL_MIN_COVERAGE).toBe(0.5);
    // 1 of 2 terms is exactly 0.5, which is not a majority; 2 of 3 is.
    expect(lexicalRelevance("refund policy", "refund only")).toBe(refLexicalRelevance("refund policy", "refund only"));
    expect(lexicalRelevance("refund policy", "refund only")).toBe(0);
    expect(lexicalRelevance("refund policy enterprise", "refund policy only")).toBe(2 / 3);
  });

  it("foldText equals the reference fold on ASCII and non-ASCII inputs", () => {
    for (let i = 0; i < 5_000; i += 1) {
      const text = randomText();
      expect(foldText(text)).toBe(refFold(text));
    }
    for (let code = 0; code < 0x250; code += 1) expect(foldText(String.fromCharCode(code))).toBe(refFold(String.fromCharCode(code)));
  });

  it("annotateEvidenceRelevance scores equal the reference for every adapter, including a repeated pass over the same chunks", () => {
    const chunk = (id: string, overrides: Partial<SearchChunk>): SearchChunk => ({
      id, documentId: `d-${id}`, runId: "r", chunkIndex: 0, text: "", headingPath: [], pageNumber: 1, tokenEstimate: 1, score: 1,
      filename: `${id}.pdf`, pageNumbers: [1], blockIds: [], blockTypes: [], evidenceType: null, canonicalDocumentUri: null,
      tableGranularity: null, tableRowIndex: null, tableRowCount: null, tableColumnNames: [], tableColumnTypes: [], tableCells: [],
      tableCell: null, regionBoxes: [], regions: [], regionCoordinateSpace: null, sourceTrace: null, source: "document",
      retrievalStage: "full-index", ...overrides,
    } as SearchChunk);
    const query = "refund policy for enterprise customers";
    const chunks: SearchChunk[] = [];
    for (let i = 0; i < 300; i += 1) {
      chunks.push(chunk(`c${i}`, {
        text: randomText() + (i % 3 === 0 ? " refund policy enterprise customers" : i % 3 === 1 ? " Refunds for the policy" : ""),
        headingPath: i % 4 === 0 ? [] : ["Section", pick(WORDS)],
        filename: pick(["a.pdf", "refund.pdf", "政策.pdf"]),
        lexicalMatch: pick(["partial", "phrase", undefined] as const),
        queryRelevance: i % 17 === 0 ? 0.25 : undefined,
      }));
    }
    const expected = (c: SearchChunk): number => {
      if (c.queryRelevance !== undefined) return c.queryRelevance;
      if (c.lexicalMatch === undefined) return 1;
      const haystack = [c.text, c.headingPath.join(" "), c.filename].join("\n");
      return c.lexicalMatch === "phrase" ? refPhraseRelevance(query, haystack) : refLexicalRelevance(query, haystack);
    };
    const results = [{ adapter: "keyword", chunks }, { adapter: "vector", chunks }, { adapter: "graph", chunks: chunks.slice(0, 5) }] as never[];
    for (let pass = 0; pass < 3; pass += 1) {
      const lists = annotateEvidenceRelevance(results, { query, embeddingPipeline: null });
      for (const list of lists) for (const annotated of list) {
        const source = chunks.find((c) => c.id === annotated.id)!;
        const adapterIsLexical = annotated.relevance !== 1 || source.lexicalMatch !== undefined || source.queryRelevance !== undefined;
        if (adapterIsLexical && (source.queryRelevance !== undefined || source.lexicalMatch !== undefined)) {
          // Lists for the vector/graph adapters score 1 regardless; lexical lists must match the reference.
          expect([1, expected(source)]).toContain(annotated.relevance);
        }
      }
      const keyword = lists.find((l) => l.length === chunks.length && l.every((c, i) => c.id === chunks[i]!.id));
      void keyword;
    }
    // Direct, unambiguous check on a lexical-only call, then again after mutating a chunk (memo must not go stale).
    const lexicalOnly = [{ adapter: "keyword", chunks }] as never[];
    const first = annotateEvidenceRelevance(lexicalOnly, { query }).flat();
    for (const c of first) expect(c.relevance).toBe(expected(chunks.find((s) => s.id === c.id)!));
    const again = annotateEvidenceRelevance(lexicalOnly, { query }).flat();
    for (const c of again) expect(c.relevance).toBe(expected(chunks.find((s) => s.id === c.id)!));
    for (const c of chunks) c.text = `${c.text} enterprise customers refund policy`;
    chunks[1]!.headingPath = ["changed"];
    const mutated = annotateEvidenceRelevance(lexicalOnly, { query }).flat();
    for (const c of mutated) expect(c.relevance).toBe(expected(chunks.find((s) => s.id === c.id)!));
    // A different query on the same chunk objects must not reuse the previous query's score.
    const other = "zxqvbn nonsense gibberish";
    const otherScores = annotateEvidenceRelevance(lexicalOnly, { query: other }).flat();
    for (const c of otherScores) {
      const source = chunks.find((s) => s.id === c.id)!;
      if (source.queryRelevance !== undefined || source.lexicalMatch === undefined) continue;
      const haystack = [source.text, source.headingPath.join(" "), source.filename].join("\n");
      expect(c.relevance).toBe(source.lexicalMatch === "phrase" ? refPhraseRelevance(other, haystack) : refLexicalRelevance(other, haystack));
    }
  });

  it("copes with more distinct queries than the prepared-query cache holds", () => {
    for (let i = 0; i < 300; i += 1) {
      const query = `refund policy term${i} enterprise`;
      expect(lexicalRelevance(query, "refund policy for enterprise")).toBe(refLexicalRelevance(query, "refund policy for enterprise"));
    }
    const long = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
    expect(termCoverage(long, "word1 word2")).toBe(refTermCoverage(long, "word1 word2"));
  });
});
