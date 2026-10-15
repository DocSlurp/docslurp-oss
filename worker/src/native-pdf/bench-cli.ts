/**
 * Dev bench for the native-pdf extractor over an eval suite (catalog.json +
 * inputs/). Writes one JSON per case with raw engine Markdown, repaired
 * Markdown, Kreuzberg Markdown and shadow agreement rows; score with
 * score_reading_order.py. Usage:
 *   tsx src/native-pdf/bench-cli.ts <suiteDir> <outDir> [split=development] [--no-kreuzberg]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { assemblePageMarkdown } from "./assemble.js";
import { extractNativePdf } from "./extract.js";
import { loadNativePdfEngine } from "./loader.js";
import { runNativePdfShadow } from "./shadow.js";

const [suiteDir, outDir, split = "development"] = process.argv.slice(2);
const withKreuzberg = !process.argv.includes("--no-kreuzberg");
if (!suiteDir || !outDir) throw new Error("usage: bench-cli <suiteDir> <outDir> [split]");

const loaded = await loadNativePdfEngine();
if (!loaded.ok) throw new Error(`engine unavailable: ${loaded.reason}`);
const engine = loaded.engine;
const kreuzberg = withKreuzberg ? await import("@kreuzberg/node") : null;
const catalog = JSON.parse(await readFile(path.join(suiteDir, "catalog.json"), "utf8")) as {
  entries: Array<{ id: string; split: string; asset: { path: string; format: string } }>;
};
await mkdir(outDir, { recursive: true });
let n = 0;
for (const entry of catalog.entries) {
  if ((split !== "all" && entry.split !== split) || entry.asset.format !== "pdf") continue;
  const file = path.join(suiteDir, entry.asset.path);
  const record: Record<string, unknown> = { id: entry.id, split: entry.split };
  try {
    const doc = await engine.openPath(file);
    const raw: string[] = [];
    try {
      const count = await doc.pageCount();
      for (let i = 0; i < count; i += 1) raw.push(await doc.page(i).markdown({ tableStrategy: "lines" }));
    } finally { await doc.close(); }
    const repaired = await extractNativePdf(engine, file, { minTextPageRatio: 0 });
    record.raw = raw;
    record.assembled = repaired.pages.map((p) => p.markdown);
    record.repairs = repaired.pages.map((p) => p.repairs);
    record.warnings = repaired.pages.map((p) => p.warnings);
    record.nativeMs = repaired.totalMs;
    if (kreuzberg) {
      const started = performance.now();
      const result = await kreuzberg.extractFile(file, null, { outputFormat: "markdown", useCache: false });
      record.kreuzberg = result.content ?? "";
      record.kreuzbergMs = performance.now() - started;
      const rows = await runNativePdfShadow({
        engine, sourcePath: file, documentId: entry.id, stageName: "bench",
        referencePages: null, referenceText: String(record.kreuzberg), referenceExtractor: "kreuzberg",
      });
      record.shadow = rows.find((r) => r.scope === "document");
    }
  } catch (error) {
    record.error = `${(error as { code?: string }).code ?? "ERR"}: ${(error as Error).message}`;
  }
  await writeFile(path.join(outDir, `${entry.id}.json`), JSON.stringify(record));
  n += 1;
  console.log(entry.id, record.error ?? "ok");
}
console.log(`cases=${n}`);
