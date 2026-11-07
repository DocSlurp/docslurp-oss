import { readFile, stat, writeFile } from "node:fs/promises";
import { detectHtmlEmbeds } from "../dist/routing/html-embeds-guest.js";
const [input, output] = process.argv.slice(2);
if ((await stat(input)).size > 16 * 1024 * 1024) throw new Error("HTML source exceeds limit");
const report = JSON.stringify(detectHtmlEmbeds(await readFile(input, "utf8")));
if (Buffer.byteLength(report) > 4 * 1024 * 1024) throw new Error("HTML report exceeds limit");
await writeFile(output, report, { mode: 0o600 });
