/**
 * Offline research batch for the free-feature router (eval tooling, not run by the worker): the native page probe row
 * plus document metadata and per-page font names, all read through the probe's existing binding calls.
 * Usage: tsx scripts/probe-features-batch.ts <jobs.json> <out.jsonl>
 */
import { readFileSync, writeFileSync } from "node:fs";

import { loadProbeBinding } from "../src/routing/probe/binding.js";
import { PROBE_LIMITS, probeNativePdf, type NativeProbeRow } from "../src/routing/probe/probe.js";

const [jobsPath, outPath] = process.argv.slice(2);
if (!jobsPath || !outPath) throw new Error("usage: probe-features-batch.ts <jobs.json> <out.jsonl>");
const loaded = loadProbeBinding();
if (!loaded.ok) throw new Error(loaded.reason);
const binding = loaded.binding;
const jobs = JSON.parse(readFileSync(jobsPath, "utf8")) as Array<{ id: string; path: string; pages?: string }>;
const lines: string[] = [];
for (const job of jobs) {
  const rows: NativeProbeRow[] = [];
  let error: string | null = null;
  let meta: Record<string, unknown> = {};
  const pages: Array<{ page: number; fonts: Array<{ name: string; type: string; embedded: boolean }>; spanFonts: string[] }> = [];
  try {
    // Context pages: the target pages plus up to two neighbours on each side (cross-page regime features).
    let spec: string | undefined;
    if (job.pages) {
      const doc0 = binding.openPath(job.path, { limits: PROBE_LIMITS });
      const n = doc0.pageCount();
      doc0.close();
      const want = new Set<number>();
      for (const p of job.pages.split(",").map(Number)) for (let q = p - 2; q <= p + 2; q++) if (q >= 1 && q <= n) want.add(q);
      spec = [...want].sort((a, b) => a - b).join(",");
    }
    for await (const row of probeNativePdf(binding, { pdfPath: job.path, pages: spec })) rows.push(row);
    const doc = binding.openPath(job.path, { limits: PROBE_LIMITS });
    try {
      meta = { ...doc.metadata(), pageCount: doc.pageCount() };
      for (const row of rows) {
        const i = row.pageNumber - 1;
        if (i < 0) continue;
        const spanFonts = new Set<string>();
        for (const s of doc.page(i).spans()) if (s.text.trim()) spanFonts.add(s.font);
        pages.push({ page: i + 1, fonts: doc.fonts(i).map((f) => ({ name: f.name, type: f.type, embedded: f.embedded })), spanFonts: [...spanFonts] });
      }
    } finally {
      doc.close();
    }
  } catch (e) {
    error = `${(e as { code?: string }).code ?? "Error"}: ${e instanceof Error ? e.message : String(e)}`;
  }
  lines.push(JSON.stringify({ id: job.id, targetPages: job.pages ?? null, rows, meta, pages, error }));
}
writeFileSync(outPath, lines.join("\n") + "\n");
