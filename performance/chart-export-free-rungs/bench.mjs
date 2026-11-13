#!/usr/bin/env node
// Benchmark for the free chart-export rungs (office-chart-xml, embedded-spec, svg-geometry).
//
//   node bench.mjs guest  <fixtures> <arm-dir> <out.json> [runs=7]
//   node bench.mjs inproc <fixtures> <arm-dir> <out.json> [iters=20]
//
// <arm-dir> holds a built `dist/` and `scripts/chart-export-extract.mjs` (the worker package itself, or a copy under
// worker/ so `@docslurp/shared` still resolves). `guest` runs the parser-VM guest script as a fresh process per
// document, exactly as the VM runs it (one process per source file, one per document's Doppler figure batch), and
// records wall, CPU and peak RSS. `inproc` calls the guest entry repeatedly in one process (hot-path CPU per input).
// Each workload's output is hashed so arms can be checked for byte-identical results.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [mode, fixtures, armDir, outPath, nArg] = process.argv.slice(2);
if (!["guest", "inproc"].includes(mode) || !fixtures || !armDir || !outPath) {
  console.error("usage: bench.mjs guest|inproc <fixtures> <arm-dir> <out.json> [n]");
  process.exit(2);
}
const here = path.dirname(new URL(import.meta.url).pathname);
const files = (dir, re) => {
  const d = path.join(fixtures, dir);
  try { return readdirSync(d, { recursive: true }).filter((f) => re.test(f)).sort().map((f) => path.join(d, f)); } catch { return []; }
};
const pdfPages = (name) => {
  const txt = readFileSync(path.join(fixtures, "pdf", name), "latin1");
  return (txt.match(/\/Type\s*\/Page\b/g) ?? []).length;
};
const pptxSlides = (file) => {
  // Count slide parts by name in the central directory (no extraction needed for a page count).
  const s = readFileSync(file, "latin1");
  return new Set(s.match(/ppt\/slides\/slide\d+\.xml/g) ?? []).size;
};

/** One workload = one guest run, as production issues it. `pages` is the document's page count for throughput. */
const workloads = [];
for (const f of files("office", /\.(xlsx|pptx|docx)$/)) workloads.push({ id: `office/${path.basename(f)}`, kind: "office", inputs: [f], pages: /\.pptx$/.test(f) ? pptxSlides(f) : 1, set: "office" });
for (const f of files("html", /\.html$/)) workloads.push({ id: `html/${path.basename(f)}`, kind: "html", inputs: [f], pages: 1, set: "embedded" });
for (const f of files("json", /\.json$/)) workloads.push({ id: `json/${path.basename(f)}`, kind: "json", inputs: [f], pages: 1, set: "embedded" });
for (const f of [...files("svg", /\.svg$/), ...files("vega", /\.svg$/)]) workloads.push({ id: path.relative(fixtures, f), kind: "svg", inputs: [f], pages: 1, set: "svg-upload" });
for (const name of ["report", "single"]) {
  const figs = files(`doppler-${name}`, /\.svg$/);
  if (figs.length) workloads.push({ id: `doppler-${name}`, kind: "svg", inputs: figs, batch: true, pages: pdfPages(`vector-charts-${name}.pdf`), set: "doppler-figures" });
}
for (const f of files("adversarial", /\.(svg|html)$/)) workloads.push({ id: `adversarial/${path.basename(f)}`, kind: /\.html$/.test(f) ? "html" : "svg", inputs: [f], pages: 1, set: "adversarial" });

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

