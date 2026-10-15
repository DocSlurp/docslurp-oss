/**
 * CLI entry point for the kreuzberg extraction benchmark.
 *
 * Usage:
 *   pnpm benchmark:kreuzberg [options]
 *
 * Options:
 *   --output <path>          Write JSON report to this file (default: stdout)
 *   --fixtures <ids>         Comma-separated fixture IDs to run (default: all kreuzberg-tagged)
 *   --extractors <ids>       Comma-separated extractor IDs to compare
 *                            (default: kreuzberg + each fixture's own list)
 *                            Valid: kreuzberg, pymupdf-text, pymupdf4llm-markdown,
 *                                   pdftotext, pymupdf-ocr-text, unpdf, docling
 *
 * Examples:
 *   pnpm benchmark:kreuzberg
 *   pnpm benchmark:kreuzberg --output /tmp/kz-report.json
 *   pnpm benchmark:kreuzberg --fixtures kreuzberg-tables-invoice,kreuzberg-links-references
 *   pnpm benchmark:kreuzberg --extractors kreuzberg,pymupdf4llm-markdown
 */
import { runKreuzbergBenchmarks, writeKreuzbergBenchmarkReport } from "./kreuzberg-benchmark.js";
import type { ExtractorId } from "./kreuzberg-benchmark.js";

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function printSummaryTable(report: Awaited<ReturnType<typeof runKreuzbergBenchmarks>>): void {
  const cols = ["Extractor", "Fixtures", "Pass Rate", "Avg Coverage", "Avg Quality", "Avg Latency", "Avg Chars"];
  const widths = [24, 10, 12, 14, 13, 14, 12];
  const pad = (s: string, w: number) => s.padEnd(w);
  const header = cols.map((c, i) => pad(c, widths[i])).join("  ");

  process.stdout.write("\n── Kreuzberg Benchmark Summary ─────────────────────────────────────────\n");
  process.stdout.write(`${header}\n`);
  process.stdout.write(`${widths.map((w) => "─".repeat(w)).join("  ")}\n`);

  for (const row of report.summary) {
    const cells = [
      row.extractorId,
      String(row.fixtureCount),
      `${(row.passRate * 100).toFixed(0)}%`,
      `${(row.avgCoverage * 100).toFixed(1)}%`,
      `${(row.avgPlausibilityScore * 100).toFixed(1)}%`,
      `${row.avgLatencyMs.toFixed(0)}ms`,
      String(Math.round(row.avgCharCount))
    ];
    process.stdout.write(`${cells.map((c, i) => pad(c, widths[i])).join("  ")}\n`);
  }

  process.stdout.write("\n── Per-Fixture Results ──────────────────────────────────────────────────\n");
  for (const result of report.results) {
    const status = result.error ? "ERROR" : result.passed ? "PASS" : "FAIL";
    const meta = result.metadataCoverage !== null ? ` meta=${(result.metadataCoverage * 100).toFixed(0)}%` : "";
    process.stdout.write(
      `  ${status.padEnd(5)} ${result.fixtureId.padEnd(38)} ${result.extractorId.padEnd(22)} ` +
      `signals=${result.matchedSignals}/${result.totalSignals} (${(result.signalCoverage * 100).toFixed(0)}%)` +
      `${meta}` +
      (result.error ? `  err=${result.error}` : "") +
      "\n"
    );
  }

  process.stdout.write("\n");
}

async function main(): Promise<void> {
  const outputPath = readArg("--output");
  const fixtureIds = readArg("--fixtures")?.split(",").map((s) => s.trim()).filter(Boolean);
  const extractorIds = readArg("--extractors")?.split(",").map((s) => s.trim()).filter(Boolean) as ExtractorId[] | undefined;

  const args = { fixtureIds, extractorIds };

  if (outputPath) {
    await writeKreuzbergBenchmarkReport({ ...args, outputPath });
    console.log(`Report written to ${outputPath}`);
    return;
  }

  const report = await runKreuzbergBenchmarks(args);
  printSummaryTable(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
