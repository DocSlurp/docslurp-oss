/**
 * Validate authored cases against the frozen sources and write the scored-case
 * file the existing retrieval scorer (scripts/retrieval-quality/eval.mjs
 * `score`) reads.
 *
 *   tsx scripts/summary-tree-eval/cases.mts build AUTHORED MANIFEST OUTPUT [--sealed]
 *   tsx scripts/summary-tree-eval/cases.mts probe MANIFEST DOC "quote" ["quote" ...]
 *
 * An authored case names, per premise, a source id and quotes. The builder
 * requires every quote to occur in the prepared source on a page, and inside
 * at least one chunk of the frozen chunk artifact (so a quote split by a chunk
 * boundary is an authoring error, not a retrieval miss). A missing label
 * fails the build. Existing output is never overwritten.
 *
 * `--sealed` is for the confirmation set: OUTPUT must be outside any git
 * work tree, and only its hash and counts are printed for the manifest kept in
 * the repository. Development tooling never reads a sealed file: `loadCases`
 * refuses any file whose split is not "development" unless the caller passes
 * the explicit confirmation flag.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { normalize } from "../retrieval-quality/eval.mjs";
import { loadDocument, loadManifest, readJson, sha, sourceText } from "./lib.mts";

export type QuestionClass = "fact" | "multi-section" | "whole-document";
export type AuthoredCase = { id: string; class: QuestionClass; question: string; expectedAnswer: string; requiredPatterns: string[]; premises: Array<{ doc: string; quotes: string[] }> };
export type EvalCase = {
  id: string; version: number; split: "development" | "confirmation"; kind: "explicit"; class: QuestionClass; slice: "headed" | "heading-less";
  question: string; expectedAnswer: string; requiredPatterns: string[];
  premises: Array<{ documentId: string; pages: number[]; quotes: string[] }>;
  provenance: Array<{ sourceId: string; url: string; licence: string; preparedSha256: string }>;
};

/** A document is in the heading-less slice when one heading path holds most of its chunks. */
export function sliceOf(documentId: string): "headed" | "heading-less" {
  const chunks = loadDocument(documentId).chunks;
  const counts = new Map<string, number>();
  for (const chunk of chunks) counts.set(chunk.headingPath.join("\u0000"), (counts.get(chunk.headingPath.join("\u0000")) ?? 0) + 1);
  return Math.max(...counts.values()) / chunks.length > 0.5 ? "heading-less" : "headed";
}

export function locate(documentId: string, quote: string): { pages: number[]; inChunk: boolean } {
  const wanted = normalize(quote);
  const pages = sourceText(documentId).split("\f").flatMap((page, i) => normalize(page).includes(wanted) ? [i + 1] : []);
  return { pages, inChunk: loadDocument(documentId).chunks.some((chunk) => normalize(chunk.rawText).includes(wanted)) };
}

export function loadCases(path: string, options: { confirmation?: boolean } = {}): { split: string; cases: EvalCase[] } {
  const data = readJson<{ split: string; cases: EvalCase[] }>(path);
  if (data.split !== "development" && !options.confirmation) throw new Error("Refusing to read a non-development case file without the explicit confirmation flag");
  return data;
}

if (process.argv[1]?.endsWith("cases.mts")) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "probe") {
    const [, doc, ...quotes] = args;
    for (const quote of quotes) console.log(JSON.stringify(locate(doc!, quote)), quote);
  } else if (command === "build") {
    const [authoredPath, manifestPath, output, flag] = args;
    const sealed = flag === "--sealed";
    if (sealed) {
      let inGit = true;
      try { execFileSync("git", ["-C", dirname(resolve(output!)), "rev-parse", "--is-inside-work-tree"], { stdio: "pipe" }); } catch { inGit = false; }
      if (inGit) throw new Error("A sealed case file must live outside every git work tree");
    }
    const sources = new Map(loadManifest(manifestPath!).sources.map((source) => [source.id, source]));
    const authored = readJson<{ cases: AuthoredCase[] }>(authoredPath!);
    const problems: string[] = [];
    const cases = authored.cases.map<EvalCase>((item) => {
      for (const pattern of item.requiredPatterns) new RegExp(pattern, "i");
      if (!item.requiredPatterns.length) problems.push(`${item.id}: no answer pattern`);
      const premises = item.premises.map((premise) => {
        const pages = new Set<number>();
        for (const quote of premise.quotes) {
          const found = locate(premise.doc, quote);
          if (found.pages.length === 0) problems.push(`${item.id}: quote not in ${premise.doc}: ${quote}`);
          else if (found.pages.length > 1) problems.push(`${item.id}: quote on ${found.pages.length} pages of ${premise.doc} (must be unique): ${quote}`);
          else if (!found.inChunk) problems.push(`${item.id}: quote straddles a chunk boundary in ${premise.doc}: ${quote}`);
          found.pages.forEach((page) => pages.add(page));
        }
        if (premise.quotes.length > 1 && pages.size > 1) problems.push(`${item.id}: quotes of one premise are on different pages`);
        return { documentId: premise.doc, pages: [...pages], quotes: premise.quotes };
      });
      const documents = [...new Set(item.premises.map((premise) => premise.doc))];
      return {
        id: item.id, version: 1, split: sealed ? "confirmation" : "development", kind: "explicit", class: item.class,
        slice: documents.every((id) => sliceOf(id) === "heading-less") ? "heading-less" : "headed",
        question: item.question, expectedAnswer: item.expectedAnswer, requiredPatterns: item.requiredPatterns, premises,
        provenance: documents.map((id) => { const source = sources.get(id)!; return { sourceId: id, url: source.url, licence: source.licence, preparedSha256: source.preparedSha256! }; }),
      };
    });
    if (new Set(cases.map((item) => item.id)).size !== cases.length) problems.push("duplicate case id");
    if (problems.length) throw new Error(`Case build failed:\n${problems.join("\n")}`);
    const body = JSON.stringify({ version: 1, split: sealed ? "confirmation" : "development", authoredSha256: sha(readFileSync(authoredPath!)), cases }, null, 2) + "\n";
    writeFileSync(output!, body, { flag: "wx" });
    const count = (key: "class" | "slice") => Object.fromEntries([...new Set(cases.map((item) => item[key]))].map((value) => [value, cases.filter((item) => item[key] === value).length]));
    console.log(JSON.stringify({ split: sealed ? "confirmation" : "development", sha256: sha(body), cases: cases.length, byClass: count("class"), bySlice: count("slice"), documents: [...new Set(cases.flatMap((item) => item.premises.map((premise) => premise.documentId)))].sort() }, null, 2));
  } else throw new Error("Usage: cases.mts build AUTHORED MANIFEST OUTPUT [--sealed] | probe MANIFEST DOC QUOTE...");
  process.exit(0);
}
