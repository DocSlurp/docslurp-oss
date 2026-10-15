import { readdirSync } from "node:fs";
import { extractNativePdf } from "./extract.js";
import { loadNativePdfEngine } from "./loader.js";
const l: any = await loadNativePdfEngine(); if (!l.ok) throw new Error(l.reason);
const D = "/path/to/eval-data/eval-suite/inputs/"; const tally: Record<string, string[]> = {}; let pages = 0, ms = 0;
for (const f of readdirSync(D).filter((x) => x.endsWith(".pdf"))) {
  let key = "ok";
  try { const r = await extractNativePdf(l.engine, D + f); pages += r.pageCount; ms += r.totalMs; }
  catch (e: any) { key = e.code ?? "ERR"; }
  (tally[key] ??= []).push(f);
}
for (const [k, v] of Object.entries(tally)) console.log(k, v.length, k === "ok" ? "" : v.join(", "));
console.log("pages", pages, "ms", Math.round(ms), "pages/min", Math.round(pages / (ms / 60000)));
