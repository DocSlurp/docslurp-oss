// Parser-VM guest entry: count a text file's pages with the shared text rule. Input is the staged source, options and output are JSON.
import { readFile, stat, writeFile } from "node:fs/promises";
import { measureTextPagesFile, parseTextPagesOptions } from "../dist/lib/text-pages-guest.js";
const [input, config, output] = process.argv.slice(2);
if ((await stat(config)).size > 1024) throw new Error("text pages options exceed limit");
const result = await measureTextPagesFile(input, parseTextPagesOptions(JSON.parse(await readFile(config, "utf8"))));
await writeFile(output, JSON.stringify(result), { mode: 0o600 });
