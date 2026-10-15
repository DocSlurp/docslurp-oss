/**
 * Kreuzberg extraction benchmark.
 *
 * Runs kreuzberg (and configurable comparison extractors) against the PDF
 * fixture suite and scores each extractor on signal coverage, metadata
 * presence, latency, and character yield per page.
 *
 * Usage:
 *   pnpm benchmark:kreuzberg [--fixtures id1,id2] [--extractors kreuzberg,native-pdf-markdown] [--output report.json]
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { CommandRunner } from "../tools/runner.js";
import { runNativePdfArm } from "./native-pdf-arm.js";
import { scoreExtractionPlausibility } from "../lib/extracted-markdown.js";

// ── Fixture manifest types ───────────────────────────────────────────────────

interface FixtureDefinition {
  id: string;
  path: string;
  tags: string[];
  extractors: string[];
  expectedSignals: string[];
  expectedRegex: string[];
  minimumSignalCoverage: number;
  /** When true, evaluate kreuzberg metadata fields in addition to content. */
  checkMetadata?: boolean;
}

interface FixtureManifest {
  fixtures: FixtureDefinition[];
}

// ── Extractor abstraction ────────────────────────────────────────────────────

export type ExtractorId =
  | "kreuzberg"
  | "native-pdf-text"
  | "native-pdf-markdown"
  | "pdftotext"
  | "unpdf"
  | "docling";

interface ExtractionOutput {
  content: string;
  /** Metadata key-value pairs exposed by the extractor (kreuzberg only). */
  metadata: Record<string, unknown>;
  /** Wall-clock milliseconds for the extraction call. */
  latencyMs: number;
  /** Character count of extracted content. */
  charCount: number;
  error: string | null;
}

