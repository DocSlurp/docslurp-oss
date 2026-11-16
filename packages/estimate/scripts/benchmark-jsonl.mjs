// Reproducible local-only synthetic scale runs. No service, model calls or uploads.
import { createEstimator } from "../js/index.mjs";
import { nodePathRangeSource, blobRangeSource } from "../js/range.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const [mode, argument] = process.argv.slice(2);
if (!["large", "many"].includes(mode)) throw new Error("benchmark-jsonl.mjs large <local.pdf> | many [count]");
const count = mode === "large" ? 1 : Number(argument ?? 10000);
if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error("count must be 1..10000");
const moduleBytes = await readFile(new URL("../dist/docslurp_estimate.wasm", import.meta.url));
const moduleSha256 = createHash("sha256").update(moduleBytes).digest("hex");
const estimator = await createEstimator({ module: moduleBytes });
const fixture = mode === "many" ? await readFile(new URL("../examples/layout-candidates.pdf", import.meta.url)) : null;
const buckets = [1, 2, 5, 10, 20, 50, 100, 1000, Infinity];
const histogram = buckets.map(() => 0);
let reads = 0, readBytes = 0, largestRead = 0, outputBytes = 0, pages = 0, deep = 0, peakRss = 0, peakWasm = 0;
let firstOutputMs = null;
const started = performance.now();
for (let index = 0; index < count; index += 1) {
  const fileStarted = performance.now();
  // Different valid PDF snapshots from a few KiB through 131 KiB. Padding is a
  // comment after EOF, never document-name recognition in production code.
  const source = mode === "large" ? await nodePathRangeSource(argument)
    : blobRangeSource(new Blob([fixture, `\n% synthetic ${index} `, "x".repeat((index * 7919) % 131072), "\n"]));
  const observed = { ...source, async read(offset, length) {
    reads += 1; readBytes += length; largestRead = Math.max(largestRead, length);
    return source.read(offset, length);
  } };
  let terminal;
  for await (const line of estimator.profileSourceJsonl(observed)) {
    firstOutputMs ??= performance.now() - started;
    outputBytes += Buffer.byteLength(line);
    const record = JSON.parse(line);
    if (record.t === "end") terminal = record;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    peakWasm = Math.max(peakWasm, estimator.health().memoryBytes);
  }
  if (!terminal?.complete) throw new Error("incomplete synthetic scale run");
  pages += terminal.inventoryPages; deep += terminal.deepMeasured;
  const elapsed = performance.now() - fileStarted;
  histogram[buckets.findIndex((limit) => elapsed <= limit)] += 1;
  if (mode === "large") console.log(JSON.stringify({ t: "profile-end", result: terminal }));
  if ((index + 1) % 500 === 0) console.log(JSON.stringify({ t: "progress", files: index + 1, elapsedMs: Math.round(performance.now() - started), peakRss, peakWasm }));
}
console.log(JSON.stringify({ t: "benchmark", mode, files: count, inventoryPages: pages, deepMeasured: deep,
  observedAt: new Date().toISOString(),
  moduleSha256, moduleBytes: moduleBytes.byteLength,
  elapsedMs: Math.round(performance.now() - started), firstOutputMs: Math.round(firstOutputMs), reads, readBytes, largestRead,
  outputBytes, peakRss, peakWasm, latencyHistogram: { upperMs: buckets.map((v) => Number.isFinite(v) ? v : "infinity"), counts: histogram },
  methodology: mode === "large" ? "one retained immutable file handle; sparse synthetic image" : "independent synthetic Blob snapshots; reused WASM instance; sequential bounded queue" }));
