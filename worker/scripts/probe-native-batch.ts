/**
 * Run the native-pdf page probe over many PDFs (parity harness; counterpart of page_probe_batch.py).
 * Usage: tsx scripts/probe-native-batch.ts <jobs.json> <out.jsonl> [--verify-ocr-layer]
 */
import { readFileSync, writeFileSync } from "node:fs";

import { loadProbeBinding } from "../src/routing/probe/binding.js";
import { probeNativePdf, type NativeProbeRow } from "../src/routing/probe/probe.js";

const [jobsPath, outPath, ...flags] = process.argv.slice(2);
if (!jobsPath || !outPath) throw new Error("usage: probe-native-batch.ts <jobs.json> <out.jsonl> [--verify-ocr-layer]");
const loaded = loadProbeBinding();
if (!loaded.ok) throw new Error(loaded.reason);
const jobs = JSON.parse(readFileSync(jobsPath, "utf8")) as Array<{ id: string; path: string }>;
const lines: string[] = [];
for (const job of jobs) {
  const t0 = performance.now();
  const rows: NativeProbeRow[] = [];
  let error: string | null = null;
  try {
    for await (const row of probeNativePdf(loaded.binding, { pdfPath: job.path, verifyOcrLayer: flags.includes("--verify-ocr-layer") })) rows.push(row);
  } catch (e) {
    error = `${(e as { code?: string }).code ?? "Error"}: ${e instanceof Error ? e.message : String(e)}`;
  }
  lines.push(JSON.stringify({ id: job.id, rows, error, seconds: Number(((performance.now() - t0) / 1000).toFixed(4)) }));
}
writeFileSync(outPath, lines.join("\n") + "\n");
