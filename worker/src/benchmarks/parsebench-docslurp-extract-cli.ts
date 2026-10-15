import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { CommandRunner } from "../tools/runner.js";
import {
  normalizeExtractedMarkdown,
  type ExtractionPlausibilitySignals,
} from "../lib/extracted-markdown.js";
import { evaluateParserPolicy } from "../lib/parser-policy.js";
import { LiteParseDocumentExtractionAdapter } from "../lib/document-extraction-adapter.js";
import { defaultDocumentExtractorOrder } from "../extractors/registry.js";
import { resolveNativePdfEngine } from "../native-pdf/engine.js";
import { buildNativeParserPayload } from "../native-pdf/parser-payload.js";
import { runNativePdfArm } from "./native-pdf-arm.js";
import {
  parseBenchDocSlurpExtractors,
  type ParseBenchDocSlurpExtractor,
} from "./parsebench-extractors.js";

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requireArg(flag: string): string {
  const value = readArg(flag);
  if (!value) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value;
}

function parseExtractor(value: string): ParseBenchDocSlurpExtractor {
  if (parseBenchDocSlurpExtractors.includes(value as ParseBenchDocSlurpExtractor)) {
    return value as ParseBenchDocSlurpExtractor;
  }

  throw new Error(
    `Unknown extractor "${value}". Valid extractors: ${parseBenchDocSlurpExtractors.join(", ")}`,
  );
}

type LayoutPagePayload = {
  width: number;
  height: number;
  blocks: Array<{
    type?: number;
    bbox?: number[];
    lines?: Array<{
      bbox?: number[];
      spans?: Array<{
        text?: string;
        size?: number;
        font?: string;
      }>;
    }>;
  }>;
};

export type ExtractMetadata = {
  schemaVersion: "parser-policy-benchmark@v1";
  documentClass: string;
  tags: string[];
  pageCount: number;
  extractor: ParseBenchDocSlurpExtractor;
  selectedExtractor: string;
  latencyMs: number;
  observationLatencyMs: number;
  charCount: number;
  plausibilityScore: number;
  plausibilitySignals: ExtractionPlausibilitySignals;
  markdownTableCount: number;
  htmlTableCount: number;
  candidateScores: Array<{
    extractor: string;
    plausibilityScore: number;
    plausibilitySignals: ExtractionPlausibilitySignals;
    charCount: number;
    markdownTableCount: number;
    htmlTableCount: number;
    formattingScore: number;
    latencyMs: number;
    eligibleForSelection: boolean;
    selected: boolean;
    strippedDataUriBytes: number;
  }>;
  layoutPages: LayoutPagePayload[];
  imageWidth: number;
  imageHeight: number;
};

export type ExtractResult = {
  markdown: string;
  latencyMs: number;
  metadata: ExtractMetadata;
};

type CandidateResult = {
  extractor: string;
  markdown: string;
  latencyMs: number;
  pageCount?: number;
};

function selectBenchmarkHybridExtractors(): Array<
  Exclude<ParseBenchDocSlurpExtractor, "hybrid">
> {
  const mapped = defaultDocumentExtractorOrder.pdf.flatMap((label) => {
    switch (label) {
      case "kreuzberg":
        return ["kreuzberg"] as const;
      case "docling":
        return ["docling"] as const;
      case "native-pdf":
        return ["native-pdf-markdown"] as const;
      case "poppler-text":
        return ["pdftotext"] as const;
      default:
        return [];
    }
  });

  return [...new Set([...mapped, "liteparse" as const])];
}

