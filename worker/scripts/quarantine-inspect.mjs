// Parser VM only: no worker credentials enter this process.
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { inspectQuarantineBytes } from "../dist/lib/quarantine-bytes.js";
const [input, optionsPath, output] = process.argv.slice(2);
if ((await stat(input)).size > 500 * 1024 * 1024 || (await stat(optionsPath)).size > 64 * 1024) throw new Error("quarantine input exceeds limit");
const options = JSON.parse(await readFile(optionsPath, "utf8"));
const bytes = await readFile(input);
const charts = options.charts && typeof options.charts === "object" ? options.charts : null;
const refused = (reason) => ({ status: "refused", reason, ms: 0 });

// Inline chart extraction (DOCSLURP_CHART_EXPORT_INLINE): only when the host asks. Everything about it, the module load
// included, is inside a try: a chart failure (a missing or broken module, a worker crash) is a chart refusal and never
// fails this command. The worker starts only after the plan passed (pre-starting an SVG's worker during the inspection
// saved ~1 ms on the parser VM, performance/chart-export-inline, so it is not done).
let chartModule = null;
if (charts) {
  try {
    chartModule = await import("./chart-inline.mjs");
  } catch {
    chartModule = null;
  }
}
const inspection = inspectQuarantineBytes(bytes, options.filename, options.policy);
// The inspection's own bound, unchanged: 2 MiB without the chart answer.
const own = JSON.stringify(inspection);
if (Buffer.byteLength(own) > 2 * 1024 * 1024) throw new Error("quarantine result exceeds limit");
// Each write is whole or absent (temp file, then rename). The inspection is written before charts run, so a chart step
// that crashes the process cannot lose the verdict's input (council r3 L1): the host reads it and records the charts as
// refused. A timeout still discards every output (the runner never downloads a timed-out command's files).
const put = async (json) => { await writeFile(`${output}.part`, json, { mode: 0o600 }); await rename(`${output}.part`, output); };
await put(own);
if (charts) {
  let answer;
  try {
    answer = chartModule ? await chartModule.inlineCharts(bytes, charts, inspection) : refused("worker-failed");
  } catch {
    answer = refused("worker-failed");
  }
  let result = JSON.stringify({ ...inspection, charts: answer });
  // The chart answer has its own allowance on top; over it, the answer becomes a refusal (never a failed command).
  if (Buffer.byteLength(result) > 6 * 1024 * 1024) result = JSON.stringify({ ...inspection, charts: refused("result-too-large") });
  await put(result);
}
