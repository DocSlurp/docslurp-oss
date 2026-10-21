import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { probeNativePdf } from "../../worker/src/routing/probe/probe.js";
import { loadProbeBinding } from "../../worker/src/routing/probe/binding.js";
import * as candidate from "../../worker/src/routing/probe/features.js";

const root = process.cwd();
const phase = process.argv[2] ?? "screen";
const block = Number(process.argv[3] ?? 0);
const baselineRef = "5fe9ac4e1ea4ddaf61319a271a729c0365bb1758";
const dir = path.join(root, "worker/src/routing/probe");
const require = createRequire(path.join(root, "worker/package.json"));
const sharp = require("sharp");
const scratch = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "probe-baseline-"));
const loaded = loadProbeBinding();
if (!loaded.ok) throw new Error(loaded.reason);
const binding = loaded.binding;
const names = phase === "screen"
  ? ["kreuzberg-tables-invoice.pdf", "multicolumn-figures-report.pdf"]
  : ["tables-multipage-financials.pdf", "kreuzberg-formulas-math.pdf"];
const filePaths = names.map(name => path.join(root, "worker/testdata/pdf-fixtures", name));
function oldSource(name: string) {
  return execFileSync("git", ["show", `${baselineRef}:worker/src/routing/probe/${name}.ts`], { encoding: "utf8" });
}
function imports(source: string) {
  return source.replace(/from "([^"]+)"/g, (whole, specifier) => {
    if (specifier === "./features.js") return `from ${JSON.stringify(pathToFileURL(path.join(scratch, "features.mts")).href)}`;
    if (specifier.startsWith(".")) return `from ${JSON.stringify(pathToFileURL(path.resolve(dir, specifier).replace(/\.js$/, ".ts")).href)}`;
    if (specifier === "sharp") return `from ${JSON.stringify(pathToFileURL(require.resolve("sharp")).href)}`;
    return whole;
  });
}
try {
  await writeFile(path.join(scratch, "features.mts"), oldSource("features"));
  await writeFile(path.join(scratch, "probe.mts"), imports(oldSource("probe")));
  const baseline = await import(pathToFileURL(path.join(scratch, "features.mts")).href);
  const { probeNativePdf: baselineProbe } = await import(pathToFileURL(path.join(scratch, "probe.mts")).href);
  const oldStats = (pixels: Uint8Array, w: number, h: number) => {
    const blur = baseline.laplacianVariance(pixels, w, h);
    const [p1, p99] = baseline.percentiles(pixels, [1, 99]);
    let sum = 0;
    for (const v of pixels) sum += v;
    return { blur, contrast: (p99 - p1) / 255, brightness: pixels.length ? sum / pixels.length / 255 : 0 };
  };
  const newStats = (candidate as any).grayImageStatistics ?? oldStats;
  const result: any = { phase, block, observedAt: new Date().toISOString(), baselineRef, candidateSha256: {}, node: process.version, cpu: os.cpus()[0]?.model, native: binding.version(), names, cases: [] };
  for (const name of ["probe", "features"]) result.candidateSha256[name] = createHash("sha256").update(await readFile(path.join(dir, `${name}.ts`))).digest("hex");
  async function collect(probe: typeof probeNativePdf, pdfPath: string) {
    const rows: any[] = [];
    for await (const { probeMs, ...row } of probe(binding, { pdfPath })) rows.push(row);
    assert.ok(rows.length > 0);
    assert.ok(rows.every(row => !row.unusualFeatures.includes("probe-error")));
    return rows;
  }
  for (const pdfPath of filePaths) {
    const ref = await collect(baselineProbe, pdfPath);
    assert.deepEqual(await collect(probeNativePdf, pdfPath), ref);
    // Prove semantic oracle rejects dropped pages rather than counting a skipped workload.
    assert.throws(() => assert.deepEqual(ref.slice(1), ref));
    const doc = binding.openPath(pdfPath);
    const rendered = await doc.page(0).renderAsync({ dpi: 72, gray: true, format: "png" });
    doc.close();
    const raw = await sharp(rendered).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });
    const pixels = Uint8Array.from(raw.data).filter((_: number, i: number) => i % raw.info.channels === 0);
    const expectedStats = oldStats(pixels, raw.info.width, raw.info.height);
    assert.deepEqual(newStats(pixels, raw.info.width, raw.info.height), expectedStats);
    for (let i = 0; i < 10; i++) { oldStats(pixels, raw.info.width, raw.info.height); newStats(pixels, raw.info.width, raw.info.height); }
    const entry: any = { file: path.basename(pdfPath), inputSha256: createHash("sha256").update(await readFile(pdfPath)).digest("hex"), pageCount: ref.length, semanticSha256: createHash("sha256").update(JSON.stringify(ref)).digest("hex"), exactRows: true, exactPixels: true, runs: [] };
    for (const arm of block % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      for (let i = 0; i < 3; i++) assert.deepEqual(await collect(arm === "baseline" ? baselineProbe : probeNativePdf, pdfPath), ref);
      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      const stats = arm === "baseline" ? oldStats : newStats;
      const statsCpuStart = process.cpuUsage();
      const statsStart = performance.now();
      let final;
      for (let i = 0; i < 100; i++) final = stats(pixels, raw.info.width, raw.info.height);
      const statsElapsedMs = performance.now() - statsStart;
      const statsCpu = process.cpuUsage(statsCpuStart);
      assert.deepEqual(final, expectedStats);
      entry.runs.push({ arm, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, pages: ref.length * 3, statsElapsedMs, statsCpuMs: (statsCpu.user + statsCpu.system) / 1000, statsIterations: 100 });
    }
    result.cases.push(entry);
  }
  const out = path.join(root, "performance/probe-pixel-stats-2026-10-21/raw");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, `${phase}-${block}.json`), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result.cases.map((c: any) => ({ file: c.file, runs: c.runs })), null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }
