import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import type { VisionConfig, VisionRuntime } from "@docslurp/shared";
import {
  DEFAULT_VISION_PROFILE,
  defaultVisionConfig,
  resolveVisionRoute,
  visionConfigSchema,
  visionProfileCatalog,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";

interface FixtureManifest {
  fixtures: FixtureDefinition[];
}

interface FixtureDefinition {
  id: string;
  path: string;
  tags: string[];
  expectedSignals: string[];
  expectedRegex: string[];
  minimumSignalCoverage: number;
}

export interface VisionBenchmarkArgs {
  cfg: Config;
  runner?: CommandRunner;
  fixtureIds?: string[];
  maxPagesPerFixture?: number;
  primaryVision?: Partial<VisionConfig>;
  includeBaselines?: boolean;
}

export interface VisionBenchmarkResult {
  fixtureId: string;
  model: string;
  runtime: VisionRuntime;
  pages: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  usageSource: string;
  coverage: number;
  matchedSignals: number;
  totalSignals: number;
  passed: boolean;
  error: string | null;
}

export async function runVisionBenchmarks(args: VisionBenchmarkArgs): Promise<{
  fixtures: FixtureDefinition[];
  results: VisionBenchmarkResult[];
  summary: Array<{
    model: string;
    runtime: VisionRuntime;
    fixtureCount: number;
    passRate: number;
    avgCoverage: number;
    avgLatencyMs: number;
    avgInputTokens: number;
    avgOutputTokens: number;
  }>;
}> {
  const runner = args.runner ?? new CommandRunner();
  const manifestPath = path.resolve(process.cwd(), "testdata/pdf-fixtures/fixtures.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
  const fixtures = manifest.fixtures.filter((fixture) => !args.fixtureIds?.length || args.fixtureIds.includes(fixture.id));
  const selectedPrimary = normalizeVisionConfig(args.cfg, args.primaryVision);

  const candidates = dedupeVisionConfigs(
    args.includeBaselines === false
      ? [selectedPrimary]
      : [
          {
            ...defaultVisionConfig,
            profile: "cheapest-local",
            target: "local",
            modelUri: "llm://local-cli/microsoft/Florence-2-base-ft"
          },
          selectedPrimary,
          {
            ...defaultVisionConfig,
            ...visionProfileCatalog[DEFAULT_VISION_PROFILE].config
          }
        ]
  );

  const results: VisionBenchmarkResult[] = [];

  try {
    for (const fixture of fixtures) {
      for (const candidate of candidates) {
        results.push(await runFixtureBenchmark({
          fixture,
          candidate,
          cfg: args.cfg,
          runner,
          manifestPath,
          maxPagesPerFixture: args.maxPagesPerFixture ?? 4
        }));
      }
    }
  } finally {
    if (!args.runner) {
      await runner.close();
    }
  }

  const summary = candidates.map((candidate) => {
    const route = resolveVisionRoute(candidate);
    const modelResults = results.filter((result) => result.model === route.model && result.runtime === route.runtime);
    const divisor = modelResults.length || 1;
    const passCount = modelResults.filter((result) => result.passed).length;
    return {
      model: route.model,
      runtime: route.runtime,
      fixtureCount: modelResults.length,
      passRate: passCount / divisor,
      avgCoverage: modelResults.reduce((sum, result) => sum + result.coverage, 0) / divisor,
      avgLatencyMs: modelResults.reduce((sum, result) => sum + result.latencyMs, 0) / divisor,
      avgInputTokens: modelResults.reduce((sum, result) => sum + result.inputTokens, 0) / divisor,
      avgOutputTokens: modelResults.reduce((sum, result) => sum + result.outputTokens, 0) / divisor
    };
  });

  return { fixtures, results, summary };
}

async function runFixtureBenchmark(args: {
  fixture: FixtureDefinition;
  candidate: VisionConfig;
  cfg: Config;
  runner: CommandRunner;
  manifestPath: string;
  maxPagesPerFixture: number;
}): Promise<VisionBenchmarkResult> {
  const sourcePath = path.resolve(path.dirname(args.manifestPath), args.fixture.path);
  const tempDir = await mkdtemp(path.join(tmpdir(), "docslurp-vision-bench-"));

  try {
    const renderPlan = await args.runner.renderPageImages(sourcePath, path.join(tempDir, "page"));
    if (!renderPlan.available) {
      throw new Error("pdftoppm unavailable");
    }

    await args.runner.run(renderPlan);
    const pages = (await readdir(tempDir))
      .filter((entry) => /^page-\d+\.png$/i.test(entry))
      .map((entry) => ({
        filename: entry,
        pageNumber: Number.parseInt(entry.match(/(\d+)\.png$/)?.[1] ?? "0", 10)
      }))
      .filter((entry) => entry.pageNumber > 0)
      .sort((left, right) => left.pageNumber - right.pageNumber)
      .slice(0, Math.max(1, args.maxPagesPerFixture));

    let latencyMs = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let usageSource = "estimated";
    let combinedText = "";

    for (const page of pages) {
      const outputPath = path.join(tempDir, `output-${page.pageNumber}.json`);
      const result = await executeVisionRuntime({
        imagePath: path.join(tempDir, page.filename),
        outputPath,
        vision: args.candidate,
        cfg: args.cfg,
        // Operator benchmark over evaluation fixtures, not workspace content.
        privacyMode: "standard",
        runner: args.runner
      });

      combinedText += `${result.text}\n`;
      latencyMs += result.latencyMs;
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      usageSource = result.usageSource;
    }

    const score = scoreFixture(args.fixture, combinedText);
    const route = resolveVisionRoute(args.candidate);
    return {
      fixtureId: args.fixture.id,
      model: route.model,
      runtime: route.runtime,
      pages: pages.length,
      latencyMs,
      inputTokens,
      outputTokens,
      usageSource,
      coverage: score.coverage,
      matchedSignals: score.matchedSignals,
      totalSignals: score.totalSignals,
      passed: score.coverage >= args.fixture.minimumSignalCoverage,
      error: null
    };
  } catch (error) {
    const route = resolveVisionRoute(args.candidate);
    return {
      fixtureId: args.fixture.id,
      model: route.model,
      runtime: route.runtime,
      pages: 0,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      usageSource: "estimated",
      coverage: 0,
      matchedSignals: 0,
      totalSignals: args.fixture.expectedSignals.length + args.fixture.expectedRegex.length,
      passed: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function scoreFixture(fixture: FixtureDefinition, output: string): {
  coverage: number;
  matchedSignals: number;
  totalSignals: number;
} {
  const haystack = output.toLowerCase();
  const matchedSignals = fixture.expectedSignals.reduce((count, signal) => (
    haystack.includes(signal.toLowerCase()) ? count + 1 : count
  ), 0);
  const matchedRegex = fixture.expectedRegex.reduce((count, pattern) => {
    try {
      return new RegExp(pattern, "i").test(output) ? count + 1 : count;
    } catch {
      return count;
    }
  }, 0);
  const totalSignals = fixture.expectedSignals.length + fixture.expectedRegex.length;
  return {
    coverage: totalSignals === 0 ? 1 : (matchedSignals + matchedRegex) / totalSignals,
    matchedSignals: matchedSignals + matchedRegex,
    totalSignals
  };
}

function normalizeVisionConfig(cfg: Config, override?: Partial<VisionConfig>): VisionConfig {
  void cfg;
  return visionConfigSchema.parse({ ...defaultVisionConfig, ...override });
}

function dedupeVisionConfigs(configs: VisionConfig[]): VisionConfig[] {
  const seen = new Set<string>();
  return configs.filter((config) => {
    const route = resolveVisionRoute(config);
    const key = `${route.runtime}:${config.modelUri}:${route.baseUrl ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function writeVisionBenchmarkReport(args: VisionBenchmarkArgs & { outputPath: string }): Promise<void> {
  const report = await runVisionBenchmarks(args);
  await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
