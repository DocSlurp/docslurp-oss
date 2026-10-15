#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" }
  }
});

if (!values.input || !values.output) {
  throw new Error("usage: unpdf_extract.mjs --input file.pdf --output out.json");
}

let unpdf;
try {
  unpdf = await import("unpdf");
} catch (error) {
  throw new Error(`missing dependency: npm install unpdf (${error})`);
}

const bytes = new Uint8Array(await readFile(values.input));
const pdf = await unpdf.getDocumentProxy(bytes);
const extracted = await unpdf.extractText(pdf, { mergePages: false });

await writeFile(values.output, `${JSON.stringify(extracted, null, 2)}\n`, "utf8");
