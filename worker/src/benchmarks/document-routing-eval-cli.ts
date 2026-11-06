import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { normalizeExtractedMarkdown } from "../lib/extracted-markdown.js";
import { collectPageLayoutFacts } from "../lib/page-layout-evidence.js";
import { collectPageImageEvidence, drawnBytesPerPage, pageAlignedTexts, totalEmbeddedImageBytes, type PageImageEvidence } from "../lib/page-image-evidence.js";
import { buildAdaptiveRoutingDecisionSurface, canonicalBlocksToPageText } from "../stages/classify-route.js";
import { CommandRunner } from "../tools/runner.js";
import { dopplerConverterPath } from "../tools/doppler.js";
import {
  buildRoutingEvalReport,
  parseRoutingEvalManifest,
  scoreRoutingEvalFixture,
  type RoutingEvalFixture,
  type RoutingEvalObservation,
} from "./document-routing-eval.js";

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function repoRoot(): string {
  return path.basename(process.cwd()) === "worker"
    ? path.resolve(process.cwd(), "..")
    : process.cwd();
}

function pdfInfoPages(stdout: string): number {
  const pages = Number.parseInt(stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? "", 10);
  if (!Number.isSafeInteger(pages) || pages < 1) throw new Error("pdfinfo reported no page count");
  return pages;
}

/**
 * The PDF extractor output routing reads. Doppler is the PDF extractor (vm-pdf, or doppler-md in local mode), so the default is
 * `doppler-recorded`: Doppler's Markdown for each fixture, recorded from the pinned Doppler commit (testdata/pdf-fixtures/
 * doppler-md, sha256-checked against its manifest) so CI routes on Doppler's output without building it. `doppler-live` runs
 * Doppler's pdftomarkdown (DOCSLURP_DOPPLER_BIN_DIR); `poppler-text` runs Poppler's layout text, the local-mode last resort.
 */
type Evidence = "doppler-recorded" | "doppler-live" | "poppler-text";
const EVIDENCE: readonly Evidence[] = ["doppler-recorded", "doppler-live", "poppler-text"];

/** A recorded Doppler file for a fixture (`.md` output or `.xhtml` word boxes and rules), checked against its manifest. */
async function recordedDopplerFile(inputPath: string, fixtureRoot: string, extension: ".md" | ".xhtml"): Promise<string> {
  const recordedDir = path.join(fixtureRoot, "doppler-md");
  const manifest = JSON.parse(await readFile(path.join(recordedDir, "manifest.json"), "utf8")) as { files: Record<string, { sha256: string; sourceSha256: string }> };
  const name = `${path.basename(inputPath)}${extension}`;
  const entry = manifest.files[name];
  if (!entry) throw new Error(`no recorded Doppler ${extension} for ${path.basename(inputPath)}`);
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  if (sha(await readFile(inputPath)) !== entry.sourceSha256) throw new Error(`${path.basename(inputPath)} changed since its Doppler output was recorded; regenerate doppler-md/`);
  if (sha(await readFile(path.join(recordedDir, name))) !== entry.sha256) throw new Error(`recorded Doppler file ${name} does not match its manifest`);
  return path.join(recordedDir, name);
}

async function extractedText(evidence: Evidence, inputPath: string, fixtureRoot: string, runner: CommandRunner): Promise<{ text: string; extractor: string }> {
  if (evidence === "poppler-text") return { text: (await runner.run(await runner.extractText(inputPath, true))).stdout, extractor: "poppler-text" };
  if (evidence === "doppler-live") {
    const plan = await runner.dopplerMarkdown(inputPath);
    if (!plan.available) throw new Error(`doppler-live evidence needs pdftomarkdown at ${dopplerConverterPath()}`);
    return { text: (await runner.run(plan)).stdout, extractor: "doppler-md" };
  }
  const recorded = await readFile(await recordedDopplerFile(inputPath, fixtureRoot, ".md"));
  return { text: recorded.toString("utf8"), extractor: "doppler-md" };
}

/**
 * The evidence classify-route reads for a PDF, built the way the pipeline builds it: the PDF extractor's output (above),
 * normalized and turned into the canonical document extract-markdown stores, read back as classify-route reads it; plus
 * extract-markdown's page-image evidence (`pdfimages -list` and page sizes for sparse or suspect pages) and the drawn-bytes
 * hint. No OCR cross-check runs (it is off in the pipeline too) and nothing calls a hosted model.
 */
