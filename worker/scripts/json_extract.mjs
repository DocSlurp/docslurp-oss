#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    "chunk-size": { type: "string", default: "50" },
  },
});

if (!values.input || !values.output) {
  process.stderr.write("Usage: json_extract.mjs --input <file> --output <file> [--chunk-size N]\n");
  process.exit(1);
}

const chunkSize = Math.max(1, Number.parseInt(values["chunk-size"], 10) || 50);

/**
 * Flatten a nested object into dot-notation keys.
 * Arrays are represented as "[N items]" to keep tables readable.
 */
function flattenObject(obj, prefix = "", depth = 0) {
  if (depth > 4 || typeof obj !== "object" || obj === null) {
    return { [prefix]: obj };
  }
  const flat = {};
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      flat[newKey] = `[${value.length} items]`;
    } else if (typeof value === "object" && value !== null) {
      Object.assign(flat, flattenObject(value, newKey, depth + 1));
    } else {
      flat[newKey] = value;
    }
  }
  return flat;
}

function detectValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Build a schema summary from the first 1000 records:
 * { [key]: { types: string[], cardinality: number, nonNullCount: number } }
 */
function buildSchema(objects) {
  const schema = {};
  const sample = objects.slice(0, 1000);
  for (const obj of sample) {
    const flat = flattenObject(obj);
    for (const [key, value] of Object.entries(flat)) {
      if (!schema[key]) {
        schema[key] = { types: new Set(), cardinality: 0, nonNullCount: 0 };
      }
      schema[key].types.add(detectValueType(value));
      schema[key].cardinality++;
      if (value !== null && value !== undefined && value !== "") {
        schema[key].nonNullCount++;
      }
    }
  }
  const result = {};
  for (const [key, info] of Object.entries(schema)) {
    result[key] = {
      types: [...info.types],
      cardinality: info.cardinality,
      nonNullCount: info.nonNullCount,
    };
  }
  return result;
}

/** Render a slice of objects as a GFM markdown table (caps at 20 columns). */
function objectsToMarkdownTable(objects, columns) {
  if (objects.length === 0 || columns.length === 0) return "";
  const displayCols = columns.slice(0, 20);
  const header = `| ${displayCols.join(" | ")} |`;
  const sep = `| ${displayCols.map(() => "---").join(" | ")} |`;
  const rows = objects.map((obj) => {
    const flat = flattenObject(obj);
    return `| ${displayCols
      .map((col) => {
        const val = flat[col];
        if (val === null || val === undefined) return "";
        return String(val).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200);
      })
      .join(" | ")} |`;
  });
  return [header, sep, ...rows].join("\n");
}

/** Render a single object as a two-column key/value GFM table. */
function singleObjectToMarkdown(obj) {
  const flat = flattenObject(obj);
  const rows = Object.entries(flat)
    .map(
      ([k, v]) =>
        `| \`${k}\` | ${String(v ?? "")
          .replace(/\|/g, "\\|")
          .replace(/\n/g, " ")
          .slice(0, 500)} |`
    )
    .join("\n");
  return `| Key | Value |\n| --- | --- |\n${rows}`;
}

/** Render schema as a GFM table for the schema-summary chunk. */
function schemaToMarkdown(schema, recordCount) {
  const rows = Object.entries(schema)
    .map(
      ([key, info]) =>
        `| \`${key}\` | ${info.types.join(", ")} | ${info.nonNullCount}/${info.cardinality} |`
    )
    .join("\n");
  return (
    `## Schema Summary\n\nThis document contains **${recordCount}** record(s) ` +
    `with the following fields:\n\n| Column | Types | Non-null |\n| --- | --- | --- |\n${rows}`
  );
}

// ── Parse input ────────────────────────────────────────────────────────────────

const raw = readFileSync(values.input, "utf-8").trim();
let objects = [];
let format = "json";

if (!raw) {
  // empty file
} else {
  // Try strict JSON first
  let parseError = null;
  try {
    const parsed = JSON.parse(raw);
    objects = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    parseError = err;
  }

  // Fall back to JSONL (newline-delimited JSON objects)
  if (parseError) {
    format = "jsonl";
    objects = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

// ── Build chunks ───────────────────────────────────────────────────────────────

const chunks = [];

if (objects.length === 0) {
  chunks.push({ markdown: "_Empty document_", chunkIndex: 0, rowRange: [0, 0], metadata: {} });
} else if (objects.length === 1) {
  const markdown = singleObjectToMarkdown(objects[0]);
  chunks.push({
    markdown,
    chunkIndex: 0,
    rowRange: [0, 0],
    metadata: { type: "single-object" },
  });
} else {
  // Collect all column names in order of first appearance
  const colOrder = [];
  const colSeen = new Set();
  for (const obj of objects) {
    for (const key of Object.keys(flattenObject(obj))) {
      if (!colSeen.has(key)) {
        colSeen.add(key);
        colOrder.push(key);
      }
    }
  }

  for (let i = 0; i < objects.length; i += chunkSize) {
    const slice = objects.slice(i, i + chunkSize);
    const endIdx = Math.min(i + chunkSize - 1, objects.length - 1);
    chunks.push({
      markdown: objectsToMarkdownTable(slice, colOrder),
      chunkIndex: Math.floor(i / chunkSize),
      rowRange: [i, endIdx],
      metadata: { columns: colOrder.slice(0, 20), rowCount: slice.length },
    });
  }
}

// ── Schema summary ─────────────────────────────────────────────────────────────

const schema = objects.length > 0 ? buildSchema(objects) : {};
const schemaSummaryMarkdown =
  Object.keys(schema).length > 0 ? schemaToMarkdown(schema, objects.length) : "";

// ── Write output ───────────────────────────────────────────────────────────────

const output = {
  format,
  recordCount: objects.length,
  chunkCount: chunks.length,
  schema,
  schemaSummaryMarkdown,
  chunks,
};

writeFileSync(values.output, JSON.stringify(output, null, 2), "utf-8");
process.stdout.write(
  `extracted ${objects.length} records into ${chunks.length} chunk(s)\n`
);
