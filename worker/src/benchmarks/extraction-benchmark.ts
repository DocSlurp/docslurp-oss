import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { CommandRunner } from "../tools/runner.js";
import { runNativePdfArm } from "./native-pdf-arm.js";
import { buildExtractionContract } from "../lib/extraction-contract.js";
import { scoreExtractionPlausibility } from "../lib/extracted-markdown.js";
import type { ExtractionContract } from "@docslurp/shared";

export interface ExtractionBenchmarkResult {
  fixtureId: string;
  method: string;
  latencyMs: number;
  plausibilityScore: number;
  contract: ExtractionContract;
}

export async function benchmarkExtractor(args: {
  fixtureId: string;
  fixturePath: string;
  method: "docling" | "native-pdf" | "kreuzberg" | "pandoc";
  runner: CommandRunner;
}): Promise<ExtractionBenchmarkResult> {
  const { fixtureId, fixturePath, method, runner } = args;
  const tempDir = await mkdtemp(
    path.join(tmpdir(), `docslurp-bench-${method}-`),
  );
  const startedAt = Date.now();

  try {
    let markdown = "";
    let extractionTimeMs = 0;

    switch (method) {
      case "docling": {
        const plan = await runner.doclingMarkdown(fixturePath, tempDir);
        await runner.run(plan);
        const base = path.basename(fixturePath, path.extname(fixturePath));
        markdown = await readFile(path.join(tempDir, `${base}.md`), "utf8");
        break;
      }
      case "native-pdf": {
        markdown = await runNativePdfArm(fixturePath, "markdown");
        break;
      }
      case "kreuzberg": {
        const outPath = path.join(tempDir, "out.md");
        const plan = await runner.kreuzbergMarkdown(fixturePath, outPath);
        await runner.run(plan);
        markdown = await readFile(outPath, "utf8");
        break;
      }
      case "pandoc": {
        const plan = await runner.extractMarkdown(fixturePath);
        const result = await runner.run(plan);
        markdown = result.stdout;
        break;
      }
    }

    extractionTimeMs = Date.now() - startedAt;
    const plausibilityScore = scoreExtractionPlausibility(
      markdown,
      1,
    ).plausibilityScore; // Assume 1 page for simple benchmark
    const contract = buildExtractionContract({
      documentId: fixtureId,
      markdown,
      extractor: method,
      strategy: "benchmark",
      extractionTimeMs,
      pageCount: 1,
    });

    return {
      fixtureId,
      method,
      latencyMs: extractionTimeMs,
      plausibilityScore,
      contract,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
