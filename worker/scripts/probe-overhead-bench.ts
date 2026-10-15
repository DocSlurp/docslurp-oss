/**
 * H10 evidence: per-document overhead of the Python page probe (a process per document) vs the in-process native-pdf
 * probe, on the same PDFs. Usage: tsx scripts/probe-overhead-bench.ts <jobs.json> [--docs N] [--out result.json]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createNativeProbeRunner, createPythonProbeRunner } from "../src/routing/page-input.js";

const args = process.argv.slice(2);
const jobs = JSON.parse(readFileSync(args[0]!, "utf8")) as Array<{ id: string; path: string; set: string; pages?: number }>;
const docs = Number(args[args.indexOf("--docs") + 1] || 24);
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
const picks = jobs.filter((j) => (j.pages ?? 1) <= 3 && j.set !== "wild-v1-raster").filter((_, i) => i % 29 === 0).slice(0, docs);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const python = createPythonProbeRunner();
const native = createNativeProbeRunner();
const startup: number[] = [];
for (let i = 0; i < 7; i++) {
  const t0 = performance.now();
  execFileSync(path.resolve("../.venv-evals/bin/python"), ["-c", "import sys; sys.path.insert(0,'scripts'); import page_probe"], { stdio: "ignore" });
  startup.push(performance.now() - t0);
}
await native({ pdfPath: picks[0]!.path }); // load the binding once, as the worker does
const rows: Array<{ id: string; pages: number; pythonMs: number; nativeMs: number }> = [];
for (const job of picks) {
  let t0 = performance.now();
  const pyOut = await python({ pdfPath: job.path });
  const pythonMs = performance.now() - t0;
  t0 = performance.now();
  await native({ pdfPath: job.path });
  const nativeMs = performance.now() - t0;
  rows.push({ id: job.id, pages: pyOut.trim().split("\n").length, pythonMs, nativeMs });
}
const pages = rows.reduce((n, r) => n + r.pages, 0);
const result = {
  docs: rows.length, pages,
  pythonImportMsMedian: median(startup),
  pythonPerDocMsMedian: median(rows.map((r) => r.pythonMs)), nativePerDocMsMedian: median(rows.map((r) => r.nativeMs)),
  pythonMsPerPage: rows.reduce((n, r) => n + r.pythonMs, 0) / pages, nativeMsPerPage: rows.reduce((n, r) => n + r.nativeMs, 0) / pages,
};
console.log(JSON.stringify(result, null, 2));
if (outPath) writeFileSync(outPath, JSON.stringify({ ...result, rows }, null, 2));
