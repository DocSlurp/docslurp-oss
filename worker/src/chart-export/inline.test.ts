// Inline chart extraction (DOCSLURP_CHART_EXPORT_INLINE): the real quarantine guest script with the real bundle, against
// the standalone guest; hostile workers inside the same deadline and heap bounds; host validation; and the extractor's
// use of an inline answer (no parser VM run for the source).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { barPlot, chartXml, docx, genericBar, pptx, xlsx } from "./extractors/__tests__/fixtures.js";
import { extractDeterministicVisuals } from "./extractors/index.js";
import { CHART_EXTRACT_LIMITS } from "./extractors/limits.js";
import { chartExportInlineEnabled, freeInlineMode, inlineChartsInProcess, inlineHasWork, readStoredInlineCharts, validateInlineCharts } from "./inline.js";
import { INLINE_CHART_LIMITS, INLINE_MIN_REMAINING_MS, INLINE_STEP_TAIL_MS, inlineChartPlan, inlineDeadlineMs, inlineStepBudget, scriptTypes } from "./inline-guest.js";
import { createVmDeterministicVisualExtractor } from "./vm-extractor.js";
import { inlineChartRequest } from "../stages/quarantine.js";

const run = promisify(execFile);
const workerRoot = fileURLToPath(new URL("../../", import.meta.url));
const built = existsSync(path.join(workerRoot, "dist/chart-export/guest.bundle.mjs")) && existsSync(path.join(workerRoot, "dist/chart-export/inline-guest.js"));
if (process.env.CI && !built) throw new Error("CI must build the worker before the worker tests: the chart guest bundle is missing");

const POLICY = {
  quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 10_000, quarantineMaxArchiveDepth: 8,
  quarantineMaxTotalUncompressedBytes: 512 * 1024 * 1024, quarantineMaxSingleEntryBytes: 256 * 1024 * 1024, quarantineMaxExpansionRatio: 200,
};
const Q = ["Q1", "Q2", "Q3"];
const chart = chartXml({ title: "Bookings growth", plots: [barPlot([{ name: "Revenue", cats: Q, vals: [10, 14, 19] }])] });
const VEGA = { $schema: "https://vega.github.io/schema/vega-lite/v5.json", title: "Flights to London", data: { values: [{ q: "Q1", n: 120 }, { q: "Q2", n: 150 }] }, mark: "bar", encoding: { x: { field: "q", type: "nominal" }, y: { field: "n", type: "quantitative" } } };

const FILES: Array<{ name: string; kind: "office" | "svg" | "html" | "json"; bytes: () => Uint8Array }> = [
  { name: "earnings.xlsx", kind: "office", bytes: () => xlsx("Earnings", [["q", "v"], ["Q1", 10], ["Q2", 14], ["Q3", 19]], chart) },
  { name: "expansion.pptx", kind: "office", bytes: () => pptx([[1, chart], [2, chart]]) },
  { name: "report.docx", kind: "office", bytes: () => docx([chart]) },
  { name: "regions.svg", kind: "svg", bytes: () => Buffer.from(genericBar(["North", "South", "East"], [12, 18, 9], 20)) },
  { name: "flights.html", kind: "html", bytes: () => Buffer.from(`<html><body><h1>Flights</h1><script>vegaEmbed("#v", ${JSON.stringify(VEGA)});</script></body></html>`) },
  { name: "spec.json", kind: "json", bytes: () => Buffer.from(JSON.stringify(VEGA)) },
];

