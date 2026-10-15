/**
 * Standalone extraction CLI for benchmarks and eval harnesses that spawn a command per arm:
 *   node --import tsx src/native-pdf/extract-cli.ts --input <pdf> --output <file> [--format markdown|text]
 * Exits 2 when the private engine is not installed (the harness reports the arm as unavailable).
 */
import { writeFile } from "node:fs/promises";

import { runNativePdfArm } from "../benchmarks/native-pdf-arm.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const input = arg("input");
const output = arg("output");
const format = arg("format") === "text" ? "text" : "markdown";
if (!input || !output) {
  console.error("usage: extract-cli --input <pdf> --output <file> [--format markdown|text]");
  process.exit(64);
}
try {
  await writeFile(output, await runNativePdfArm(input, format), "utf8");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(message.includes("unavailable") ? 2 : 1);
}
