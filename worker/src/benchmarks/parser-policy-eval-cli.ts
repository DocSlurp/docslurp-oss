import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PerformanceEvent, UsageEvent } from "../models.js";
import { runWithPerfContext } from "../lib/perf-context.js";
import {
  resolveWorkerDeploymentProfile,
  type WorkerDeploymentProfile,
} from "../pipeline/local-compute-cost.js";
import { CommandRunner } from "../tools/runner.js";
import { extractMarkdown } from "./parsebench-docslurp-extract-cli.js";
import type { ParseBenchDocSlurpExtractor } from "./parsebench-extractors.js";
import {
  PARSER_POLICY_EVAL_SCHEMA_VERSION,
  evaluatePairedParityGate,
  scoreParserEval,
  selectorRegret,
  summarizeParserEvalResources,
  type ParserEvalFixture,
  type ParserEvalObservation,
} from "./parser-policy-eval.js";

type EvalManifest = {
  schemaVersion: "parser-policy-eval-manifest@v1";
  fixtures: Array<ParserEvalFixture & { path: string }>;
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const workerRoot = path.basename(process.cwd()) === "worker"
    ? process.cwd()
    : path.join(process.cwd(), "worker");
  const fixtureRoot = path.join(workerRoot, "testdata", "pdf-fixtures");
  const manifestPath = arg("--manifest") ??
    path.join(fixtureRoot, "parser-policy-eval-v1.json");
  const outputPath = arg("--output") ??
    path.join(process.cwd(), ".benchmarks", "parser-policy-eval-v1.json");
  const candidateExtractor = (arg("--candidate") ?? "liteparse") as ParseBenchDocSlurpExtractor;
  const baselineExtractor = (arg("--baseline") ?? "hybrid") as ParseBenchDocSlurpExtractor;
  const limit = Number.parseInt(arg("--limit") ?? "0", 10);
  const profile = resolveEvalProfile();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EvalManifest;
  const fixtures = limit > 0 ? manifest.fixtures.slice(0, limit) : manifest.fixtures;
  const scratch = path.join(path.dirname(outputPath), "parser-policy-artifacts");
  await mkdir(scratch, { recursive: true });
  const candidateRunner = new CommandRunner();
  const baselineRunner = new CommandRunner();
  const rows: Array<{
    fixture: ParserEvalFixture;
    candidate: ReturnType<typeof scoreParserEval>;
    baseline: ReturnType<typeof scoreParserEval>;
    selectorRegret: number;
  }> = [];
  try {
    for (const fixture of fixtures) {
      const inputPath = path.join(path.dirname(manifestPath), fixture.path);
      // Separate runners preserve independent cold/warm state. Sequential
      // execution avoids cross-candidate CPU/RSS contention.
      const candidate = await runObservation({
        fixture, extractor: candidateExtractor, inputPath, scratch,
        runner: candidateRunner, profile,
      });
      const baseline = await runObservation({
        fixture, extractor: baselineExtractor, inputPath, scratch,
        runner: baselineRunner, profile,
      });
      const candidateScore = scoreParserEval(fixture, candidate);
      const baselineScore = scoreParserEval(fixture, baseline);
      rows.push({
        fixture,
        candidate: candidateScore,
        baseline: baselineScore,
        selectorRegret: selectorRegret({
          selectedExtractor: candidateScore.extractor,
          scores: [candidateScore, baselineScore],
        }),
      });
    }
  } finally {
    await Promise.all([candidateRunner.close(), baselineRunner.close()]);
  }
  const gate = evaluatePairedParityGate({
    pairs: rows.map((row) => ({
      documentClass: row.fixture.documentClass,
      candidate: row.candidate,
      baseline: row.baseline,
    })),
    qualityTolerance: Number.parseFloat(arg("--quality-tolerance") ?? "0.02"),
    simpleDocumentClasses: ["born-digital-table", "metadata"],
  });
  const report = {
    schemaVersion: PARSER_POLICY_EVAL_SCHEMA_VERSION,
    manifestVersion: manifest.schemaVersion,
    candidateExtractor,
    baselineExtractor,
    generatedAt: new Date().toISOString(),
    deployment: {
      profile: profile.id,
      lane: profile.lane,
      workerClass: profile.workerClass,
      region: profile.region,
      image: profile.image,
      allocatedVcpu: profile.allocatedVcpu,
      allocatedMemoryGb: profile.allocatedMemoryGb,
      rates: profile.rates,
    },
    gate,
    rows,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, gate, fixtureCount: rows.length })}\n`);
  if (!gate.passed) process.exitCode = 1;
}

async function runObservation(args: {
  fixture: ParserEvalFixture;
  extractor: ParseBenchDocSlurpExtractor;
  inputPath: string;
  scratch: string;
  runner: CommandRunner;
  profile: WorkerDeploymentProfile;
}): Promise<ParserEvalObservation> {
  const outputPath = path.join(args.scratch, `${args.fixture.id}.${args.extractor}.md`);
  const performanceEvents: PerformanceEvent[] = [];
  const usageEvents: UsageEvent[] = [];
  const startedAt = Date.now();
  try {
    const result = await runWithPerfContext({
      runId: `parser-policy-eval:${args.fixture.id}`,
      documentId: args.fixture.id,
      scope: "document",
      stageName: "parser-policy-eval",
      pushPerformance: (event) => performanceEvents.push(event),
      pushUsage: (event) => usageEvents.push(event),
    }, async () => await extractMarkdown({
        inputPath: args.inputPath,
        outputPath,
        extractor: args.extractor,
        runner: args.runner,
        documentClass: args.fixture.documentClass,
        tags: args.fixture.tags,
      }));
    const blocks = result.metadata.layoutPages.flatMap((page) => page.blocks);
    const latencyMs = Date.now() - startedAt;
    const artifactBytes = await stat(outputPath)
      .then((file) => file.size)
      .catch(() => Buffer.byteLength(result.markdown, "utf8"));
    const resources = summarizeParserEvalResources({
      performanceEvents,
      usageEvents,
      latencyMs,
      artifactBytes,
      pageCount: result.metadata.pageCount,
      profile: args.profile,
    });
    return {
      fixtureId: args.fixture.id,
      extractor: result.metadata.selectedExtractor,
      markdown: result.markdown,
      pageCount: result.metadata.pageCount,
      bboxBackedBlockCount: blocks.filter((block) => block.bbox?.length === 4).length,
      blockCount: blocks.length,
      failed: false,
      timedOut: false,
      latencyMs,
      ...resources,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const resources = summarizeParserEvalResources({
      performanceEvents,
      usageEvents,
      latencyMs,
      artifactBytes: await stat(outputPath).then((file) => file.size).catch(() => 0),
      pageCount: 0,
      profile: args.profile,
    });
    return {
      fixtureId: args.fixture.id,
      extractor: args.extractor,
      markdown: "",
      pageCount: 0,
      bboxBackedBlockCount: 0,
      blockCount: 0,
      failed: true,
      timedOut: error instanceof Error && /timeout/i.test(error.message),
      latencyMs,
      ...resources,
    };
  }
}

function resolveEvalProfile(): WorkerDeploymentProfile {
  const profile = resolveWorkerDeploymentProfile();
  const cpuOverride = Number.parseFloat(
    process.env.DOCSLURP_EVAL_CPU_CENTS_PER_SECOND ?? "",
  );
  if (!Number.isFinite(cpuOverride) || cpuOverride < 0) return profile;
  return {
    ...profile,
    rates: { ...profile.rates, cpuCentsPerSecond: cpuOverride },
  };
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
