/** Source JSON is parsed only in a VM in production. */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveScriptsDir } from "../tools/scripts-dir.js";
import { CommandRunner } from "../tools/runner.js";
import { extractStructuredJsonFile as localExtract, structuredJsonToMarkdown as localConvert, STRUCTURED_JSON_MAX_INPUT_BYTES, StructuredJsonError, type StructuredJsonOptions, type StructuredJsonResult } from "./structured-json-guest.js";
import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
import { GUEST_NODE_FLAGS } from "../sandbox/guest-node-flags.js";
export { STRUCTURED_JSON_DEFAULTS, STRUCTURED_JSON_MAX_INPUT_BYTES, StructuredJsonError } from "./structured-json-guest.js";
export type { StructuredJsonOptions, StructuredJsonResult } from "./structured-json-guest.js";
export function structuredJsonToMarkdown(input: string, options: StructuredJsonOptions = {}): StructuredJsonResult {
  if (vmOnlyParsing()) throw new StructuredJsonError("structured JSON source parsing requires the parser VM");
  return localConvert(input, options);
}
export async function extractStructuredJsonFile(sourcePath: string, outputPath: string, options: StructuredJsonOptions = {}, signal?: AbortSignal): Promise<StructuredJsonResult> {
  if (!vmOnlyParsing()) return localExtract(sourcePath, outputPath, options, signal);
  if ((await stat(sourcePath)).size > STRUCTURED_JSON_MAX_INPUT_BYTES) throw new StructuredJsonError("structured JSON input exceeds VM transfer limit");
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-structured-json-"));
  try {
    const config = path.join(dir, "options.json"), output = path.join(dir, "result.json");
    const settings: StructuredJsonOptions = {};
    for (const key of ["maxOutputChars", "maxTableRows", "maxTableColumns", "maxCellChars", "maxHeadingDepth", "maxSkippedLinesListed"] as const) {
      const value = options[key]; if (value !== undefined) settings[key] = value;
    }
    await writeFile(config, JSON.stringify(settings), { mode: 0o600 });
    await new CommandRunner().run({ binary: "node", args: [...GUEST_NODE_FLAGS, path.join(resolveScriptsDir(), "structured-json.mjs"), sourcePath, config, output], available: true, readOnlyInputs: true, timeoutMs: 60_000 }, signal);
    if ((await stat(output)).size > 16 * 1024 * 1024) throw new StructuredJsonError("structured JSON result exceeds limit");
    const result = JSON.parse(await readFile(output, "utf8")) as StructuredJsonResult;
    if (!result || typeof result.markdown !== "string" || result.markdown.length > 8_000_000 || !["json", "jsonl"].includes(result.format) || !Number.isSafeInteger(result.recordCount) || result.recordCount < 0 || typeof result.truncated !== "boolean" || !Array.isArray(result.skippedLines) || result.skippedLines.length > 5000 || result.skippedLines.some((line) => !Number.isSafeInteger(line.line) || line.line < 1 || typeof line.error !== "string" || line.error.length > 4096)) throw new StructuredJsonError("invalid structured JSON guest result");
    signal?.throwIfAborted(); await writeFile(outputPath, result.markdown, "utf8"); return result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
