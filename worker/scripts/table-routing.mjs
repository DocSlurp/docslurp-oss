// Parser-VM guest entry: scan a document's pages' HTML tables (table repair and routing). Input and output are JSON files.
import { readFile, stat, writeFile } from "node:fs/promises";
import { enterTableScanGuest, scanTableRoutingBatch } from "../dist/pipeline/table-routing-guest.js";
enterTableScanGuest();
const [input, output] = process.argv.slice(2);
if ((await stat(input)).size > 32 * 1024 * 1024) throw new Error("table routing input exceeds limit");
const result = JSON.stringify(scanTableRoutingBatch(JSON.parse(await readFile(input, "utf8"))));
if (Buffer.byteLength(result) > 64 * 1024 * 1024) throw new Error("table routing result exceeds limit");
await writeFile(output, result, { mode: 0o600 });
