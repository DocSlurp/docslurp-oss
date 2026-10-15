#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    collection: { type: "string" }
  }
});

if (!values.input || !values.output || !values.collection) {
  throw new Error("usage: orama_write.mjs --input in.json --output out.json --collection name");
}

const payload = JSON.parse(await readFile(values.input, "utf8"));
const dir = process.env.ORAMA_PATH ?? "/tmp/docslurp-orama";
await mkdir(dir, { recursive: true });
const target = path.join(dir, `${values.collection}.json`);
await writeFile(target, JSON.stringify(payload, null, 2));
await writeFile(values.output, JSON.stringify({
  backend: "orama",
  collection: values.collection,
  records: payload.records?.length ?? 0,
  path: target
}, null, 2) + "\n");
