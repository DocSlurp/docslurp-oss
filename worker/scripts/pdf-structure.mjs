// Parser-VM entry point; the credential-bearing worker never imports PDF.js.
import { readFile, stat, writeFile } from "node:fs/promises";
import { readPdfStructure } from "../dist/deferred/pdf-structure-guest.js";
const [input, output] = process.argv.slice(2);
if ((await stat(input)).size > 1024 ** 3) throw new Error("PDF structure input exceeds limit");
const data = await readFile(input);
const result = JSON.stringify(await readPdfStructure(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
if (Buffer.byteLength(result) > 4 * 1024 * 1024) throw new Error("PDF structure result exceeds limit");
await writeFile(output, result, { mode: 0o600 });
