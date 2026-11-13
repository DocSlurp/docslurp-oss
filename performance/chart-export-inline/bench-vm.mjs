#!/usr/bin/env node
// Inside the VM: what inline chart extraction adds to the quarantine inspection command, per start-up variant.
//   node bench-vm.mjs <name=pack dir,...> <slice dir> <runs>
// Each variant dir holds worker/scripts/quarantine-inspect.mjs (bundled) and its dist. Arms, interleaved per document and
// run (order rotated): `plain` (the first variant's quarantine-inspect without charts) and one `inline` arm per variant
// (charts asked for chart-capable kinds only, as the quarantine stage asks). Wall per command, fresh process each.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [variantsArg, slice, runsArg] = process.argv.slice(2);
const variants = variantsArg.split(",").map((v) => { const [name, dir] = v.split("="); return { name, qi: path.join(dir, "worker/scripts/quarantine-inspect.mjs") }; });
const runs = Number(runsArg ?? 5);
const tmp = mkdtempSync("/tmp/bench-");
const KIND = { ".docx": "office", ".pptx": "office", ".xlsx": "office", ".svg": "svg", ".html": "html", ".json": "json", ".epub": "epub" };
const POLICY = { quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 10000, quarantineMaxArchiveDepth: 8, quarantineMaxTotalUncompressedBytes: 512 * 1024 * 1024, quarantineMaxSingleEntryBytes: 256 * 1024 * 1024, quarantineMaxExpansionRatio: 200 };

function timed(args) {
  const t = process.hrtime.bigint();
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${args[0]} failed: ${r.stderr.slice(0, 400)}`);
  return Number(process.hrtime.bigint() - t) / 1e6;
}

const docs = readdirSync(slice).sort().map((f) => ({ file: path.join(slice, f), name: f, kind: KIND[path.extname(f).toLowerCase()] ?? null }));
const arms = ["plain", ...variants.map((v) => v.name)];
const rows = docs.map((d) => ({ name: d.name, kind: d.kind, ms: Object.fromEntries(arms.map((a) => [a, []])), answer: {} }));
for (let r = 0; r < runs; r += 1) {
  docs.forEach((d, i) => {
    const row = rows[i];
    const order = arms.map((_, k) => arms[(k + r) % arms.length]);
    for (const arm of order) {
      const out = path.join(tmp, `r-${i}.json`);
      const opts = path.join(tmp, `o-${i}.json`);
      const charts = arm !== "plain" && d.kind;
      writeFileSync(opts, JSON.stringify({ filename: d.name, policy: POLICY, ...(charts ? { charts: { kind: d.kind, diagrams: true } } : {}) }));
      const qi = arm === "plain" ? variants[variants.length - 1].qi : variants.find((v) => v.name === arm).qi;
      row.ms[arm].push(timed([qi, d.file, opts, out]));
      if (charts) {
        const res = JSON.parse(readFileSync(out, "utf8")).charts;
        row.answer[arm] = { status: res?.status ?? "missing", reason: res?.reason ?? null, visuals: res?.result?.visuals?.length ?? 0, guestMs: res?.ms ?? null };
      }
    }
  });
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(1); };
console.log(JSON.stringify({ runs, cpus: (await import("node:os")).cpus().length, variants: variants.map((v) => v.name), rows: rows.map((r) => ({ name: r.name, kind: r.kind, answer: r.answer, median: Object.fromEntries(arms.map((a) => [a, med(r.ms[a])])) })) }));
