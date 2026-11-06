import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractStructuredJsonFile } from "../dist/extractors/structured-json-guest.js";
const [input, config, output] = process.argv.slice(2);
if ((await stat(config)).size > 4096) throw new Error("JSON options exceed limit");
const result = await extractStructuredJsonFile(input, path.join(path.dirname(output), "content.md"), JSON.parse(await readFile(config, "utf8")));
const json = JSON.stringify(result); if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new Error("JSON result exceeds limit");
await writeFile(output, json, { mode: 0o600 });