const results = [];
if (mode === "guest") {
  // Several arms (comma-separated) are interleaved run by run, so load drift on the host hits every arm alike.
  const runs = Number(nArg ?? 7);
  const arms = armDir.split(",");
  const work = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "chart-bench-"));
  const req = path.join(work, "req.json");
  const out = path.join(work, "out.json");
  const ru = path.join(work, "ru.json");
  for (const w of workloads) {
    writeFileSync(req, JSON.stringify({ kind: w.kind, diagrams: true, ...(w.batch ? { batch: w.inputs.length } : {}) }));
    const per = arms.map(() => ({ samples: [], hash: null, fail: null, parsed: null }));
    for (let r = 0; r < runs; r++) {
      for (let a = 0; a < arms.length; a++) {
        const st = per[(a + r) % arms.length];
        const arm = arms[(a + r) % arms.length];
        if (st.fail) continue;
        rmSync(out, { force: true });
        const [first, ...rest] = w.inputs;
        const t0 = process.hrtime.bigint();
        const p = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(here, "rusage.mjs")).href, path.join(arm, "scripts", "chart-export-extract.mjs"), first, req, out, ...rest], { env: { ...process.env, BENCH_RUSAGE: ru }, encoding: "utf8" });
        const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
        if (p.status !== 0) { st.fail = (p.stderr || "").split("\n").find((l) => /Error/.test(l)) ?? `exit ${p.status}`; continue; }
        const u = JSON.parse(readFileSync(ru, "utf8"));
        const raw = readFileSync(out);
        const h = sha(raw);
        if (st.hash && h !== st.hash) { st.fail = "nondeterministic-output"; continue; }
        st.hash = h;
        st.parsed ??= JSON.parse(raw.toString("utf8"));
        st.samples.push({ wallMs, cpuMs: u.userMs + u.systemMs, maxRssKb: u.maxRssKb });
      }
    }
    const bytes = w.inputs.reduce((s, f) => s + statSync(f).size, 0);
    per.forEach((st, a) => {
      const list = st.parsed ? (st.parsed.results ?? [st.parsed]) : [];
      const visuals = list.reduce((s, r) => s + r.visuals.length, 0);
      const specs = list.reduce((s, r) => s + r.visuals.filter((v) => v.spec).length, 0);
      const refusals = list.flatMap((r) => r.refusals.map((x) => x.reason));
      const sm = st.samples;
      results.push({
        arm: arms[a], id: w.id, set: w.set, kind: w.kind, inputs: w.inputs.length, bytes, pages: w.pages, hash: st.hash, fail: st.fail, visuals, specs, refusals,
        wallMs: sm.map((s) => s.wallMs), cpuMs: sm.map((s) => s.cpuMs), maxRssKb: sm.map((s) => s.maxRssKb),
        medWallMs: median(sm.map((s) => s.wallMs)), medCpuMs: median(sm.map((s) => s.cpuMs)), maxRssMb: Math.max(...sm.map((s) => s.maxRssKb)) / 1024,
      });
    });
    const line = per.map((st) => `cpu ${median(st.samples.map((s) => s.cpuMs)).toFixed(0).padStart(5)} rss ${(Math.max(...st.samples.map((s) => s.maxRssKb)) / 1024).toFixed(0).padStart(4)} ${st.hash ?? st.fail}`).join(" | ");
    process.stderr.write(`${w.id.padEnd(40)} ${line}\n`);
  }
  rmSync(work, { recursive: true, force: true });
} else {
  const iters = Number(nArg ?? 20);
  const { extractDeterministicVisuals } = await import(pathToFileURL(path.join(armDir, "dist", "chart-export", "extractors", "index.js")).href);
  for (const w of workloads) {
    const inputs = w.inputs.map((f) => (w.kind === "office" || w.kind === "epub" ? { kind: w.kind, bytes: readFileSync(f) } : { kind: w.kind, text: readFileSync(f, "utf8") }));
    const once = () => inputs.map((input) => { try { return extractDeterministicVisuals(input, { diagrams: true }); } catch { return { refused: "extract-failed" }; } });
    const hash = sha(JSON.stringify(once()));
    for (let k = 0; k < 3; k++) once();
    const cpu = [];
    for (let k = 0; k < iters; k++) { const c0 = process.cpuUsage(); once(); const c = process.cpuUsage(c0); cpu.push((c.user + c.system) / 1000); }
    results.push({ id: w.id, set: w.set, inputs: w.inputs.length, pages: w.pages, hash, cpuMs: cpu, medCpuMs: median(cpu) });
    process.stderr.write(`${w.id.padEnd(44)} hot cpu ${median(cpu).toFixed(2).padStart(8)} ms\n`);
  }
}
writeFileSync(outPath, JSON.stringify({ mode, armDir, node: process.version, at: new Date().toISOString(), results }, null, 1));