async function runSingleExtractor(args: {
  inputPath: string;
  extractor: Exclude<ParseBenchDocSlurpExtractor, "hybrid">;
  runner: CommandRunner;
  tempDir: string;
}): Promise<CandidateResult> {
  const startedAt = Date.now();
  let markdown = "";
  let pageCount: number | undefined;

  switch (args.extractor) {
    case "liteparse": {
      const outPath = path.join(args.tempDir, "liteparse.json");
      const adapter = new LiteParseDocumentExtractionAdapter(args.runner, {
        ocrEnabled: false,
      });
      const result = await adapter.extract({
        inputPath: args.inputPath,
        outputPath: outPath,
      });
      markdown = result.markdown;
      pageCount = result.pages.length;
      break;
    }
    case "kreuzberg": {
      const outPath = path.join(args.tempDir, "kreuzberg.md");
      const plan = await args.runner.kreuzbergMarkdown(args.inputPath, outPath);
      if (!plan.available) throw new Error("kreuzberg unavailable");
      await args.runner.run(plan);
      markdown = await readFile(outPath, "utf8");
      break;
    }

    case "native-pdf-text":
    case "native-pdf-markdown": {
      markdown = await runNativePdfArm(args.inputPath, args.extractor === "native-pdf-text" ? "text" : "markdown");
      break;
    }

    case "pdftotext": {
      const plan = await args.runner.extractText(args.inputPath);
      if (!plan.available) throw new Error("pdftotext unavailable");
      const result = await args.runner.run(plan);
      markdown = result.stdout;
      break;
    }

    case "unpdf": {
      const outPath = path.join(args.tempDir, "unpdf.json");
      const plan = await args.runner.unpdfExtract(args.inputPath, outPath);
      if (!plan.available) throw new Error("unpdf unavailable");
      await args.runner.run(plan);
      const raw = await readFile(outPath, "utf8");
      const parsed = JSON.parse(raw) as {
        text?: string;
        pages?: Array<{ lines?: string[] }>;
      };
      markdown =
        parsed.text ?? parsed.pages?.flatMap((page) => page.lines ?? []).join("\n") ?? "";
      break;
    }

    case "docling": {
      const plan = await args.runner.doclingMarkdown(args.inputPath, args.tempDir);
      if (!plan.available) throw new Error("docling unavailable");
      await args.runner.run(plan);
      const base = path.basename(args.inputPath, path.extname(args.inputPath));
      markdown = await readFile(path.join(args.tempDir, `${base}.md`), "utf8");
      break;
    }
  }

  return {
    extractor: args.extractor,
    markdown,
    latencyMs: Date.now() - startedAt,
    pageCount,
  };
}

async function loadLayoutPages(
  runner: CommandRunner,
  inputPath: string,
  tempDir: string,
): Promise<LayoutPagePayload[]> {
  try {
    const engine = await resolveNativePdfEngine(runner);
    if (!engine) {
      return [];
    }
    const doc = await engine.openPath(inputPath);
    let payload: { pages?: LayoutPagePayload[] };
    try {
      payload = (await buildNativeParserPayload(doc)) as { pages?: LayoutPagePayload[] };
    } finally {
      await doc.close().catch(() => undefined);
    }
    return Array.isArray(payload.pages) ? payload.pages : [];
  } catch {
    return [];
  }
}

