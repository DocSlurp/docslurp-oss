// Parser VM only: no worker credentials enter this process.
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { inspectQuarantineBytes } from "../dist/lib/quarantine-bytes.js";
const [input, optionsPath, output] = process.argv.slice(2);
const size = (await stat(input)).size;
if (size > 1024 ** 3 || (await stat(optionsPath)).size > 64 * 1024) throw new Error("quarantine input exceeds limit");
if (size > 500 * 1024 * 1024) {
  const file = await open(input, "r");
  try {
    const header = Buffer.alloc(5);
    await file.read(header, 0, header.length, 0);
    if (!header.equals(Buffer.from("%PDF-"))) throw new Error("quarantine input exceeds limit");
  } finally {
    await file.close();
  }
}
const options = JSON.parse(await readFile(optionsPath, "utf8"));
const bytes = await readFile(input);
const charts = options.charts && typeof options.charts === "object" ? options.charts : null;
const refused = (reason) => ({ status: "refused", reason, ms: 0 });

// Inline chart extraction (DOCSLURP_CHART_EXPORT_INLINE): only when the host asks. Everything about it, the module load
// included, is inside a try: a chart failure (a missing or broken module, a worker crash) is a chart refusal and never
// fails this command. Unit workers (#364's chart-export-worker.mjs) start only after the plan passed, read the input file
// themselves, and contain each unit: a crash or overrun loses that unit only (chart-inline.mjs).
let chartModule = null;
if (charts) {
  try {
    chartModule = await import("./chart-inline.mjs");
  } catch {
    chartModule = null;
  }
}
const inspection = inspectQuarantineBytes(bytes, options.filename, options.policy);
// The text page count (DocSlurp/app issue 599), only when the host asks. Its module is loaded here, guarded, so an image
// missing it (or the shared text-page-rule subpath) still inspects every file: the answer key is then absent, which the
// host treats as unavailable (retried), and parser-vm-contract.mjs does not advertise inspection-text-pages. Once loaded,
// a request it refuses or a count that throws fails this command, like any inspection failure.
if (options.text !== undefined && options.text !== null) {
  let textPages = null;
  try {
    textPages = await import("../dist/lib/text-pages-guest.js");
  } catch {
    textPages = null;
  }
  if (textPages) inspection.text = textPages.inspectTextPages(bytes, inspection.sniffed, textPages.parseTextPagesRequest(options.text));
}
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
    // The command started with this process (performance.now() 0): the inspection's time counts against the chart step.
    answer = chartModule ? await chartModule.inlineCharts(bytes, charts, inspection, input, undefined, undefined, { commandStartedAt: 0 }) : refused("worker-failed");
  } catch {
    answer = refused("worker-failed");
  }
  let result = JSON.stringify({ ...inspection, charts: answer });
  // The chart answer has its own allowance on top; over it, the answer becomes a refusal (never a failed command).
  if (Buffer.byteLength(result) > 6 * 1024 * 1024) result = JSON.stringify({ ...inspection, charts: refused("result-too-large") });
  await put(result);
}
