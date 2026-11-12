// Re-score stored rows after a scorer fix without new model calls: re-runs feature.score on what was kept.
// chat.answer: the answer text is the stored output; structured extraction: the raw text is in the call record.
import { readFileSync, writeFileSync } from "node:fs";
import { FEATURES } from "./features.mts";
import { cases } from "./corpus.mts";
import { parseStructuredFields } from "../../worker/src/stages/structured-extract.ts";
const run = process.argv[2];
const file = new URL(`./runs/${run}/results.jsonl`, import.meta.url);
const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
let changed = 0;
for (const row of rows) {
  const feature = FEATURES.find((f) => f.id === row.feature)!;
  const c = feature.cases().find((x) => x.id === row.case)!;
  if (row.feature === "chat.answer" && typeof row.output === "string") {
    const evidenceCount = 5; // evidenceFor always returns five passages
    const goldIndex = row.metrics?.citesGold === null ? 0 : undefined;
    void goldIndex; void cases;
    const fresh = feature.score(c, { text: row.output, evidenceCount, goldIndex: -1, evidenceText: row.judge?.input ?? "" }, row.calls);
    row.metrics = { ...row.metrics, declinedCorrectly: fresh.metrics.declinedCorrectly };
    changed += 1;
  }
  if (row.feature === "worker.structured-extraction") {
    const raw = row.calls?.at(-1)?.text ?? "";
    const fresh = feature.score(c, { raw, fields: parseStructuredFields(raw || "{}") }, row.calls);
    row.metrics = { ...row.metrics, ...fresh.metrics };
    changed += 1;
  }
}
writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`rescored ${changed} rows`);
process.exit(0);
