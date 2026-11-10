// Parser VM only: no worker credentials enter this process.
import { readFile, stat, writeFile } from "node:fs/promises";
import { inspectQuarantineBytes } from "../dist/lib/quarantine-bytes.js";
const [input, optionsPath, output] = process.argv.slice(2);
if ((await stat(input)).size > 500 * 1024 * 1024 || (await stat(optionsPath)).size > 64 * 1024) throw new Error("quarantine input exceeds limit");
const options = JSON.parse(await readFile(optionsPath, "utf8"));
const bytes = await readFile(input);
const result = JSON.stringify(inspectQuarantineBytes(bytes, options.filename, options.policy));
if (Buffer.byteLength(result) > 2 * 1024 * 1024) throw new Error("quarantine result exceeds limit");
await writeFile(output, result, { mode: 0o600 });