async function evaluateFixture(args: {
  fixture: RoutingEvalFixture;
  fixtureRoot: string;
  runner: CommandRunner;
  evidence: Evidence;
}): Promise<RoutingEvalObservation> {
  const inputPath = path.resolve(args.fixtureRoot, args.fixture.path);
  const startedAt = performance.now();
  const pageCount = pdfInfoPages((await args.runner.run(await args.runner.pdfInfo(inputPath))).stdout);
  const { text: extracted, extractor } = await extractedText(args.evidence, inputPath, args.fixtureRoot, args.runner);
  const winningText = normalizeExtractedMarkdown({ markdown: extracted, preserveTables: true });
  const canonical = buildCanonicalDocumentFromMarkdown({ documentId: args.fixture.id, text: winningText, pageCount, extractor });
  const text = canonicalBlocksToPageText(canonical.blocks, pageCount);
  const pageTexts = pageAlignedTexts(winningText, pageCount);
  let pageImageEvidence: Map<number, PageImageEvidence> | undefined;
  let drawnBytes: number | null = null;
  if (pageTexts) {
    const pages = await collectPageImageEvidence({ runner: args.runner, sourcePath: inputPath, pageTexts });
    if (pages) pageImageEvidence = new Map(pages.map((page) => [page.pageNumber, page]));
    const listing = (await args.runner.run(await args.runner.listPdfImages(inputPath, 1, pageCount))).stdout;
    drawnBytes = drawnBytesPerPage((await stat(inputPath)).size, totalEmbeddedImageBytes(listing), pageCount);
  }
  // Structural layout (the open walker over the same files local mode uses): placed images and table geometry.
  // Doppler's word boxes and ruling lines: recorded with its Markdown, or extracted here for live evidence.
  const wordBoxesFile = args.evidence === "doppler-recorded" ? await recordedDopplerFile(inputPath, args.fixtureRoot, ".xhtml") : undefined;
  const pageLayout = await collectPageLayoutFacts({ runner: args.runner, sourcePath: inputPath, pageCount, markdown: winningText, wordBoxesFile }) ?? undefined;
  const routing = buildAdaptiveRoutingDecisionSurface({
    documentId: args.fixture.id,
    filename: path.basename(args.fixture.path),
    text,
    pageCount,
    evidence: { source: "canonical-document", artifactUri: `file://${inputPath}` },
    pageImageEvidence,
    pageLayout,
    drawnBytesPerPage: drawnBytes,
    // Evidence routing: what every new run pins (lib/vision-routing-v2.ts pinRunRoutingVersion, v3).
    routingV2: true,
  });
  if (routing.status !== "ready") {
    throw new Error(`routing stayed deferred for fixture ${args.fixture.id}`);
  }

  return {
    fixtureId: args.fixture.id,
    latencyMs: performance.now() - startedAt,
    suggestedPlaybook: routing.suggestedPlaybook,
    visionPolicy: routing.visionPolicy,
    pages: routing.pages.map((page) => ({
      pageNumber: page.pageNumber,
      route: page.route,
      extractorHint: page.extractorHint,
      ocrAuthorized: page.ocrDecision?.authorized ?? false,
    })),
  };
}

async function main(): Promise<void> {
  const root = repoRoot();
  const manifestPath = path.resolve(
    root,
    readArg("--manifest") ??
      "worker/testdata/pdf-fixtures/document-routing-eval-v1.json",
  );
  const manifest = parseRoutingEvalManifest(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  const requestedTags = new Set(
    (readArg("--tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
  );
  const fixtures =
    requestedTags.size === 0
      ? manifest.fixtures
      : manifest.fixtures.filter((fixture) =>
          fixture.tags.some((tag) => requestedTags.has(tag)),
        );
  if (fixtures.length === 0) {
    throw new Error("no routing eval fixtures matched the requested tags");
  }

  const evidence = (readArg("--evidence") ?? "doppler-recorded") as Evidence;
  if (!EVIDENCE.includes(evidence)) throw new Error(`--evidence must be one of ${EVIDENCE.join(", ")}`);
  const runner = new CommandRunner();
  const results = [];
  for (const fixture of fixtures) {
    const observation = await evaluateFixture({
      fixture,
      fixtureRoot: path.dirname(manifestPath),
      runner,
      evidence,
    });
    const result = scoreRoutingEvalFixture(fixture, observation);
    results.push(result);
    const status = result.expectedFailure ? (result.passed ? "unexpected-pass" : "expected-fail") : result.passed ? "pass" : "fail";
    console.log(
      `[routing-eval] fixture=${fixture.id} status=${status} ` +
        `quality=${result.qualityScore.toFixed(3)} latency_ms=${result.latencyMs.toFixed(1)}`,
    );
    for (const check of result.checks.filter((candidate) => !candidate.passed)) {
      console.log(
        `[routing-eval] mismatch=${check.metric} expected=${JSON.stringify(check.expected)} ` +
          `actual=${JSON.stringify(check.actual)}`,
      );
    }
  }

  const report = buildRoutingEvalReport({ manifest, results });
  const outputArg = readArg("--output");
  if (outputArg) {
    const outputPath = path.resolve(root, outputArg);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[routing-eval] report=${outputPath}`);
  }
  console.log(
    `[routing-eval] status=${report.passed ? "pass" : "fail"} fixtures=${report.fixtureCount} ` +
      `pass_rate=${report.fixturePassRate.toFixed(3)} quality=${report.qualityScore.toFixed(3)} ` +
      `p95_latency_ms=${report.p95LatencyMs.toFixed(1)} evidence=${evidence}+page-image-evidence+layout-facts hosted_ai_calls=0 estimated_cost_usd=0`,
  );
  console.log(
    `[routing-eval] all_fixtures=${report.allFixtures.fixtureCount} all_pass_rate=${report.allFixtures.fixturePassRate.toFixed(3)} ` +
      `all_quality=${report.allFixtures.qualityScore.toFixed(3)} expected_failures=${report.expectedFailures.map((entry) => entry.fixtureId).join(",") || "none"}`,
  );
  for (const check of report.gateChecks.filter((candidate) => !candidate.passed)) {
    console.log(`[routing-eval] gate=${check.metric} expected=${JSON.stringify(check.expected)} actual=${JSON.stringify(check.actual)}`);
  }
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
