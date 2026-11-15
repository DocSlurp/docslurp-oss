// Run only inside the project's credential-free VM for external documents.
// Usage: node benchmark-real.mjs manifest.json output-directory
import { readFile, writeFile, mkdir, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { createEstimator } from "../js/index.mjs";
import { nodePathRangeSource } from "../js/range.mjs";

const [manifestPath, output] = process.argv.slice(2);
const sources = JSON.parse(await readFile(manifestPath, "utf8"));
await mkdir(output, { recursive: true });
const module = await readFile(new URL("../dist/docslurp_estimate.wasm", import.meta.url));
const initAt = performance.now();
const estimator = await createEstimator({ module });
const runtime = { t: "runtime", observedAt: new Date().toISOString(), node: process.version,
  cpu: cpus()[0]?.model, logicalCpusVisible: cpus().length, memoryVisible: totalmem(),
  moduleSha256: createHash("sha256").update(module).digest("hex"), moduleBytes: module.length,
  harnessSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
  initMs: performance.now() - initAt, repetitions: 3, options: { maxDeepPages: 1000 } };
const results = [runtime];
const save = () => writeFile(join(output, "measurements.jsonl"), results.map(x => JSON.stringify(x)).join("\n") + "\n");
await save();
// Balanced alternating order reduces monotonic warm-cache/order bias. First pass
// is separately labeled; subsequent passes reuse the WASM module and OS cache.
for (let repeat = 0; repeat < 3; repeat++) {
  const ordered = repeat % 2 ? [...sources].reverse() : sources;
  for (const source of ordered) {
    const path = join("/job/inputs", `${source.id}.pdf`);
    const bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error("input hash mismatch");
    const info = execFileSync("pdfinfo", [path], { encoding: "utf8", timeout: 30000, maxBuffer: 1048576 });
    const oraclePages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!oraclePages) throw new Error("missing independent page count");
    let end, reads = 0, readBytes = 0, outputBytes = 0, firstMs = null, peakRss = 0, peakWasm = 0;
    let header, vectors = 0, words = 0;
    const statusCounts = {}, chunks = [];
    const featureUnknown = new Set();
    const raw = await nodePathRangeSource(path);
    const observed = { ...raw, async read(offset, length) { reads++; readBytes += length; return raw.read(offset, length); } };
    const cpuAt = process.cpuUsage(), started = performance.now();
    let error;
    try {
      for await (const line of estimator.profileSourceJsonl(observed, { maxDeepPages: 1000 })) {
        firstMs ??= performance.now() - started;
        outputBytes += Buffer.byteLength(line);
        if (repeat === 0) chunks.push(line);
        const row = JSON.parse(line);
        if (row.t === "header") header = row;
        if (row.t === "end") end = row;
        if (row.t === "pages") {
          for (const page of row.inventory) statusCounts[page[4]] = (statusCounts[page[4]] ?? 0) + 1;
          for (const [, values] of row.features?.vectors ?? []) vectors += values[0] ?? 0;
          for (const [, values] of row.features?.text ?? []) words += values[0] ?? 0;
          for (const [name, entries] of Object.entries(row.features ?? {})) {
            if (["diagnostics", "work"].includes(name)) continue;
            for (const [page, values] of entries) {
              if (values.some(v => v === null) || name === "composition" && values.at(-1) !== 1) featureUnknown.add(page);
            }
          }
        }
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        peakWasm = Math.max(peakWasm, estimator.health().memoryBytes);
      }
    } catch (e) { error = String(e.message).slice(0, 1000); }
    const elapsedMs = performance.now() - started, cpu = process.cpuUsage(cpuAt);
    const validInventory = !error && end?.complete === true && end.inventoryPages === oraclePages;
    const fullDeep = validInventory && end.deepComplete === true && end.deepMeasured === oraclePages && featureUnknown.size === 0;
    const record = { t: "measurement", id: source.id, kind: source.kind, repeat, cache: repeat === 0 ? "first-pass-not-guaranteed-cold" : "warm-reused-module",
      observedAt: new Date().toISOString(), oraclePages, headerPages: header?.pages, elapsedMs, firstMs,
      cpuMs: (cpu.user + cpu.system) / 1000, validInventory, fullDeep, featureUnknownPages: featureUnknown.size, statusCounts,
      inventoryPagesPerSec: validInventory ? oraclePages * 1000 / elapsedMs : null,
      fullDeepPagesPerSec: fullDeep ? oraclePages * 1000 / elapsedMs : null,
      reads, readBytes, outputBytes, peakRss, peakWasm, vectors, words, end, error };
    // Separate native text-extraction baseline. Nonempty output and exit status
    // verify execution only, not semantic quality or faithful table structure.
    const nativePath = join(output, "native-text.txt"), nativeAt = performance.now();
    try {
      execFileSync("pdftotext", ["-layout", path, nativePath], { timeout: 30000, maxBuffer: 1048576 });
      const nativeMs = performance.now() - nativeAt;
      record.nativeTextExtraction = { tool: "pdftotext -layout", elapsedMs: nativeMs, outputBytes: (await stat(nativePath)).size, qualityValidated: false };
      await unlink(nativePath);
    } catch (e) { record.nativeTextExtraction = { error: String(e.message).slice(0, 500), qualityValidated: false }; }
    results.push(record); await save();
    if (repeat === 0) await writeFile(join(output, `${source.id}.jsonl`), chunks.join(""));
    console.log(JSON.stringify({ ...record, end: undefined }));
  }
}