export async function extractMarkdown(args: {
  inputPath: string;
  outputPath: string;
  extractor: ParseBenchDocSlurpExtractor;
  runner: CommandRunner;
  documentClass?: string;
  tags?: string[];
}): Promise<ExtractResult> {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), `docslurp-parsebench-${args.extractor}-`),
  );

  try {
    const candidateExtractors: Array<Exclude<ParseBenchDocSlurpExtractor, "hybrid">> =
      args.extractor === "hybrid"
        ? selectBenchmarkHybridExtractors()
        : [args.extractor];

    const settledCandidates = await Promise.allSettled(
      candidateExtractors.map(
        async (extractor) =>
          await runSingleExtractor({
            inputPath: args.inputPath,
            extractor,
            runner: args.runner,
            tempDir,
          }),
      ),
    );
    const candidates = settledCandidates.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (args.extractor !== "hybrid" && settledCandidates[0]?.status === "rejected") {
      throw settledCandidates[0].reason;
    }

    if (candidates.length === 0) {
      throw new Error(`no parsebench extractors succeeded for ${args.inputPath}`);
    }

    const selectionEligible = new Set(
      args.extractor === "hybrid"
        ? candidates.slice(0, 2).map((candidate) => candidate.extractor)
        : candidates.map((candidate) => candidate.extractor),
    );
    const policyDecision = evaluateParserPolicy({
      primaryExtractor: candidates[0]!.extractor,
      candidates: candidates.map((candidate) => ({
        ...candidate,
        eligibleForSelection: selectionEligible.has(candidate.extractor),
      })),
    });
    const selected = candidates.find(
      (candidate) => candidate.extractor === policyDecision.selectedExtractor,
    )!;
    const htmlNormalizedMarkdown = normalizeExtractedMarkdown({
      markdown: policyDecision.selectedMarkdown,
      preserveTables: true,
    });
    const selectedObservation = policyDecision.observations.find(
      (candidate) => candidate.selected,
    )!;
    const layoutPages = await loadLayoutPages(args.runner, args.inputPath, tempDir);
    const imageWidth = Math.round(layoutPages[0]?.width ?? 1);
    const imageHeight = Math.round(layoutPages[0]?.height ?? 1);

    const metadata: ExtractMetadata = {
      schemaVersion: "parser-policy-benchmark@v1",
      documentClass: args.documentClass ?? "unclassified",
      tags: args.tags ?? [],
      pageCount: layoutPages.length || selected.pageCount || 0,
      extractor: args.extractor,
      selectedExtractor: selected.extractor,
      latencyMs: Math.max(
        ...candidates
          .filter((candidate) => selectionEligible.has(candidate.extractor))
          .map((candidate) => candidate.latencyMs),
      ),
      observationLatencyMs: candidates.reduce(
        (total, candidate) => total + candidate.latencyMs,
        0,
      ),
      charCount: htmlNormalizedMarkdown.length,
      plausibilityScore: selectedObservation.plausibilityScore,
      plausibilitySignals: selectedObservation.plausibilitySignals,
      markdownTableCount: selectedObservation.markdownTableCount,
      htmlTableCount: selectedObservation.htmlTableCount,
      candidateScores: policyDecision.observations.map((candidate) => ({
        extractor: candidate.extractor,
        plausibilityScore: candidate.plausibilityScore,
        plausibilitySignals: candidate.plausibilitySignals,
        charCount: candidate.charCount,
        markdownTableCount: candidate.markdownTableCount,
        htmlTableCount: candidate.htmlTableCount,
        formattingScore: candidate.formattingScore,
        latencyMs: candidate.latencyMs,
        eligibleForSelection: candidate.eligibleForSelection,
        selected: candidate.selected,
        strippedDataUriBytes: candidate.strippedDataUriBytes,
      })),
      layoutPages,
      imageWidth,
      imageHeight,
    };

    await writeFile(args.outputPath, htmlNormalizedMarkdown, "utf8");
    await writeFile(`${args.outputPath}.meta.json`, JSON.stringify(metadata), "utf8");
    return {
      markdown: htmlNormalizedMarkdown,
      latencyMs: metadata.latencyMs,
      metadata,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const inputPath = requireArg("--input");
  const outputPath = requireArg("--output");
  const extractor = parseExtractor(readArg("--extractor") ?? "hybrid");
  const runner = new CommandRunner();

  try {
    const result = await extractMarkdown({ inputPath, outputPath, extractor, runner });
    process.stdout.write(
      `${JSON.stringify({
        extractor,
        outputPath,
        latencyMs: result.latencyMs,
        charCount: result.markdown.length,
        selectedExtractor: result.metadata.selectedExtractor,
        markdownTableCount: result.metadata.markdownTableCount,
        htmlTableCount: result.metadata.htmlTableCount,
        plausibilityScore: result.metadata.plausibilityScore,
      })}\n`,
    );
  } finally {
    await runner.close();
  }
}

const isEntrypoint =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
