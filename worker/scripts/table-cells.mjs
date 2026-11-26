import { HTML_TABLE_MAX_SOURCE_CHARS, HTML_TABLE_MAX_BATCH_BYTES } from "../dist/pipeline/html-table-limits.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readTableCells } from "../dist/pipeline/table-cells-guest.js";
const [input, output, singleTableOutputLimit] = process.argv.slice(2);
if ((await stat(input)).size > HTML_TABLE_MAX_BATCH_BYTES) throw new Error("HTML table input exceeds limit");
const tables = JSON.parse(await readFile(input, "utf8"));
if (!Array.isArray(tables) || tables.length > 64 || tables.some(s => typeof s !== "string" || s.length > HTML_TABLE_MAX_SOURCE_CHARS)) throw new Error("invalid table batch");
let result = JSON.stringify(tables.map(readTableCells));
if (singleTableOutputLimit !== undefined) {
  const limit = Number(singleTableOutputLimit);
  if (tables.length !== 1 || !Number.isSafeInteger(limit) || limit < 64) throw new Error("invalid table output limit");
  if (Buffer.byteLength(result) > limit) {
    // A normal oversized table can degrade on this lane. The host still enforces its transfer cap.
    result = "[null]";
    console.warn("[table-cells] output over single-table limit");
  }
}
if (Buffer.byteLength(result) > 64 * 1024 * 1024) throw new Error("HTML table result exceeds limit");
// A remote VM receives only the staged input files, so the batch's empty output directory does not exist there yet.
// Only that one directory, never its ancestors: a missing temporary project is a failure, not something to build.
await mkdir(path.dirname(output), { mode: 0o700 }).catch((error) => { if (error?.code !== "EEXIST") throw error; });
await writeFile(output, result, { mode: 0o600 });
