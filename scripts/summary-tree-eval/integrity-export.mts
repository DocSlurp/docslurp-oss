/**
 * Export case files as the external dataset scripts/evaluation-integrity-judge.mjs
 * reads (schema docslurp-authored-eval@v1), so the leakage gate can check that
 * no source name, question, quote or expected answer was copied into product
 * or harness code.
 *
 *   tsx scripts/summary-tree-eval/integrity-export.mts DATASET_DIR AUTHOR CASES [CASES ...] [--confirmation]
 *   node scripts/evaluation-integrity-judge.mjs --dataset DATASET_DIR --repo . --base origin/main --output REPORT.json
 *
 * DATASET_DIR must be outside the repository. `--confirmation` is required to
 * include a sealed file; the export is a gate input, never a tuning input.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadCases } from "./cases.mts";
import { ROOT, sha } from "./lib.mts";

const args = process.argv.slice(2);
const confirmation = args.includes("--confirmation");
const [dataset, author, ...files] = args.filter((arg) => arg !== "--confirmation");
if (!dataset || !author || !files.length) throw new Error("Usage: integrity-export.mts DATASET_DIR AUTHOR CASES [CASES ...] [--confirmation]");
mkdirSync(join(dataset, "sources"), { recursive: true });
mkdirSync(join(dataset, "labels"), { recursive: true });
const cases = files.flatMap((file) => loadCases(file, { confirmation }).cases);
const manifest = {
  schema: "docslurp-authored-eval@v1",
  cases: cases.map((item) => {
    const sourceId = item.premises[0]!.documentId;
    const sourcePath = `sources/${sourceId}.md`;
    copyFileSync(join(ROOT(), "sources", `${sourceId}.md`), join(dataset, sourcePath));
    const labelsPath = `labels/${item.id}.json`;
    writeFileSync(join(dataset, labelsPath), JSON.stringify({ labels: [
      { name: `${item.id}:question`, expected: item.question },
      { name: `${item.id}:answer`, expected: item.expectedAnswer },
      { name: `${item.id}:evidence`, expected: item.premises.map((premise) => ({ document: premise.documentId, quotes: premise.quotes })) },
    ] }, null, 2));
    return {
      id: item.id, source: { path: sourcePath, sha256: sha(readFileSync(join(dataset, sourcePath))) }, labels: { path: labelsPath, sha256: sha(readFileSync(join(dataset, labelsPath))) },
      provenance: { kind: "authored", author, description: `${item.split} ${item.class} question over a public source (${item.provenance.map((source) => source.url).join(", ")})`, createdAt: "2026-11-14T00:00:00.000Z" },
    };
  }),
};
writeFileSync(join(dataset, "integrity-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ dataset, cases: manifest.cases.length }));
