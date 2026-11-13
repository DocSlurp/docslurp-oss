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
import { INLINE_CHART_LIMITS, inlineChartPlan, inlineDeadlineMs } from "./inline-guest.js";
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
parentPort.postMessage = (m, t) => post(typeof m === "string" && m !== "ready" ? JSON.stringify({ ...JSON.parse(m), calls }) : m, t);
await import(${JSON.stringify(pathToFileURL(path.join(workerRoot, "scripts/chart-inline-worker.mjs")).href)});
`);
    const driver = `const { inlineCharts } = await import(${JSON.stringify(pathToFileURL(path.join(workerRoot, "scripts/chart-inline.mjs")).href)});
const out = await inlineCharts(Buffer.from(${JSON.stringify(genericBar(["London", "Tokyo", "Austin"], [4, 6, 9], 10))}), { kind: "svg", diagrams: true },
  { sniffed: { encoding: "utf-8", container: null }, archive: null }, new URL(${JSON.stringify(pathToFileURL(wrapper).href)}));
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

  describe("hostile extraction stays bounded and never fails the inspection", () => {
    // Like the real worker: say "ready" after start-up, then do the (hostile) work once the file arrives.
    // `size`: the input's size, which sets the deadline (0.5 s + 2 ms/KiB); the memory tests need time to allocate.
    async function hostile(body: string, ready = true, size = 6): Promise<Record<string, unknown>> {
      const file = path.join(dir, `worker-${Math.random().toString(36).slice(2)}.mjs`);
      await writeFile(file, `import { parentPort } from "node:worker_threads";\n${ready ? `parentPort.postMessage("ready");\nparentPort.once("message", (job) => {\n${body}\n});` : body}\n`);
      const { inlineCharts } = await import(pathToFileURL(path.join(workerRoot, "scripts/chart-inline.mjs")).href);
      const inspection = { sniffed: { encoding: "utf-8", container: null }, archive: null };
      const input = size === 6 ? Buffer.from("<svg/>") : Buffer.from(`<svg>${" ".repeat(size - 11)}</svg>`);
      return await inlineCharts(input, { kind: "svg", diagrams: true }, inspection, pathToFileURL(file));
    }
    it("a spinning extractor hits the deadline", async () => {
      const started = Date.now();
      const out = await hostile("for (;;) {}");
      expect(out).toMatchObject({ status: "refused", reason: "deadline" });
      expect(Date.now() - started).toBeLessThan(INLINE_CHART_LIMITS.startupMs + inlineDeadlineMs(6) + 2_000);
    }, 30_000);
    it("a worker that never gets ready is stopped at the start-up allowance", async () => {
      expect(await hostile("for (;;) {}", false)).toMatchObject({ status: "refused", reason: "deadline" });
    }, 30_000);
    it("a JS-heap-hungry extractor is stopped (heap limit or memory watchdog)", async () => {
      const out = await hostile("const keep = []; for (;;) keep.push(new Array(1e5).fill({ a: Math.random() }));");
      expect(out).toMatchObject({ status: "refused" });
      expect(["worker-failed", "memory-limit", "deadline"]).toContain(out.reason);
    }, 60_000);
    it("off-heap memory (Buffers) the heap limit does not see is stopped by the RSS watchdog (council M2)", async () => {
      const before = process.memoryUsage.rss();
      // 16 MiB at a time, touched so the pages are real, with a pause so the parent's watchdog gets its turn.
      const out = await hostile("const keep = []; const step = () => { const b = Buffer.alloc(16 * 1024 * 1024, 1); keep.push(b); setImmediate(step); }; step();", true, 4 * 1024 * 1024);
      expect(out).toMatchObject({ status: "refused", reason: "memory-limit" });
      // The bound held: the process grew by no more than the budget plus one poll's worth of allocation.
      expect(process.memoryUsage.rss() - before).toBeLessThan((INLINE_CHART_LIMITS.maxRssGrowthMb + 256) * 1024 * 1024);
    }, 60_000);
    it("off-heap memory allocated in one synchronous burst is stopped too, within the bound", async () => {
      const before = process.memoryUsage.rss();
      const out = await hostile("const keep = []; for (;;) keep.push(Buffer.alloc(16 * 1024 * 1024, 1));", true, 4 * 1024 * 1024);
      expect(out).toMatchObject({ status: "refused" });
      expect(["memory-limit", "worker-failed"]).toContain(out.reason);
      // Council r2 L-a: the burst never escaped the watchdog's budget (plus one poll's worth of allocation).
      expect(process.memoryUsage.rss() - before).toBeLessThan((INLINE_CHART_LIMITS.maxRssGrowthMb + 256) * 1024 * 1024);
    }, 60_000);
    it("the file is transferred to the worker, not copied", async () => {
      const out = await hostile("parentPort.postMessage(JSON.stringify({ schemaVersion: 'x', visuals: [], refusals: [], transferred: job.buffer instanceof ArrayBuffer && job.buffer.byteLength === 6 }));");
      expect(out).toMatchObject({ status: "ok", result: { transferred: true } });
    }, 30_000);
    it("a throwing extractor is a refusal with a machine reason only", async () => {
      expect(await hostile("throw new Error('secret document text');")).toMatchObject({ status: "refused", reason: "worker-failed" });
    }, 30_000);
    it("an answer over the inline allowance is refused as too large (the standalone guest takes it)", async () => {
      expect(await hostile("parentPort.postMessage('x'.repeat(5 * 1024 * 1024));")).toMatchObject({ status: "refused", reason: "result-too-large" });
    }, 30_000);
    it("non-JSON is refused", async () => {
      expect(await hostile("parentPort.postMessage('{not json');")).toMatchObject({ status: "refused", reason: "result-invalid" });
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
    // An EPUB runs only with an SVG file in it (council r2 M-b / L-b).
    expect(inlineChartPlan("epub", zip(0), 1000, () => "")).toEqual({ run: false, reason: "no-chart-parts" });
    expect(inlineChartPlan("epub", { ...zip(0), archive: { ...zip(0).archive, svgParts: 1 } }, 1000, () => "")).toEqual({ run: true, packaged: true });
    expect(inlineChartPlan("json", text, 10, () => "  [1,2]")).toEqual({ run: false, reason: "no-signal" });
    expect(inlineChartPlan("json", text, 10, () => " {\"mark\":\"bar\",\"data\":{}}")).toEqual({ run: true, packaged: false });
    expect(inlineChartPlan("json", text, 10, () => " {\"mark\":\"bar\"}")).toEqual({ run: false, reason: "no-signal" });
    expect(inlineChartPlan("pdf", text, 10, () => "")).toEqual({ run: false, reason: "kind-unsupported" });
    expect(inlineDeadlineMs(0)).toBe(500);
    expect(inlineDeadlineMs(100 * 1024 * 1024)).toBe(10_000);
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
      expect((await extract(input(inline))).partials).toEqual([]);
      expect(runs).toEqual([]);
      expect(deps.storage.downloadToTempFile).not.toHaveBeenCalled();
    }
    expect(inlineHasWork({ status: "refused", reason: "deadline", ms: 500 })).toBe(false);
    expect(inlineHasWork({ status: "ok", ms: 1, result: { ...visuals, visuals: [] } })).toBe(false);
  });

  it("result-too-large is the one refusal that goes to the standalone guest", async () => {
    const { deps, extract } = extractor();
    await extract(input({ kind: "svg", status: "refused", reason: "result-too-large", ms: 9 })).catch(() => undefined);
    expect(deps.storage.downloadToTempFile).toHaveBeenCalled();
    expect(inlineHasWork({ status: "refused", reason: "result-too-large", ms: 9 })).toBe(true);
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
