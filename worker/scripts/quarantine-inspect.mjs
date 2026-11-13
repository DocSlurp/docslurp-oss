// Parser VM only: no worker credentials enter this process.
import { readFile, stat, writeFile } from "node:fs/promises";
import { inspectQuarantineBytes } from "../dist/lib/quarantine-bytes.js";
const [input, optionsPath, output] = process.argv.slice(2);
if ((await stat(input)).size > 500 * 1024 * 1024 || (await stat(optionsPath)).size > 64 * 1024) throw new Error("quarantine input exceeds limit");
const options = JSON.parse(await readFile(optionsPath, "utf8"));
const bytes = await readFile(input);
const inspection = inspectQuarantineBytes(bytes, options.filename, options.policy);
// Inline chart extraction (DOCSLURP_CHART_EXPORT_INLINE): only when the host asks, after the inspection is complete,
// isolated in a worker thread (chart-inline.mjs). It never changes the inspection and never fails this command.
if (options.charts && typeof options.charts === "object") {
  const { inlineCharts } = await import("./chart-inline.mjs");
  inspection.charts = await inlineCharts(bytes, options.charts, inspection).catch(() => ({ status: "refused", reason: "worker-failed", ms: 0 }));
}
const result = JSON.stringify(inspection);
// 2 MiB for the inspection, plus the inline chart result's own bound when it was asked for.
if (Buffer.byteLength(result) > (options.charts ? 6 : 2) * 1024 * 1024) throw new Error("quarantine result exceeds limit");
await writeFile(output, result, { mode: 0o600 });
