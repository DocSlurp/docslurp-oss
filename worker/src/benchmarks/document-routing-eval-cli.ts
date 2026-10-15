import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LiteParseDocumentExtractionAdapter } from "../lib/document-extraction-adapter.js";
import { buildAdaptiveRoutingDecisionSurface } from "../stages/classify-route.js";
import { CommandRunner } from "../tools/runner.js";
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

async function evaluateFixture(args: {
  fixture: RoutingEvalFixture;
  fixtureRoot: string;
  tempRoot: string;
  adapter: LiteParseDocumentExtractionAdapter;
}): Promise<RoutingEvalObservation> {
  const inputPath = path.resolve(args.fixtureRoot, args.fixture.path);
  const outputPath = path.join(args.tempRoot, `${args.fixture.id}.structured.json`);
  const startedAt = performance.now();
  const extraction = await args.adapter.extract({ inputPath, outputPath });
  const complexity = new Map(
    extraction.pages.flatMap((page) =>
      page.complexity ? [[page.pageNumber, page.complexity] as const] : [],
    ),
  );
  const routing = buildAdaptiveRoutingDecisionSurface({
    documentId: args.fixture.id,
    filename: path.basename(args.fixture.path),
    text: extraction.pages.map((page) => page.markdown).join("\f"),
    pageCount: extraction.pages.length,
    evidence: {
      source: "liteparse-structured",
      artifactUri: outputPath,
    },
    structuredComplexity: complexity,
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

  const tempRoot = await mkdtemp(path.join(tmpdir(), "docslurp-routing-eval-"));
  const adapter = new LiteParseDocumentExtractionAdapter(new CommandRunner(), {
    ocrEnabled: false,
  });
  try {
    const results = [];
    for (const fixture of fixtures) {
      const observation = await evaluateFixture({
        fixture,
        fixtureRoot: path.dirname(manifestPath),
        tempRoot,
        adapter,
      });
      const result = scoreRoutingEvalFixture(fixture, observation);
      results.push(result);
      console.log(
        `[routing-eval] fixture=${fixture.id} status=${result.passed ? "pass" : "fail"} ` +
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
        `p95_latency_ms=${report.p95LatencyMs.toFixed(1)} hosted_ai_calls=0 estimated_cost_usd=0`,
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
