#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    image: { type: "string" },
    labels: { type: "string" },
    model: { type: "string" },
    output: { type: "string" }
  }
});

const DEFAULT_LOCAL_TRANSFORMERSJS_DTYPE = "q8";

function resolveLocalTransformersJsDtype() {
  const value = (process.env.DOCSLURP_LOCAL_TRANSFORMERSJS_DTYPE ?? DEFAULT_LOCAL_TRANSFORMERSJS_DTYPE)
    .trim()
    .toLowerCase();

  const aliases = new Map([
    ["auto", "auto"],
    ["fp32", "fp32"],
    ["float32", "fp32"],
    ["fp16", "fp16"],
    ["float16", "fp16"],
    ["q8", "q8"],
    ["int8", "q8"],
    ["q4", "q4"]
  ]);

  return aliases.get(value) ?? DEFAULT_LOCAL_TRANSFORMERSJS_DTYPE;
}

if (!values.image || !values.labels || !values.output || !values.model?.trim()) {
  throw new Error("usage: transformers_js_classify.mjs --image page.png --labels a,b,c --model model-id --output out.json");
}

let transformers;
try {
  transformers = await import("@huggingface/transformers");
} catch (error) {
  throw new Error(`missing dependency: npm install @huggingface/transformers (${error})`);
}

const preferredDtype = resolveLocalTransformersJsDtype();
let classifier;

try {
  classifier = await transformers.pipeline("zero-shot-image-classification", values.model, { dtype: preferredDtype });
} catch (error) {
  if (preferredDtype === "fp32") {
    throw error;
  }

  classifier = await transformers.pipeline("zero-shot-image-classification", values.model, { dtype: "fp32" });
}
const labels = values.labels.split(",").map((label) => label.trim()).filter(Boolean);
const result = await classifier(values.image, labels);

await writeFile(
  values.output,
  `${JSON.stringify({ image: values.image, model: values.model, labels, result }, null, 2)}\n`,
  "utf8"
);