async function runExtractor(
  extractorId: ExtractorId,
  sourcePath: string,
  runner: CommandRunner,
  tempDir: string,
  signal?: AbortSignal
): Promise<ExtractionOutput> {
  const startedAt = Date.now();

  try {
    switch (extractorId) {
      case "kreuzberg": {
        const outPath = path.join(tempDir, "kreuzberg.md");
        const plan = await runner.kreuzbergMarkdown(sourcePath, outPath);
        if (!plan.available) {
          return { content: "", metadata: {}, latencyMs: 0, charCount: 0, error: "kreuzberg unavailable" };
        }
        await runner.run(plan, signal);
        const content = await readFile(outPath, "utf8");
        // kreuzberg metadata is only available via the JS API, not the script output
        const metadata = await readKreuzbergMetadata(sourcePath);
        return { content, metadata, latencyMs: Date.now() - startedAt, charCount: content.length, error: null };
      }

      case "native-pdf-text":
      case "native-pdf-markdown": {
        const content = await runNativePdfArm(sourcePath, extractorId === "native-pdf-text" ? "text" : "markdown");
        return { content, metadata: {}, latencyMs: Date.now() - startedAt, charCount: content.length, error: null };
      }

      case "pdftotext": {
        const outPath = path.join(tempDir, "pdftotext.txt");
        const plan = await runner.plan("pdftotext", "-layout", "-enc", "UTF-8", sourcePath, outPath);
        if (!plan.available) return { content: "", metadata: {}, latencyMs: 0, charCount: 0, error: "pdftotext unavailable" };
        await runner.run(plan, signal);
        const content = await readFile(outPath, "utf8").catch(() => "");
        return { content, metadata: {}, latencyMs: Date.now() - startedAt, charCount: content.length, error: null };
      }

      case "unpdf": {
        const outPath = path.join(tempDir, "unpdf.json");
        const plan = await runner.unpdfExtract(sourcePath, outPath);
        if (!plan.available) return { content: "", metadata: {}, latencyMs: 0, charCount: 0, error: "unpdf unavailable" };
        await runner.run(plan, signal);
        const raw = await readFile(outPath, "utf8");
        const parsed = JSON.parse(raw) as { text?: string; pages?: Array<{ lines?: string[] }> };
        const content = parsed.text ?? parsed.pages?.flatMap((p) => p.lines ?? []).join("\n") ?? "";
        return { content, metadata: {}, latencyMs: Date.now() - startedAt, charCount: content.length, error: null };
      }

      case "docling": {
        const plan = await runner.doclingMarkdown(sourcePath, tempDir);
        if (!plan.available) return { content: "", metadata: {}, latencyMs: 0, charCount: 0, error: "docling unavailable" };
        await runner.run(plan, signal);
        // docling writes <basename>.md in the output directory
        const base = path.basename(sourcePath, path.extname(sourcePath));
        const content = await readFile(path.join(tempDir, `${base}.md`), "utf8").catch(() => "");
        return { content, metadata: {}, latencyMs: Date.now() - startedAt, charCount: content.length, error: null };
      }

      default:
        return { content: "", metadata: {}, latencyMs: 0, charCount: 0, error: `unknown extractor: ${extractorId}` };
    }
  } catch (error) {
    return {
      content: "",
      metadata: {},
      latencyMs: Date.now() - startedAt,
      charCount: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readKreuzbergMetadata(sourcePath: string): Promise<Record<string, unknown>> {
  try {
    // Dynamic import so the module can be absent without breaking the build
    const mod = await import("@kreuzberg/node" as string);
    const result = await (mod as { extractFile: (p: string) => Promise<{ metadata?: Record<string, unknown> }> }).extractFile(sourcePath);
    return result.metadata ?? {};
  } catch {
    return {};
  }
}

// ── Signal scoring ───────────────────────────────────────────────────────────

export interface SignalScore {
  coverage: number;
  matchedSignals: number;
  totalSignals: number;
  matchedStringSignals: number;
  matchedRegexSignals: number;
  /** True when coverage >= fixture.minimumSignalCoverage */
  passed: boolean;
}

export function scoreSignals(
  fixture: Pick<FixtureDefinition, "expectedSignals" | "expectedRegex" | "minimumSignalCoverage">,
  content: string
): SignalScore {
  const haystack = content.toLowerCase();

  const matchedStringSignals = fixture.expectedSignals.reduce(
    (count, signal) => haystack.includes(signal.toLowerCase()) ? count + 1 : count,
    0
  );

  const matchedRegexSignals = fixture.expectedRegex.reduce((count, pattern) => {
    try {
      return new RegExp(pattern, "i").test(content) ? count + 1 : count;
    } catch {
      return count;
    }
  }, 0);

  const totalSignals = fixture.expectedSignals.length + fixture.expectedRegex.length;
  const matchedSignals = matchedStringSignals + matchedRegexSignals;
  const coverage = totalSignals === 0 ? 1 : matchedSignals / totalSignals;

  return {
    coverage,
    matchedSignals,
    totalSignals,
    matchedStringSignals,
    matchedRegexSignals,
    passed: coverage >= fixture.minimumSignalCoverage
  };
}

/** Score metadata presence — checks whether expected keys appear in the metadata object. */
export function scoreMetadata(
  fixture: Pick<FixtureDefinition, "expectedSignals">,
  metadata: Record<string, unknown>
): { coverage: number; present: string[]; missing: string[] } {
  const metaText = JSON.stringify(metadata).toLowerCase();
  const present: string[] = [];
  const missing: string[] = [];

  for (const signal of fixture.expectedSignals) {
    const key = signal.replace(/:$/, "").toLowerCase();
    if (metaText.includes(key)) {
      present.push(signal);
    } else {
      missing.push(signal);
    }
  }

  return {
    coverage: fixture.expectedSignals.length === 0 ? 1 : present.length / fixture.expectedSignals.length,
    present,
    missing
  };
}

// ── Per-result types ─────────────────────────────────────────────────────────

export interface ExtractorResult {
  fixtureId: string;
  extractorId: string;
  latencyMs: number;
  charCount: number;
  plausibilityScore: number;
  signalCoverage: number;
  matchedSignals: number;
  totalSignals: number;
  matchedStringSignals: number;
  matchedRegexSignals: number;
  metadataCoverage: number | null;
  metadataPresent: string[];
  metadataMissing: string[];
  passed: boolean;
  error: string | null;
}

export interface KreuzbergBenchmarkArgs {
  /** Only run these fixture IDs. Defaults to all kreuzberg-tagged fixtures. */
  fixtureIds?: string[];
  /** Which extractors to run. Defaults to kreuzberg + the fixture's own extractor list. */
  extractorIds?: ExtractorId[];
  runner?: CommandRunner;
}

// ── Main benchmark runner ────────────────────────────────────────────────────

export interface KreuzbergBenchmarkReport {
  fixtures: FixtureDefinition[];
  results: ExtractorResult[];
  summary: ExtractorSummary[];
}

export interface ExtractorSummary {
  extractorId: string;
  fixtureCount: number;
  passRate: number;
  avgCoverage: number;
  avgPlausibilityScore: number;
  avgLatencyMs: number;
  avgCharCount: number;
}

export async function runKreuzbergBenchmarks(args: KreuzbergBenchmarkArgs = {}): Promise<KreuzbergBenchmarkReport> {
  const runner = args.runner ?? new CommandRunner();
  const manifestPath = path.resolve(process.cwd(), "testdata/pdf-fixtures/fixtures.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;

  // Default: kreuzberg-tagged fixtures only
  const fixtures = manifest.fixtures.filter((f) => {
    if (args.fixtureIds?.length) return args.fixtureIds.includes(f.id);
    return f.tags.includes("kreuzberg");
  });

  const results: ExtractorResult[] = [];

  try {
    for (const fixture of fixtures) {
      const sourcePath = path.resolve(path.dirname(manifestPath), fixture.path);

      // Which extractors to compare for this fixture
      const extractorList: ExtractorId[] = args.extractorIds?.length
        ? args.extractorIds
        : ["kreuzberg", ...fixture.extractors.filter((e): e is ExtractorId => e !== "kreuzberg")];

      for (const extractorId of extractorList) {
        const tempDir = await mkdtemp(path.join(tmpdir(), `docslurp-kz-bench-${extractorId}-`));
        try {
          const output = await runExtractor(extractorId, sourcePath, runner, tempDir);
          const signals = scoreSignals(fixture, output.content);

          // Estimate page count from content (heuristic: ~3000 chars per page)
          const pageCount = Math.max(1, Math.ceil(output.charCount / 3000));
          const plausibilityScore = output.charCount > 0
            ? scoreExtractionPlausibility(output.content, pageCount).plausibilityScore
            : 0;

          let metadataCoverage: number | null = null;
          let metadataPresent: string[] = [];
          let metadataMissing: string[] = [];

          if (fixture.checkMetadata && extractorId === "kreuzberg") {
            const ms = scoreMetadata(fixture, output.metadata);
            metadataCoverage = ms.coverage;
            metadataPresent = ms.present;
            metadataMissing = ms.missing;
          }

          results.push({
            fixtureId: fixture.id,
            extractorId,
            latencyMs: output.latencyMs,
            charCount: output.charCount,
            plausibilityScore,
            signalCoverage: signals.coverage,
            matchedSignals: signals.matchedSignals,
            totalSignals: signals.totalSignals,
            matchedStringSignals: signals.matchedStringSignals,
            matchedRegexSignals: signals.matchedRegexSignals,
            metadataCoverage,
            metadataPresent,
            metadataMissing,
            passed: signals.passed && (metadataCoverage === null || metadataCoverage >= 0.5),
            error: output.error
          });
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
    }
  } finally {
    if (!args.runner) {
      await runner.close();
    }
  }

  const allExtractorIds = [...new Set(results.map((r) => r.extractorId))];
  const summary: ExtractorSummary[] = allExtractorIds.map((extractorId) => {
    const ers = results.filter((r) => r.extractorId === extractorId && r.error === null);
    const divisor = ers.length || 1;
    return {
      extractorId,
      fixtureCount: ers.length,
      passRate: ers.filter((r) => r.passed).length / divisor,
      avgCoverage: ers.reduce((sum, r) => sum + r.signalCoverage, 0) / divisor,
      avgPlausibilityScore:
        ers.reduce((sum, r) => sum + r.plausibilityScore, 0) / divisor,
      avgLatencyMs: ers.reduce((sum, r) => sum + r.latencyMs, 0) / divisor,
      avgCharCount: ers.reduce((sum, r) => sum + r.charCount, 0) / divisor
    };
  });

  return { fixtures, results, summary };
}

export async function writeKreuzbergBenchmarkReport(
  args: KreuzbergBenchmarkArgs & { outputPath: string }
): Promise<void> {
  const report = await runKreuzbergBenchmarks(args);
  await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
