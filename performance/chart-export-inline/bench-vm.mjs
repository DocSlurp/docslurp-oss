#!/usr/bin/env node
// Inside the VM: what inline chart extraction adds to the quarantine inspection command, against the standalone chart
// guest run it replaces. node bench-vm.mjs <pack dir> <slice dir> <runs>. Arms, interleaved per document and run:
//   plain       quarantine-inspect.mjs as today
//   inline      quarantine-inspect.mjs with charts asked for (chart-capable kinds only, as the quarantine stage asks)
//   standalone  chart-export-extract.mjs, only where #363's signal rule would boot a VM for the document
// Wall per command (fresh process each), plus the guest-reported inline ms. Prints JSON.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";

const [pack, slice, runsArg] = process.argv.slice(2);
const runs = Number(runsArg ?? 5);
const tmp = mkdtempSync("/tmp/bench-");
const KIND = { ".docx": "office", ".pptx": "office", ".xlsx": "office", ".svg": "svg", ".html": "html", ".json": "json", ".epub": "epub" };
const POLICY = { quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 10000, quarantineMaxArchiveDepth: 8, quarantineMaxTotalUncompressedBytes: 512 * 1024 * 1024, quarantineMaxSingleEntryBytes: 256 * 1024 * 1024, quarantineMaxExpansionRatio: 200 };
const node = process.execPath;
const qi = path.join(pack, "worker/scripts/quarantine-inspect.mjs");
const cx = path.join(pack, "worker/scripts/chart-export-extract.mjs");

function timed(args) {
  const t = process.hrtime.bigint();
  const r = spawnSync(node, args, { encoding: "utf8" });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (r.status !== 0) throw new Error(`${args[0]} failed: ${r.stderr.slice(0, 400)}`);
  return ms;
}

const docs = readdirSync(slice).sort().map((f) => ({ file: path.join(slice, f), name: f, kind: KIND[path.extname(f).toLowerCase()] ?? null }));
const rows = docs.map((d) => ({ name: d.name, kind: d.kind, plain: [], inline: [], standalone: [], inlineGuestMs: [], status: null, visuals: null, standaloneReason: null }));
for (let r = 0; r < runs; r += 1) {
  docs.forEach((d, i) => {
    const row = rows[i];
    const opts = (charts) => { const p = path.join(tmp, `o-${i}-${charts ? 1 : 0}.json`); writeFileSync(p, JSON.stringify({ filename: d.name, policy: POLICY, ...(charts ? { charts: { kind: d.kind, diagrams: true } } : {}) })); return p; };
    const out = path.join(tmp, `r-${i}.json`);
    const arms = r % 2 ? ["inline", "plain"] : ["plain", "inline"];
    for (const arm of arms) {
      if (arm === "plain") row.plain.push(timed([qi, d.file, opts(false), out]));
      else if (d.kind) {
        row.inline.push(timed([qi, d.file, opts(true), out]));
        const res = JSON.parse(readFileSync(out, "utf8"));
        row.status = res.charts?.status ?? "missing";
        row.visuals = res.charts?.result?.visuals?.length ?? 0;
        if (res.charts?.ms !== undefined) row.inlineGuestMs.push(res.charts.ms);
        // #363's rule (vm-extractor sourceRunReason): Office with chart parts, any SVG/JSON, HTML with embed hints.
        const html = d.kind === "html" ? readFileSync(d.file, "utf8") : "";
        row.standaloneReason = d.kind === "office" ? ((res.archive?.chartParts ?? 0) > 0 ? "office-chart-parts" : null)
          : d.kind === "svg" || d.kind === "json" ? "standalone-document"
          : d.kind === "html" ? (/vegaEmbed|Plotly\.newPlot|vega\.github\.io\/schema|<svg[\s>]/i.test(html) ? "embed-hints" : null) : null;
      } else row.inline.push(row.plain[row.plain.length - 1]);
    }
    if (row.standaloneReason) {
      const req = path.join(tmp, `q-${i}.json`);
      writeFileSync(req, JSON.stringify({ kind: d.kind }));
      row.standalone.push(timed([cx, d.file, req, path.join(tmp, `s-${i}.json`)]));
    }
  });
}
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log(JSON.stringify({ runs, cpus: (await import("node:os")).cpus().length, rows: rows.map((r) => ({ name: r.name, kind: r.kind, status: r.status, visuals: r.visuals, standaloneReason: r.standaloneReason, plainMs: med(r.plain), inlineMs: med(r.inline), standaloneMs: med(r.standalone), inlineGuestMs: med(r.inlineGuestMs), plainAll: r.plain.map(Math.round), inlineAll: r.inline.map(Math.round) })) }));
