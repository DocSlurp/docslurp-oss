import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveScriptsDir } from "../tools/scripts-dir.js";
import type { CommandRunner } from "../tools/runner.js";
import { detectHtmlEmbeds as localDetect, type HtmlEmbedReport } from "./html-embeds-guest.js";
export type { HtmlEmbedReport, HtmlEmbeddedItem, HtmlEmbedKind } from "./html-embeds-guest.js";
export function detectHtmlEmbeds(html: string): HtmlEmbedReport {
  if (process.env.NODE_ENV === "production") throw new Error("HTML source inspection requires the parser VM");
  return localDetect(html);
}
export async function detectHtmlEmbedsFile(input: string, runner: Pick<CommandRunner, "run">, signal?: AbortSignal): Promise<HtmlEmbedReport> {
  if ((await stat(input)).size > 16 * 1024 * 1024) throw new Error("HTML embed source exceeds 16 MiB");
  if (process.env.NODE_ENV !== "production") return localDetect(await readFile(input, "utf8"));
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-embeds-"));
  try {
    const output = path.join(dir, "report.json");
    await runner.run({ binary: "node", args: [path.join(resolveScriptsDir(), "html-embeds.mjs"), input, output], available: true, readOnlyInputs: true, timeoutMs: 60_000 }, signal);
    if ((await stat(output)).size > 4 * 1024 * 1024) throw new Error("HTML embed report exceeds limit");
    const result = JSON.parse(await readFile(output, "utf8")) as HtmlEmbedReport;
    const kinds = new Set(["iframe", "iframe-srcdoc", "embed", "object", "video", "audio", "canvas", "svg-foreign-object", "script-external", "script-rendered"]);
    if (!result || result.schemaVersion !== "html-embeds@v1" || !Array.isArray(result.items) || result.items.length > 1000 || result.needsAttention !== (result.items.length > 0) || !result.counts || typeof result.counts !== "object") throw new Error("invalid HTML embed report");
    const counts: Record<string, number> = {};
    for (const item of result.items) {
      if (!item || !kinds.has(item.kind) || !(item.src === null || typeof item.src === "string" && item.src.length <= 2048) || typeof item.hasInlineFallback !== "boolean" || typeof item.note !== "string" || item.note.length > 4096) throw new Error("invalid HTML embed item");
      counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    }
    if (Object.keys(result.counts).length !== Object.keys(counts).length || Object.entries(result.counts).some(([key, value]) => value !== counts[key])) throw new Error("invalid HTML embed counts");
    return result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
