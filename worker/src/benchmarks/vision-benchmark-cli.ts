import { fromEnv } from "../config.js";
import { runVisionBenchmarks, writeVisionBenchmarkReport } from "./vision-benchmark.js";

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const cfg = fromEnv();
  const outputPath = readArg("--output");
  const fixtureIds = readArg("--fixtures")?.split(",").map((value) => value.trim()).filter(Boolean);
  const maxPagesPerFixture = Number.parseInt(readArg("--max-pages") ?? "", 10);
  const primaryVision = {
    ...(readArg("--target") ? { target: readArg("--target") as "hosted" | "local" } : {}),
    ...(readArg("--model-uri") ? { modelUri: readArg("--model-uri") } : {})
  };

  const args = {
    cfg,
    fixtureIds,
    maxPagesPerFixture: Number.isFinite(maxPagesPerFixture) ? maxPagesPerFixture : undefined,
    primaryVision
  };

  if (outputPath) {
    await writeVisionBenchmarkReport({ ...args, outputPath });
    console.log(outputPath);
    return;
  }

  const report = await runVisionBenchmarks(args);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
