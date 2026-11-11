import { readFile, stat, writeFile } from "node:fs/promises";
import { readVisionTablesBatch } from "../dist/pipeline/vision-tables-guest.js";
const [input, output] = process.argv.slice(2);
if ((await stat(input)).size > 32 * 1024 * 1024) throw new Error("vision table input exceeds limit");
const result = JSON.stringify(readVisionTablesBatch(JSON.parse(await readFile(input, "utf8"))));
if (Buffer.byteLength(result) > 64 * 1024 * 1024) throw new Error("vision table result exceeds limit");
await writeFile(output, result, { mode: 0o600 });