describe.skipIf(!built)("inline charts in the quarantine guest (real scripts, real bundle)", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "chart-inline-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  async function inspect(name: string, bytes: Uint8Array, charts?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tag = Math.random().toString(36).slice(2);
    const input = path.join(dir, `${tag}-${name}`);
    const options = path.join(dir, `${tag}-options.json`);
    const output = path.join(dir, `${tag}-out.json`);
    await writeFile(input, bytes);
    await writeFile(options, JSON.stringify({ filename: name, policy: POLICY, ...(charts ? { charts } : {}) }));
    await run(process.execPath, [path.join(workerRoot, "scripts/quarantine-inspect.mjs"), input, options, output], { cwd: workerRoot });
    return JSON.parse(await readFile(output, "utf8"));
  }

  async function standalone(kind: string, bytes: Uint8Array): Promise<unknown> {
    const tag = Math.random().toString(36).slice(2);
    const input = path.join(dir, `${tag}-in`);
    const request = path.join(dir, `${tag}-req.json`);
    const output = path.join(dir, `${tag}-res.json`);
    await writeFile(input, bytes);
    await writeFile(request, JSON.stringify({ kind }));
    await run(process.execPath, [path.join(workerRoot, "scripts/chart-export-extract.mjs"), input, request, output], { cwd: workerRoot });
    return JSON.parse(await readFile(output, "utf8"));
  }

  for (const file of FILES) {
    // A host at load ~100 can overrun the 0.5 s deadline (the VM takes 2-5 ms), hence the retries.
    it(`${file.name}: inline result equals the standalone guest and the in-process path; the inspection is unchanged`, { timeout: 60_000, retry: 2 }, async () => {
      const bytes = file.bytes();
      const [withCharts, without, alone] = await Promise.all([inspect(file.name, bytes, { kind: file.kind, diagrams: true }), inspect(file.name, bytes), standalone(file.kind, bytes)]);
      const charts = withCharts.charts as { status: string; result: { visuals: unknown[] } };
      expect(charts.status).toBe("ok");
      expect(charts.result.visuals.length).toBeGreaterThan(0);
      expect(charts.result).toEqual(alone);
      expect(validateInlineCharts(charts)).toMatchObject({ status: "ok", result: alone });
      const { charts: _drop, ...inspection } = withCharts;
      expect(inspection).toEqual(without);
      const inProcess = inlineChartsInProcess(Buffer.from(bytes), { kind: file.kind, diagrams: true }, without as never);
      expect(inProcess.status === "ok" && inProcess.result).toEqual(alone);
    });
  }

  it("an Office file without chart parts and plain HTML are skipped by the guest's own measurement (no worker)", async () => {
    const plainDocx = await inspect("plain.docx", docx([]), { kind: "office", diagrams: true });
    expect(plainDocx.charts).toEqual({ status: "skipped", reason: "no-chart-parts" });
    const plainHtml = await inspect("plain.html", Buffer.from("<html><body><p>Annual report: record bookings.</p></body></html>"), { kind: "html", diagrams: true });
    expect(plainHtml.charts).toEqual({ status: "skipped", reason: "no-signal" });
    // The host's declared kind cannot make the guest read a ZIP as text or text as a package.
    const lying = await inspect("x.svg", xlsx("S", [["q", "v"], ["A", 1]], chart), { kind: "svg", diagrams: true });
    expect(lying.charts).toEqual({ status: "skipped", reason: "not-text" });
    const lyingOffice = await inspect("x.xlsx", Buffer.from(genericBar(["A"], [1], 2)), { kind: "office", diagrams: true });
    expect(lyingOffice.charts).toEqual({ status: "skipped", reason: "archive-refused" });
  }, 60_000);

  it("an oversized text input is skipped, never parsed", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x20);
    big.write("<svg>", 0);
    const out = await inspect("big.svg", big, { kind: "svg", diagrams: true });
    expect(out.charts).toEqual({ status: "skipped", reason: "input-too-large" });
  }, 60_000);

  it("generates no code at run time in the worker, under the host's V8 flag (council r2 H1)", { timeout: 60_000, retry: 2 }, async () => {
    // The real worker script, wrapped so the Function constructor is counted in the worker thread from before the bundle
    // loads, run from a parent started as the host starts the quarantine command.
    const wrapper = path.join(dir, `count-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(wrapper, `import { parentPort } from "node:worker_threads";
const Real = Function; let calls = 0;
globalThis.Function = new Proxy(Real, { construct(t, a) { calls++; return Reflect.construct(t, a); }, apply(t, h, a) { calls++; return Reflect.apply(t, h, a); } });
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (m, t) => post(m && m.t === "result" ? { ...m, result: { ...m.result, calls } } : m, t);
await import(${JSON.stringify(pathToFileURL(path.join(workerRoot, "scripts/chart-export-worker.mjs")).href)});
`);
    const svgFile = path.join(dir, `count-${Math.random().toString(36).slice(2)}.svg`);
    await writeFile(svgFile, genericBar(["London", "Tokyo", "Austin"], [4, 6, 9], 10));
    const driver = `const { inlineCharts } = await import(${JSON.stringify(pathToFileURL(path.join(workerRoot, "scripts/chart-inline.mjs")).href)});
const { readFile } = await import("node:fs/promises");
const out = await inlineCharts(await readFile(${JSON.stringify(svgFile)}), { kind: "svg", diagrams: true },
  { sniffed: { encoding: "utf-8", container: null }, archive: null }, ${JSON.stringify(svgFile)}, new URL(${JSON.stringify(pathToFileURL(wrapper).href)}));
console.log(JSON.stringify({ status: out.status, calls: out.result?.calls, visuals: out.result?.visuals?.length }));`;
    // A file, not `-e`: worker threads inherit the parent's flags, and `--input-type` would break their loading.
    const driverFile = path.join(dir, `driver-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(driverFile, driver);
    const { stdout } = await run(process.execPath, ["--disallow-code-generation-from-strings", driverFile], { cwd: workerRoot });
    expect(JSON.parse(stdout)).toEqual({ status: "ok", calls: 0, visuals: 1 });
    // And the flag does reach the worker: code generation from strings throws there.
    const probe = path.join(dir, `eval-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(probe, `import { parentPort } from "node:worker_threads"; let blocked = false; try { new Function("return 1")(); } catch { blocked = true; } parentPort.postMessage(String(blocked));`);
    const check = path.join(dir, `check-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(check, `import { Worker } from "node:worker_threads"; const w = new Worker(${JSON.stringify(probe)}); w.once("message", (m) => { console.log(m); w.terminate(); });`);
    expect((await run(process.execPath, ["--disallow-code-generation-from-strings", check])).stdout.trim()).toBe("true");
  });

  describe("unit containment (#364's worker): a hostile unit loses only itself, never the inspection", () => {
    // The production bundle compiles the fault hooks out (#364 council r9 L3): these tests run the same guest scripts
    // beside a bundle built with them in, as #364's own containment tests do.
    let hooked: string;
    beforeAll(async () => {
      hooked = path.join(dir, "hooked");
      await mkdir(path.join(hooked, "scripts"), { recursive: true });
      await mkdir(path.join(hooked, "dist/chart-export/extractors"), { recursive: true });
      for (const f of ["chart-inline.mjs", "chart-export-worker.mjs", "chart-export-extract.mjs"]) await copyFile(path.join(workerRoot, "scripts", f), path.join(hooked, "scripts", f));
      for (const f of ["inline-guest.js", "extractors/limits.js"]) await copyFile(path.join(workerRoot, "dist/chart-export", f), path.join(hooked, "dist/chart-export", f));
      const { build } = await import("esbuild");
      await build({
        entryPoints: [path.join(workerRoot, "dist/chart-export/extractors/guest-entry.js")],
        outfile: path.join(hooked, "dist/chart-export/guest.bundle.mjs"),
        bundle: true, platform: "node", format: "esm", logLevel: "silent", absWorkingDir: workerRoot,
        define: { __CHART_GUEST_TEST_HOOKS__: "true" },
      });
    }, 60_000);
    const deck = () => pptx([[1, chart], [2, chartXml({ title: "Expansion to Tokyo", plots: [barPlot([{ name: "Flights", cats: Q, vals: [3, 5, 8] }])] })]]);
    const officeInspection = (bytes: Uint8Array) => ({ sniffed: { encoding: null, container: "zip" }, archive: { kind: "zip", suspicious: false, inspectable: true, chartParts: 2, entryCount: 10 } });
    async function contained(bytes: Uint8Array, kind: string, fault: string | null, workerUrl?: URL): Promise<Record<string, unknown>> {
      const file = path.join(dir, `unit-${Math.random().toString(36).slice(2)}`);
      await writeFile(file, bytes);
      const { inlineCharts } = await import(pathToFileURL(path.join(fault ? hooked : workerRoot, "scripts/chart-inline.mjs")).href);
      const inspection = kind === "office" ? officeInspection(bytes) : { sniffed: { encoding: "utf-8", container: null }, archive: null };
      if (fault) process.env.DOCSLURP_CHART_GUEST_TEST_FAULT = fault;
      try {
        return await inlineCharts(Buffer.from(bytes), { kind, diagrams: true }, inspection, file, ...(workerUrl ? [workerUrl] : []));
      } finally {
        delete process.env.DOCSLURP_CHART_GUEST_TEST_FAULT;
      }
    }
    async function standaloneWith(bytes: Uint8Array, kind: string, fault: string): Promise<unknown> {
      const tag = Math.random().toString(36).slice(2);
      const input = path.join(dir, `${tag}-in`);
      const request = path.join(dir, `${tag}-req.json`);
      const output = path.join(dir, `${tag}-res.json`);
      await writeFile(input, bytes);
      await writeFile(request, JSON.stringify({ kind }));
      await run(process.execPath, [path.join(hooked, "scripts/chart-export-extract.mjs"), input, request, output], { cwd: workerRoot, env: { ...process.env, DOCSLURP_CHART_GUEST_TEST_FAULT: fault } });
      return JSON.parse(await readFile(output, "utf8"));
    }
    it.each([["crash", "unit-crashed"], ["oom", "unit-crashed"]])("a unit that %ss is lost alone and counted; the other chart stands; the same as the standalone guest", async (fault, reason) => {
      const bytes = deck();
      const out = await contained(bytes, "office", `${fault}:chart2`);
      expect(out.status).toBe("ok");
      const result = (out as { result: { visuals: unknown[]; deferred?: Array<{ reason: string; count: number }> } }).result;
      expect(result.visuals).toHaveLength(1);
      expect(result.deferred).toEqual([expect.objectContaining({ reason, count: 1 })]);
      expect(validateInlineCharts(out)).toMatchObject({ status: "ok" });
      expect(result).toEqual(await standaloneWith(bytes, "office", `${fault}:chart2`));
    }, 60_000);
    it("the production bundle ignores the fault variable: nothing is lost", async () => {
      const file = path.join(dir, `prod-${Math.random().toString(36).slice(2)}`);
      const bytes = deck();
      await writeFile(file, bytes);
      const { inlineCharts } = await import(pathToFileURL(path.join(workerRoot, "scripts/chart-inline.mjs")).href);
      process.env.DOCSLURP_CHART_GUEST_TEST_FAULT = "crash:chart2";
      try {
        const out = await inlineCharts(Buffer.from(bytes), { kind: "office", diagrams: true }, officeInspection(bytes), file);
        expect((out as { result: { visuals: unknown[]; deferred?: unknown } }).result.visuals).toHaveLength(2);
        expect((out as { result: { deferred?: unknown } }).result.deferred).toBeUndefined();
      } finally {
        delete process.env.DOCSLURP_CHART_GUEST_TEST_FAULT;
      }
    }, 60_000);
    it("a slow inspection refuses the charts (command-budget) instead of timing out quarantine (council #369 L4)", async () => {
      const hang = path.join(dir, `hang-${Math.random().toString(36).slice(2)}.mjs`);
      await writeFile(hang, `import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => { for (;;); });`);
      const { inlineCharts } = await import(pathToFileURL(path.join(workerRoot, "scripts/chart-inline.mjs")).href);
      const inspection = { sniffed: { encoding: "utf-8", container: null }, archive: null };
      const svgBytes = Buffer.from(genericBar(["A", "B"], [1, 2], 3));
      const svg = path.join(dir, `late-${Math.random().toString(36).slice(2)}.svg`);
      await writeFile(svg, svgBytes);
      // The inspection took 36 s of the command: too little left to start a worker.
      const started = Date.now();
      const out = await inlineCharts(svgBytes, { kind: "svg", diagrams: true }, inspection, svg, pathToFileURL(hang), null, { commandStartedAt: performance.now() - 36_000 });
      expect(out).toEqual({ status: "refused", reason: "command-budget", ms: 0 });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(inlineHasWork(validateInlineCharts(out))).toBe(true);
      // 33.5 s in: the step starts, but a hanging worker is cut at the command cutoff, not at the step's own (longer) end.
      const big = Buffer.concat([svgBytes, Buffer.alloc(2 * 1024 * 1024, 0x20)]);
      const bigFile = path.join(dir, `late-big-${Math.random().toString(36).slice(2)}.svg`);
      await writeFile(bigFile, big);
      const remaining = INLINE_CHART_LIMITS.commandCutoffMs - 33_500;
      expect(INLINE_CHART_LIMITS.startupMs + inlineDeadlineMs(big.length)).toBeGreaterThan(remaining + 2_500);
      const clamped = await inlineCharts(big, { kind: "svg", diagrams: true }, inspection, bigFile, pathToFileURL(hang), null, { commandStartedAt: performance.now() - 33_500 });
      expect(clamped).toMatchObject({ status: "refused", reason: "deadline" });
      expect((clamped as { ms: number }).ms).toBeGreaterThanOrEqual(remaining - 100);
      expect((clamped as { ms: number }).ms).toBeLessThanOrEqual(remaining + INLINE_STEP_TAIL_MS + 500);
    }, 30_000);
    it("the compile cache is used only read-only, and handed to every worker (#364 compileCacheDir, council r10)", async () => {
      const { readOnlyCompileCache } = await import(pathToFileURL(path.join(workerRoot, "scripts/chart-inline.mjs")).href);
      const cache = path.join(dir, `cache-${Math.random().toString(36).slice(2)}`);
      await mkdir(path.join(cache, "v24-x64-hash-1"), { recursive: true });
      await writeFile(path.join(cache, "v24-x64-hash-1", "entry"), "x");
      // Writable by this process: never used (a run could write what another document's run loads).
      expect(readOnlyCompileCache(cache)).toBeNull();
      const { chmod } = await import("node:fs/promises");
      await chmod(path.join(cache, "v24-x64-hash-1", "entry"), 0o444);
      await chmod(path.join(cache, "v24-x64-hash-1"), 0o555);
      await chmod(cache, 0o555);
      try {
        // Root can write anything: the guard refuses it there too (the parser VM runs commands unprivileged).
        expect(readOnlyCompileCache(cache)).toBe(process.getuid?.() === 0 ? null : cache);
        expect(readOnlyCompileCache(path.join(dir, "missing"))).toBeNull();
        const echo = path.join(dir, `cache-echo-${Math.random().toString(36).slice(2)}.mjs`);
        await writeFile(echo, `import { parentPort, workerData } from "node:worker_threads";
parentPort.on("message", () => parentPort.postMessage({ t: "result", result: { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [], cache: workerData?.compileCacheDir ?? null } }));`);
        const svg = path.join(dir, `cache-${Math.random().toString(36).slice(2)}.svg`);
        await writeFile(svg, "<svg/>");
        const { inlineCharts } = await import(pathToFileURL(path.join(workerRoot, "scripts/chart-inline.mjs")).href);
        const inspection = { sniffed: { encoding: "utf-8", container: null }, archive: null };
        const withCache = await inlineCharts(Buffer.from("<svg/>"), { kind: "svg", diagrams: true }, inspection, svg, pathToFileURL(echo), cache);
        expect((withCache as { result: { cache: unknown } }).result.cache).toBe(cache);
        const without = await inlineCharts(Buffer.from("<svg/>"), { kind: "svg", diagrams: true }, inspection, svg, pathToFileURL(echo), null);
        expect((without as { result: { cache: unknown } }).result.cache).toBeNull();
      } finally {
        await chmod(cache, 0o755);
        await chmod(path.join(cache, "v24-x64-hash-1"), 0o755);
      }
    }, 30_000);
    it("each worker gets the batch-wide output budget, an empty environment and the {visuals, bytes} skip map", async () => {
      const echo = path.join(dir, `echo-${Math.random().toString(36).slice(2)}.mjs`);
      await writeFile(echo, `import { parentPort } from "node:worker_threads";
parentPort.on("message", (task) => parentPort.postMessage({ t: "result", result: { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [], echo: { outputBudget: task.outputBudget, env: Object.keys(process.env).length, skip: task.skip } } }));`);
      const out = await contained(Buffer.from(genericBar(["A", "B"], [1, 2], 3)), "svg", null, pathToFileURL(echo));
      expect((out as { result: { echo: unknown } }).result.echo).toEqual({ outputBudget: INLINE_CHART_LIMITS.outputBudget, env: 0, skip: [] });
      expect(INLINE_CHART_LIMITS.outputBudget).toBeLessThan(INLINE_CHART_LIMITS.maxResultBytes);
    }, 30_000);
    it("a unit that hangs is a unit-timeout, within the step's bound; the other chart stands", async () => {
      const started = Date.now();
      const out = await contained(deck(), "office", "hang:chart2");
      expect(out.status).toBe("ok");
      const result = (out as { result: { visuals: unknown[]; deferred?: Array<{ reason: string }> } }).result;
      expect(result.visuals).toHaveLength(1);
      expect(result.deferred?.map((d) => d.reason)).toContain("unit-timeout");
      expect(Date.now() - started).toBeLessThan(INLINE_CHART_LIMITS.startupMs + INLINE_CHART_LIMITS.deadlineMaxMs + 5_000);
    }, 60_000);
    it("off-heap memory past the budget ends the worker; the unit is lost and counted, the bound held", async () => {
      const hog = path.join(dir, `hog-${Math.random().toString(36).slice(2)}.mjs`);
      await writeFile(hog, `import { parentPort } from "node:worker_threads";
parentPort.on("message", () => { parentPort.postMessage({ t: "start", id: 0, locator: "svg", svgIndex: 0 }); const keep = []; const step = () => { keep.push(Buffer.alloc(16 * 1024 * 1024, 1)); setImmediate(step); }; step(); });`);
      const before = process.memoryUsage.rss();
      const out = await contained(Buffer.from(genericBar(["A", "B"], [1, 2], 3)), "svg", null, pathToFileURL(hog));
      // The step's ceiling (twice the growth budget: each worker its own growth, council r4 L1) plus one poll's allocation.
      expect(process.memoryUsage.rss() - before).toBeLessThan((2 * INLINE_CHART_LIMITS.maxRssGrowthMb + 256) * 1024 * 1024);
      // Every worker hogs, so each unit is lost in turn until the worker cap: never a failed inspection.
      expect(["ok", "refused"]).toContain(out.status);
    }, 60_000);
    it("a worker that never reaches a unit is a refusal with a machine reason only", async () => {
      const dead = path.join(dir, `dead-${Math.random().toString(36).slice(2)}.mjs`);
      await writeFile(dead, `throw new Error("secret document text");`);
      const out = await contained(Buffer.from(genericBar(["A", "B"], [1, 2], 3)), "svg", null, pathToFileURL(dead));
      expect(out).toMatchObject({ status: "refused", reason: "worker-failed" });
      expect(JSON.stringify(out)).not.toContain("secret");
    }, 60_000);
    it("council r4 L1: a unit's memory a dead worker still holds does not end the input; a late message is ignored; a hang is capped per unit", async () => {
      // Unit 0 holds 300 MB off-heap and stalls; the supervisor ends it. Later workers (a fresh process baseline each)
      // place their units: the input is not lost as one unplaced count.
      const heavy = path.join(dir, `heavy-${Math.random().toString(36).slice(2)}.mjs`);
      await writeFile(heavy, `import { parentPort } from "node:worker_threads";
parentPort.on("message", (task) => {
  const skip = new Map(task.skip);
  const units = [0, 1, 2].filter((id) => !skip.has(id));
  for (const id of units) {
    parentPort.postMessage({ t: "start", id, locator: "svg[" + id + "]", svgIndex: id, svg: true });
    if (id === 0) { const keep = Buffer.alloc(300 * 1024 * 1024, 1); globalThis.keep = keep; for (;;); }
    parentPort.postMessage({ t: "done", id, delta: { visuals: [], refusals: [], deferred: [], overflow: 0, bytes: 0 } });
  }
  parentPort.postMessage({ t: "result", result: { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [] } });
  // A late message after the result: ignored.
  parentPort.postMessage({ t: "done", id: 9, delta: { visuals: [{ bogus: true }], refusals: [], deferred: [], overflow: 0, bytes: 1 } });
});`);
      const started = Date.now();
      const out = await contained(Buffer.from(genericBar(["A", "B"], [1, 2], 3)), "svg", null, pathToFileURL(heavy)) as { status: string; result: { visuals: unknown[]; deferred?: Array<{ reason: string; svgIndex: number; count: number }> } };
      expect(out.status).toBe("ok");
      // Only unit 0 is lost (a per-unit timeout, well inside the step), units 1-2 completed, nothing unplaced.
      expect(out.result.deferred).toEqual([{ svgIndex: 0, count: 1, reason: "unit-timeout" }]);
      expect(out.result.visuals).toEqual([]);
      expect(Date.now() - started).toBeLessThan(INLINE_CHART_LIMITS.startupMs + 2 * INLINE_CHART_LIMITS.deadlineBaseMs + 5_000);
    }, 60_000);
    it("a compile cache inherited through NODE_COMPILE_CACHE refuses the charts; the inspection stands (#364)", async () => {
      const tag = Math.random().toString(36).slice(2);
      const input = path.join(dir, `${tag}.svg`);
      const options = path.join(dir, `${tag}-options.json`);
      const output = path.join(dir, `${tag}-out.json`);
      await writeFile(input, genericBar(["North", "South"], [4, 6], 8));
      await writeFile(options, JSON.stringify({ filename: "c.svg", policy: POLICY, charts: { kind: "svg", diagrams: true } }));
      await run(process.execPath, [path.join(workerRoot, "scripts/quarantine-inspect.mjs"), input, options, output], { cwd: workerRoot, env: { ...process.env, NODE_COMPILE_CACHE: path.join(dir, `inherited-${tag}`) } });
      const out = JSON.parse(await readFile(output, "utf8"));
      expect(out.charts).toEqual({ status: "refused", reason: "cache-inherited", ms: 0 });
      expect(out.sniffed).toBeTruthy();
    }, 60_000);
    it("an answer over the inline cap is fitted to it by #364's fitResult: cut and counted, never refused", async () => {
      const big = path.join(dir, `big-${Math.random().toString(36).slice(2)}.mjs`);
      await writeFile(big, `import { parentPort } from "node:worker_threads";
parentPort.on("message", () => parentPort.postMessage({ t: "result", result: { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [{ locator: "x".repeat(5 * 1024 * 1024), reason: "x" }] } }));`);
      const out = await contained(Buffer.from(genericBar(["A", "B"], [1, 2], 3)), "svg", null, pathToFileURL(big)) as { status: string; result: { refusals: unknown[]; overflow?: number } };
      expect(out.status).toBe("ok");
      expect(out.result.refusals).toEqual([]);
      expect(out.result.overflow).toBe(1);
      expect(Buffer.byteLength(JSON.stringify(out.result))).toBeLessThanOrEqual(INLINE_CHART_LIMITS.maxResultBytes);
    }, 30_000);
  });

  it("a broken inline module is a chart refusal, never a failed quarantine command (council M1)", async () => {
    // The quarantine script and a chart-inline.mjs that throws on import, next to the real dist.
    const root = await mkdtemp(path.join(dir, "broken-"));
    await mkdir(path.join(root, "scripts"));
    await symlink(path.join(workerRoot, "dist"), path.join(root, "dist"));
    await copyFile(path.join(workerRoot, "scripts/quarantine-inspect.mjs"), path.join(root, "scripts/quarantine-inspect.mjs"));
    await writeFile(path.join(root, "scripts/chart-inline.mjs"), "throw new SyntaxError('stale inline-guest.js');\n");
    const tag = Math.random().toString(36).slice(2);
    const input = path.join(dir, `${tag}.svg`);
    const options = path.join(dir, `${tag}-options.json`);
    const output = path.join(dir, `${tag}-out.json`);
    await writeFile(input, genericBar(["North", "South"], [4, 6], 8));
    await writeFile(options, JSON.stringify({ filename: "c.svg", policy: POLICY, charts: { kind: "svg", diagrams: true } }));
    await run(process.execPath, [path.join(root, "scripts/quarantine-inspect.mjs"), input, options, output]);
    const out = JSON.parse(await readFile(output, "utf8"));
    expect(out.charts).toEqual({ status: "refused", reason: "worker-failed", ms: 0 });
    expect(out.sniffed).toBeTruthy();
  }, 60_000);

  it("a chart step that kills the process leaves the inspection written (council r3 L1)", async () => {
    const root = await mkdtemp(path.join(dir, "crash-"));
    await mkdir(path.join(root, "scripts"));
    await symlink(path.join(workerRoot, "dist"), path.join(root, "dist"));
    await copyFile(path.join(workerRoot, "scripts/quarantine-inspect.mjs"), path.join(root, "scripts/quarantine-inspect.mjs"));
    await writeFile(path.join(root, "scripts/chart-inline.mjs"), "export async function inlineCharts() { process.exit(3); }\n");
    const tag = Math.random().toString(36).slice(2);
    const input = path.join(dir, `${tag}.svg`);
    const options = path.join(dir, `${tag}-options.json`);
    const output = path.join(dir, `${tag}-out.json`);
    await writeFile(input, genericBar(["North", "South"], [4, 6], 8));
    await writeFile(options, JSON.stringify({ filename: "c.svg", policy: POLICY, charts: { kind: "svg", diagrams: true } }));
    await expect(run(process.execPath, [path.join(root, "scripts/quarantine-inspect.mjs"), input, options, output])).rejects.toMatchObject({ code: 3 });
    const out = JSON.parse(await readFile(output, "utf8"));
    expect(out.sniffed).toBeTruthy();
    expect(out.charts).toBeUndefined();
    expect(existsSync(`${output}.part`)).toBe(false);
  }, 60_000);

  it("5 MiB of hostile script tags: the real quarantine command finishes and writes its inspection (council r3 H1)", async () => {
    for (const unit of ["<script ", "<script type=x "]) {
      const body = Buffer.from(unit.repeat(Math.ceil((5 * 1024 * 1024) / unit.length))).subarray(0, 5 * 1024 * 1024);
      const started = Date.now();
      const out = await inspect("page.html", body, { kind: "html", diagrams: true });
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(out.sniffed).toBeTruthy();
      expect(out.charts).toEqual({ status: "skipped", reason: "no-signal" });
    }
  }, 120_000);

  it("the worker gets the extractor's own softer deadline inside the hard one (council r3 M2)", async () => {
    const file = path.join(dir, `worker-budget-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(file, `import { parentPort } from "node:worker_threads";\nparentPort.on("message", (task) => parentPort.postMessage({ t: "result", result: { deadline: task.deadline } }));\n`);
    const svg = path.join(dir, `budget-${Math.random().toString(36).slice(2)}.svg`);
    await writeFile(svg, "<svg/>");
    const { inlineCharts } = await import(pathToFileURL(path.join(workerRoot, "scripts/chart-inline.mjs")).href);
    const before = Date.now();
    const out = await inlineCharts(Buffer.from("<svg/>"), { kind: "svg", diagrams: true }, { sniffed: { encoding: "utf-8", container: null }, archive: null }, svg, pathToFileURL(file));
    const soft = Math.floor(inlineDeadlineMs(6) * INLINE_CHART_LIMITS.softDeadlineShare) + INLINE_CHART_LIMITS.startupMs;
    const deadline = (out as { result: { deadline: number } }).result.deadline;
    expect(deadline).toBeGreaterThanOrEqual(before + soft);
    expect(deadline).toBeLessThanOrEqual(Date.now() + soft);
  }, 30_000);

  it("an SVG declared kind on a ZIP is skipped before any worker starts; the command finishes", async () => {
    const out = await inspect("x.svg", xlsx("S", [["q", "v"], ["A", 1]], chart), { kind: "svg", diagrams: true });
    expect(out.charts).toEqual({ status: "skipped", reason: "not-text" });
  }, 60_000);


});

describe("inline chart plan and host validation", () => {
  const text = { sniffed: { encoding: "utf-8", container: null }, archive: null };
  const zip = (chartParts: number, suspicious = false) => ({ sniffed: { encoding: null, container: "zip" }, archive: { kind: "zip", suspicious, inspectable: true, chartParts } });

  it("plans from the guest's own inspection", () => {
    expect(inlineChartPlan("office", zip(2), 1000, () => "")).toEqual({ run: true, packaged: true });
    expect(inlineChartPlan("office", zip(0), 1000, () => "")).toEqual({ run: false, reason: "no-chart-parts" });
    expect(inlineChartPlan("office", zip(2, true), 1000, () => "")).toEqual({ run: false, reason: "archive-refused" });
    // Every inspectable EPUB runs, SVG file or not: charts drawn inline in XHTML have no cheaper signal (council r3 M3).
    expect(inlineChartPlan("epub", zip(0), 1000, () => "")).toEqual({ run: true, packaged: true });
    expect(inlineChartPlan("epub", zip(0, true), 1000, () => "")).toEqual({ run: false, reason: "archive-refused" });
    expect(inlineChartPlan("json", text, 10, () => "  [1,2]")).toEqual({ run: false, reason: "no-signal" });
    expect(inlineChartPlan("json", text, 10, () => " {\"mark\":\"bar\",\"data\":{}}")).toEqual({ run: true, packaged: false });
    expect(inlineChartPlan("json", text, 10, () => " {\"mark\":\"bar\"}")).toEqual({ run: false, reason: "no-signal" });
    expect(inlineChartPlan("pdf", text, 10, () => "")).toEqual({ run: false, reason: "kind-unsupported" });
    expect(inlineDeadlineMs(0)).toBe(500);
    expect(inlineDeadlineMs(100 * 1024 * 1024)).toBe(10_000);
  });

  it("charges the inline step against the quarantine command's budget (council #369 L4, #383)", () => {
    const MiB = 1024 * 1024;
    // A fast inspection: the step keeps its own size-scaled budget.
    const fresh = inlineStepBudget({ now: 200, commandStartedAt: 0, sizeBytes: 4 * MiB })!;
    expect(fresh.endsAt - 200).toBe(INLINE_CHART_LIMITS.startupMs + inlineDeadlineMs(4 * MiB));
    expect(fresh.softMs).toBe(INLINE_CHART_LIMITS.startupMs + Math.floor(inlineDeadlineMs(4 * MiB) * INLINE_CHART_LIMITS.softDeadlineShare));
    // A slow inspection: the step ends at the command cutoff, its soft deadline inside it.
    const late = inlineStepBudget({ now: 33_000, commandStartedAt: 0, sizeBytes: 4 * MiB })!;
    expect(late.endsAt).toBe(INLINE_CHART_LIMITS.commandCutoffMs);
    expect(late.softMs).toBeLessThan(late.endsAt - 33_000);
    // Too little left to start a worker: no budget (the guest refuses with command-budget).
    expect(inlineStepBudget({ now: INLINE_CHART_LIMITS.commandCutoffMs - INLINE_MIN_REMAINING_MS + 1, commandStartedAt: 0, sizeBytes: 10 })).toBeNull();
    expect(inlineStepBudget({ now: INLINE_CHART_LIMITS.commandCutoffMs - INLINE_MIN_REMAINING_MS, commandStartedAt: 0, sizeBytes: 10 })).not.toBeNull();
    expect(inlineStepBudget({ now: 59_000, commandStartedAt: 0, sizeBytes: 10 })).toBeNull();
    expect(inlineStepBudget({ now: Number.NaN, commandStartedAt: 0, sizeBytes: 10 })).toBeNull();
    // Whenever the inspection finishes, the step (plus its count-only tail) ends well before the command times out.
    for (let now = 0; now <= 60_000; now += 250) {
      for (const size of [0, 1024, 4 * MiB, 100 * MiB]) {
        const budget = inlineStepBudget({ now, commandStartedAt: 0, sizeBytes: size });
        if (budget) expect(budget.endsAt + INLINE_STEP_TAIL_MS).toBeLessThanOrEqual(INLINE_CHART_LIMITS.commandTimeoutMs - 15_000);
      }
    }
    // The refusal is a valid, counted answer: the host records it as a deferral, never a silent skip.
    const refused = validateInlineCharts({ status: "refused", reason: "command-budget", ms: 0 });
    expect(refused).toEqual({ status: "refused", reason: "command-budget", ms: 0 });
    expect(inlineHasWork(refused)).toBe(true);
  });

  it("the HTML and JSON prefilters skip only files that extract nothing (council L1, M3)", () => {
    const skipped: Array<readonly ["html" | "json", string]> = [
      ["html", "<html><p>Expansion to Tokyo.</p><pre>{\"mark\":\"bar\"}</pre></html>"],
      ["json", "[{\"mark\":\"bar\"}]"],
      // An API export: an object with no $schema and no data member (classify needs one of them).
      ["json", JSON.stringify({ orders: [{ id: 1, total: 12.5 }], next: null, title: "Bookings" })],
      ["html", "{\"rows\": [1, 2, 3]}"],
      // Council r2 M-b, realistic negatives: a {"data": ...} envelope with none of the keys classify reads beside data,
      ["json", JSON.stringify({ data: { id: "42", attributes: { city: "London", bookings: 120 } }, meta: { page: 1 } })],
      // an ensure_ascii export (only non-ASCII escapes, which cannot spell an ASCII key),
      ["json", '{"city": "Z\\u00fcrich", "note": "caf\\u00e9 expansion", "bookings": 120}'],
      // and a web page whose scripts are analytics and a framework bootstrap.
      ["html", "<html><head><script async src=\"https://example.com/a.js\"></script><script>window.dataLayer=[];function gtag(){dataLayer.push(arguments)}</script>"
        + "<script type=\"application/json\" id=\"state\">{\"route\":\"/expansion\",\"user\":null}</script></head><body><p>Flights to London.</p></body></html>"],
    ];
    for (const [kind, body] of skipped) {
      expect(inlineChartPlan(kind, text, Buffer.byteLength(body), () => body)).toMatchObject({ run: false, reason: "no-signal" });
      expect(extractDeterministicVisuals({ kind, text: body }).visuals).toEqual([]);
    }
  });

  it("plans 5 MiB of hostile script tags in linear time (council r3 H1)", () => {
    const MiB5 = 5 * 1024 * 1024;
    const fill = (unit: string, prefix = "") => (prefix + unit.repeat(Math.ceil(MiB5 / unit.length))).slice(0, MiB5);
    const bodies: Array<readonly ["html" | "json", string]> = [
      ["html", fill("<script ")], ["html", fill("<script type=x ")], ["html", fill("<SCRIPT\ttype='x' ")],
      ["json", fill("<script ", "{")], ["json", fill("<script type=x ", "{")],
    ];
    for (const [kind, body] of bodies) {
      const started = performance.now();
      const plan = inlineChartPlan(kind, text, Buffer.byteLength(body), () => body);
      const took = performance.now() - started;
      // The old regexes took 7.9 s on 160 KB and hours on 5 MiB. Linear is ~10-30 ms; the bound leaves room for a loaded host.
      expect(took, `${kind} ${body.slice(0, 16)}`).toBeLessThan(1_000);
      expect(plan).toEqual({ run: false, reason: "no-signal" });
    }
    // Still a superset of the old typed-script regexes: an unclosed typed tag reaching the end of the file runs.
    expect(inlineChartPlan("html", text, 64, () => "<p><script type=\"application/vnd.plotly.v1+json\"")).toEqual({ run: true, packaged: false });
    expect(scriptTypes("<script>x</script><script type=text/plain><script src=a.json>")).toEqual({ any: true, plotly: false, xml: false, json: false });
    expect(scriptTypes("<script id=a <script type=\"application/json\">")).toMatchObject({ json: true });
    expect(scriptTypes("<Script TYPE='application/xhtml+xml'>")).toMatchObject({ xml: true });
  });

  it("runs on what the extractor reads: an HTML file that is a JSON spec, an escaped key", () => {
    const spec = JSON.stringify(VEGA);
    for (const [kind, body] of [["html", spec], ["json", spec], ["json", spec.replace("\"data\"", "\"\\u0064ata\"").replace("\"$schema\"", "\"\\u0024schema\"")]] as const) {
      expect(inlineChartPlan(kind, text, Buffer.byteLength(body), () => body)).toEqual({ run: true, packaged: false });
      expect(extractDeterministicVisuals({ kind, text: body }).visuals.length).toBeGreaterThan(0);
    }
  });

  it("compares the decoded length with the limit, as the extractor does (multibyte text)", () => {
    // 2 million three-byte characters: 6 MB of bytes but 2 M characters, under the 5 Mi-character limit.
    const body = `<svg>${"€".repeat(2_000_000)}</svg>`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(CHART_EXTRACT_LIMITS.maxTextBytes);
    expect(inlineChartPlan("svg", text, Buffer.byteLength(body), () => body)).toEqual({ run: true, packaged: false });
    // Past three bytes per allowed character, the text is too long without decoding it.
    expect(inlineChartPlan("svg", text, 3 * CHART_EXTRACT_LIMITS.maxTextBytes + 1, () => { throw new Error("decoded"); })).toEqual({ run: false, reason: "input-too-large" });
  });

  it("Office without chart parts is skipped even with SVG pictures (#363's host rule, kept on purpose)", () => {
    const deck = docx([], { "word/media/image1.svg": genericBar(["A", "B"], [1, 2], 3) });
    expect(inlineChartPlan("office", zip(0), deck.length, () => "")).toEqual({ run: false, reason: "no-chart-parts" });
    // The extractor itself would read the picture: a documented difference, not an exact skip.
    expect(extractDeterministicVisuals({ kind: "office", bytes: deck }).visuals.length).toBeGreaterThan(0);
  });

  it("refuses malformed guest answers without throwing", () => {
    expect(validateInlineCharts({ status: "ok", ms: 3, result: { schemaVersion: "chart-export-deterministic@v1", visuals: [{ source: "evil" }], refusals: [] } })).toEqual({ status: "refused", reason: "result-invalid", ms: 0 });
    expect(validateInlineCharts({ status: "skipped", reason: "because I said so" }).status).toBe("refused");
    expect(validateInlineCharts({ status: "refused", reason: "deadline", ms: 4, extra: 1 }).status).toBe("refused");
    expect(validateInlineCharts({ status: "refused", reason: "deadline", ms: 4 })).toEqual({ status: "refused", reason: "deadline", ms: 4 });
    expect(validateInlineCharts("ok")).toMatchObject({ reason: "result-invalid" });
    expect(readStoredInlineCharts({ kind: "pdf", status: "skipped", reason: "no-signal" })).toBeNull();
    expect(readStoredInlineCharts({ kind: "svg", status: "skipped", reason: "no-signal" })).toEqual({ kind: "svg", status: "skipped", reason: "no-signal" });
  });

  it("is asked for only with the flag on and an active tier, and the free tier is the inline mode", () => {
    const env = { DOCSLURP_CHART_EXPORT: "on", DOCSLURP_CHART_EXPORT_INLINE: "1" };
    const free = { chartExport: { tier: "free" } };
    expect(chartExportInlineEnabled(env)).toBe(true);
    expect(inlineChartRequest(free, "image/svg+xml", env)).toEqual({ kind: "svg", diagrams: true });
    expect(inlineChartRequest(free, "application/pdf", env)).toBeNull();
    expect(inlineChartRequest({ chartExport: { tier: "off" } }, "image/svg+xml", env)).toBeNull();
    expect(inlineChartRequest(free, "image/svg+xml", { DOCSLURP_CHART_EXPORT: "on" })).toBeNull();
    expect(freeInlineMode(free, env)).toBe(true);
    expect(freeInlineMode({ chartExport: { tier: "models" } }, env)).toBe(false);
  });
});

describe("the extractor uses the inline answer instead of a parser VM run", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const visuals = extractDeterministicVisuals({ kind: "svg", text: genericBar(["North", "South"], [4, 6], 8) });
  function extractor() {
    const runs: string[][] = [];
    const deps = {
      runner: { run: vi.fn(async (command: { args: string[] }) => { runs.push(command.args); throw new Error("no VM in this test"); }) },
      storage: { bucket: "b", getJson: vi.fn(async () => ({ figures: [] })), downloadToTempFile: vi.fn(async () => { throw new Error("no source staging expected"); }) },
      log: () => undefined,
    };
    return { runs, deps, extract: createVmDeterministicVisualExtractor(deps as never) };
  }
  const input = (inline: unknown, mimeType = "image/svg+xml") => ({
    document: { id: "d", mimeType, pageCount: 1, sourceKey: "src", sourceSha256: "a".repeat(64) },
    candidates: [], artifacts: { dopplerFiguresIndexUri: null, mediaMapUri: null }, signals: {}, inline,
  }) as never;

  it("ok: partials from the inline result, no staging, no VM run", async () => {
    const { runs, deps, extract } = extractor();
    const out = await extract(input({ kind: "svg", status: "ok", ms: 2, result: visuals }));
    expect(out.partials).toHaveLength(visuals.visuals.length);
    expect(out.partials.length).toBeGreaterThan(0);
    expect(runs).toEqual([]);
    expect(deps.storage.downloadToTempFile).not.toHaveBeenCalled();
  });

  it("skipped or refused (deadline): nothing exported, no VM run: a hostile file never earns a second, larger try", async () => {
    for (const inline of [{ kind: "svg", status: "skipped", reason: "no-signal" }, { kind: "svg", status: "refused", reason: "deadline", ms: 500 }]) {
      const { runs, deps, extract } = extractor();
      const out = await extract(input(inline));
      expect(out.partials).toEqual([]);
      expect(runs).toEqual([]);
      expect(deps.storage.downloadToTempFile).not.toHaveBeenCalled();
      // A refusal lost the whole source: recorded as a deferral (council r4 L4); a skip is no loss.
      expect(out.deferred ?? []).toEqual(inline.status === "refused" ? [{ input: "source", svgIndex: 0, count: 1, reason: "guest-unavailable", pageNumber: null, figureId: null }] : []);
    }
    // Council r4 M2: refusals and counted losses are work for the free tier (they are recorded); a clean empty answer is not.
    expect(inlineHasWork({ status: "refused", reason: "deadline", ms: 500 })).toBe(true);
    expect(inlineHasWork({ status: "ok", ms: 1, result: { ...visuals, visuals: [] } })).toBe(false);
    expect(inlineHasWork({ status: "ok", ms: 1, result: { ...visuals, visuals: [], deferred: [{ svgIndex: 0, count: 38, reason: "unit-crashed" }] } })).toBe(true);
    expect(inlineHasWork({ status: "ok", ms: 1, result: { ...visuals, visuals: [], overflow: 3 } })).toBe(true);
    expect(inlineHasWork({ status: "skipped", reason: "no-signal" })).toBe(false);
  });

  it("result-too-large and answer-missing are the refusals that go to the standalone guest", async () => {
    // answer-missing (council r4 M3): a parser image older than the inline guest gave no answer; #363's standalone
    // path takes the source, so an old image never silently skips documents.
    for (const reason of ["result-too-large", "answer-missing"]) {
      const { deps, extract } = extractor();
      // answer-missing: #363's own signal decides the standalone run (here a router candidate, as #363 needs for an SVG).
      const asked = input({ kind: "svg", status: "refused", reason, ms: 0 }) as unknown as { signals: Record<string, unknown> };
      if (reason === "answer-missing") asked.signals = { candidates: 1 };
      await extract(asked as never).catch(() => undefined);
      expect(deps.storage.downloadToTempFile, reason).toHaveBeenCalled();
      expect(inlineHasWork({ status: "refused", reason, ms: 0 } as never)).toBe(true);
    }
  });

  it("an answer for another kind is ignored (the type changed after quarantine)", async () => {
    const { deps, extract } = extractor();
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const out = await extract({ ...(input({ kind: "html", status: "ok", ms: 1, result: visuals }, xlsx) as object), signals: { officeChartParts: 1 } } as never).catch(() => null);
    // Not used as the source's answer; the source falls back to the pre-inline rule (Office chart parts -> standalone).
    expect(out?.partials ?? []).toEqual([]);
    expect(deps.storage.downloadToTempFile).toHaveBeenCalled();
  });

  it("inline mode sends no Doppler figure batch (no text in figure SVGs yet): zero VM runs for a PDF", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT_INLINE", "1");
    const { runs, extract } = extractor();
    const out = await extract({
      document: { id: "d", mimeType: "application/pdf", pageCount: 3, sourceKey: "src" },
      candidates: [], artifacts: { dopplerFiguresIndexUri: "s3://b/idx.json", mediaMapUri: null, artifactUri: () => "s3://b/f.svg" }, signals: {},
      dopplerFiguresIndex: { figures: [{ id: "f1", slot: "doppler-figure:f1", format: "svg", fileOf: "f1", page: 1, bytes: 100, bbox: [0, 0, 10, 10] }] },
    } as never);
    expect(runs).toEqual([]);
    expect(out.partials).toEqual([]);
  });
});
