// Parser-VM entry point; the credential-bearing worker never imports PDF.js.
import { readFile, stat, writeFile } from "node:fs/promises";
import { readPdfStructure } from "../dist/deferred/pdf-structure-guest.js";
const [input, output] = process.argv.slice(2);
if ((await stat(input)).size > 500 * 1024 * 1024) throw new Error("PDF structure input exceeds limit");
const result = JSON.stringify(await readPdfStructure(new Uint8Array(await readFile(input))));
if (Buffer.byteLength(result) > 4 * 1024 * 1024) throw new Error("PDF structure result exceeds limit");
await writeFile(output, result, { mode: 0o600 });
