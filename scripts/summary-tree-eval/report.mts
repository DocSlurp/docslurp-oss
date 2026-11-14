/**
 * Aggregate a run directory written by arms.mts. No scoring happens here: the
 * rows already carry the outputs of the existing scorers; this only counts.
 *
 *   tsx scripts/summary-tree-eval/report.mts RUN_DIR SUMMARY.json
 *
 * Components, each 0-100 over the cases of a cell (a failed or missing output
 * counts as 0, never dropped from the denominator):
 *   support@10       every premise's quote, document and page in one result within 10 (`correct`)
 *   premise coverage share of premises found within 10
 *   reciprocal rank  mean of the joint reciprocal rank
 *   primary page     `primaryPageCorrect`
 *   answer check     the deterministic `answer` check on the reader's answer
 * For `tree-include` the three retrieval components are also given on mapped
 * leaves (a summary result stands for the chunks under it). The composite is
 * the mean of support@10, premise coverage, reciprocal rank and answer check;
 * for `tree-include` it uses the mapped retrieval components. Read the
 * components first.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readJson } from "./lib.mts";

type Scored = { correct: boolean; primaryPageCorrect: boolean; reciprocalRank: number; premises: Array<{ rank: number | null }> };
type Row = { id: string; arm: string; class: string; slice: string; searchMs: number; skipped?: string; retrieval: Scored | null; mappedRetrieval: Scored | null;
  answer: { answerCheck: boolean; inputTokens: number; outputTokens: number; ms: number } | null };

const mean = (values: number[]) => values.length ? Math.round((1000 * values.reduce((a, b) => a + b, 0)) / values.length) / 10 : null;
const retrievalParts = (scored: Scored | null) => scored ? {
  support: scored.correct ? 1 : 0, coverage: scored.premises.filter((premise) => premise.rank !== null).length / scored.premises.length,
  reciprocalRank: scored.reciprocalRank, primaryPage: scored.primaryPageCorrect ? 1 : 0 } : null;

export function aggregate(rows: Row[]) {
  const cell = (subset: Row[]) => {
    const measured = subset.filter((row) => !row.skipped);
    const strict = measured.map((row) => retrievalParts(row.retrieval));
    const mapped = measured.map((row) => retrievalParts(row.mappedRetrieval));
    const hasRetrieval = strict.some(Boolean), hasMapped = mapped.some(Boolean), hasAnswer = measured.some((row) => row.answer);
    const pick = (parts: Array<ReturnType<typeof retrievalParts>>, key: "support" | "coverage" | "reciprocalRank" | "primaryPage") => mean(parts.map((part) => part?.[key] ?? 0));
    const answer = hasAnswer ? mean(measured.map((row) => row.answer?.answerCheck ? 1 : 0)) : null;
    const basis = hasMapped ? mapped : strict;
    const compositeParts = [hasRetrieval ? pick(basis, "support") : null, hasRetrieval ? pick(basis, "coverage") : null, hasRetrieval ? pick(basis, "reciprocalRank") : null, answer].filter((value): value is number => value !== null);
    return {
      n: subset.length, measured: measured.length, skipped: subset.length - measured.length,
      supportAt10: hasRetrieval ? pick(strict, "support") : null, premiseCoverage: hasRetrieval ? pick(strict, "coverage") : null,
      reciprocalRank: hasRetrieval ? pick(strict, "reciprocalRank") : null, primaryPage: hasRetrieval ? pick(strict, "primaryPage") : null,
      mappedSupportAt10: hasMapped ? pick(mapped, "support") : null, mappedPremiseCoverage: hasMapped ? pick(mapped, "coverage") : null, mappedReciprocalRank: hasMapped ? pick(mapped, "reciprocalRank") : null,
      answerCheck: answer, composite: compositeParts.length ? Math.round((10 * compositeParts.reduce((a, b) => a + b, 0)) / compositeParts.length) / 10 : null,
      compositeOf: [...(hasRetrieval ? [hasMapped ? "mapped support@10, mapped premise coverage, mapped reciprocal rank" : "support@10, premise coverage, reciprocal rank"] : []), ...(answer !== null ? ["answer check"] : [])].join(", "),
      readerInputTokens: measured.reduce((sum, row) => sum + (row.answer?.inputTokens ?? 0), 0), readerOutputTokens: measured.reduce((sum, row) => sum + (row.answer?.outputTokens ?? 0), 0),
      medianSearchMs: measured.length ? [...measured.map((row) => row.searchMs)].sort((a, b) => a - b)[Math.floor(measured.length / 2)]! : null,
    };
  };
  const arms = [...new Set(rows.map((row) => row.arm))];
  const groups: Record<string, (row: Row) => boolean> = {
    all: () => true, fact: (row) => row.class === "fact", "multi-section": (row) => row.class === "multi-section", "whole-document": (row) => row.class === "whole-document",
    broad: (row) => row.class !== "fact", headed: (row) => row.slice === "headed", "heading-less": (row) => row.slice === "heading-less",
    "broad, heading-less": (row) => row.class !== "fact" && row.slice === "heading-less", "broad, headed": (row) => row.class !== "fact" && row.slice === "headed",
  };
  return Object.fromEntries(arms.map((arm) => [arm, Object.fromEntries(Object.entries(groups).map(([name, test]) => [name, cell(rows.filter((row) => row.arm === arm && test(row)))]))]));
}

if (process.argv[1]?.endsWith("report.mts")) {
  const [runDir, output] = process.argv.slice(2);
  const rows = readdirSync(runDir!).filter((name) => name.includes("--") && name.endsWith(".json")).map((name) => readJson<Row>(join(runDir!, name)));
  const summary = aggregate(rows);
  writeFileSync(output!, JSON.stringify({ cases: new Set(rows.map((row) => row.id)).size, rows: rows.length, summary }, null, 2) + "\n");
  const show = (value: number | null) => value === null ? "n/a" : value.toFixed(1);
  for (const group of ["fact", "multi-section", "whole-document", "broad", "broad, headed", "broad, heading-less", "all"]) {
    console.log(`\n### ${group}\n\n| Arm | n | support@10 | premise coverage | reciprocal rank | primary page | mapped support@10 | mapped coverage | answer check | composite |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
    for (const [arm, cells] of Object.entries(summary)) {
      const c = (cells as Record<string, ReturnType<typeof aggregate>[string][string]>)[group]!;
      console.log(`| ${arm} | ${c.measured}${c.skipped ? ` (+${c.skipped} skipped)` : ""} | ${show(c.supportAt10)} | ${show(c.premiseCoverage)} | ${show(c.reciprocalRank)} | ${show(c.primaryPage)} | ${show(c.mappedSupportAt10)} | ${show(c.mappedPremiseCoverage)} | ${show(c.answerCheck)} | ${show(c.composite)} |`);
    }
  }
}
