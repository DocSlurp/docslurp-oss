/**
 * Validation of model (and renderer) output before it lands in Markdown. Everything here treats the text as hostile:
 * it is shown in chat, rendered by Mermaid/Vega in the app, and may be copied into a notebook. Python is never
 * executed by DocSlurp.
 */
import type { ChartExportFormat } from "@docslurp/shared";

import { CHART_EXPORT_LIMITS } from "./config.js";
import { breakCommentDelimiters } from "./markdown.js";

export type SanitizeResult = { ok: true; text: string } | { ok: false; reason: string };

/** The body of the first fenced block, or the whole text when it has none. */
export function unfence(text: string): string {
  const trimmed = text.trim();
  const fence = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/m.exec(trimmed);
  if (fence) return fence[2]!.trim();
  const open = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*)$/.exec(trimmed);
  if (open) return open[2]!.replace(/\n(`{3,}|~{3,})\s*$/, "").trim();
  return trimmed;
}

/** Fences of three or more backticks/tildes inside a block would close it early; none is allowed in a body. */
function hasFence(text: string): boolean {
  return /(^|\n)\s*(`{3,}|~{3,})/.test(text);
}

const MERMAID_FORBIDDEN: Array<[RegExp, string]> = [
  [/%%\s*\{/, "mermaid-init-directive"],
  [/(^|\n|;)\s*click\s/i, "mermaid-click"],
  [/<\s*\/?\s*[a-z!?]/i, "mermaid-html"],
  [/javascript\s*:/i, "mermaid-script-url"],
  [/(^|\n|;)\s*(href|callback)\s/i, "mermaid-link"],
];

const MERMAID_HEADERS = /^(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|classDiagram|erDiagram|mindmap|timeline|pie|xychart-beta|gantt|journey|quadrantChart|block-beta|sankey-beta)\b/;

export function sanitizeMermaid(text: string): SanitizeResult {
  const body = unfence(text);
  if (!body) return { ok: false, reason: "empty" };
  if (hasFence(body)) return { ok: false, reason: "nested-fence" };
  for (const [pattern, reason] of MERMAID_FORBIDDEN) if (pattern.test(body)) return { ok: false, reason };
  const firstLine = body.split("\n").find((line) => line.trim() && !line.trim().startsWith("%%"))?.trim() ?? "";
  if (!MERMAID_HEADERS.test(firstLine)) return { ok: false, reason: "mermaid-unknown-diagram" };
  return { ok: true, text: body };
}

/**
 * Keys that make Vega/Vega-Lite fetch, link out or evaluate expressions: data urls, hrefs, loaders, signals,
 * parameters and selections, conditions (`test`), and any `*Expr` key (`labelExpr`, ...). Expressions are a code
 * surface in any Vega renderer a reader pastes the spec into, so none is allowed.
 */
const VEGA_FORBIDDEN_KEYS = new Set([
  "url", "href", "loader", "usermeta", "signal", "signals", "expr", "param", "params", "selection", "test", "condition",
]);

/** A field predicate (`{ field, equal | oneOf | range | lt | ... }`): no expression, no parameter. */
function isFieldPredicate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  const allowed = new Set(["field", "equal", "oneOf", "range", "lt", "lte", "gt", "gte", "valid"]);
  const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
  return typeof (value as { field?: unknown }).field === "string"
    && entries.every(([key, v]) => allowed.has(key) && (scalar(v) || (Array.isArray(v) && v.length <= 1000 && v.every(scalar))));
}

/** `transform` is allowed only as a list of field-predicate filters (the renderer's layered series). */
function transformProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return "vega-forbidden-transform";
  for (const step of value) {
    if (!step || typeof step !== "object" || Array.isArray(step)) return "vega-forbidden-transform";
    const keys = Object.keys(step);
    if (keys.length !== 1 || keys[0] !== "filter" || !isFieldPredicate((step as { filter: unknown }).filter)) return "vega-forbidden-transform";
  }
  return null;
}

function vegaProblem(value: unknown, depth = 0): string | null {
  if (depth > 32) return "vega-too-deep";
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = vegaProblem(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (VEGA_FORBIDDEN_KEYS.has(key)) return `vega-forbidden-${key}`;
      if (/Expr$/.test(key)) return "vega-forbidden-expr";
      if (key === "filter") return "vega-forbidden-filter";
      if (key === "transform") {
        const problem = transformProblem(child);
        if (problem) return problem;
        continue;
      }
      if (key === "$schema" && (typeof child !== "string" || !/^https:\/\/vega\.github\.io\/schema\/vega-lite\//.test(child))) {
        return "vega-schema";
      }
      const problem = vegaProblem(child, depth + 1);
      if (problem) return problem;
    }
  }
  return null;
}

function hasInlineData(spec: Record<string, unknown>): boolean {
  const data = spec.data as { values?: unknown } | undefined;
  if (data && Array.isArray(data.values)) return true;
  for (const key of ["layer", "concat", "hconcat", "vconcat"]) {
    const children = spec[key];
    if (Array.isArray(children) && children.length > 0 && children.every((c) => c && typeof c === "object" && hasInlineData(c as Record<string, unknown>))) return true;
  }
  return false;
}

/**
 * Vega-Lite must be one JSON object with inline data only: no `url` data sources, links, expressions or
 * transforms (expressions are a code surface). Output is re-serialised, so comments or trailing text never pass.
 */
export function sanitizeVegaLite(text: string): SanitizeResult {
  const body = unfence(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "vega-invalid-json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "vega-not-object" };
  const problem = vegaProblem(parsed);
  if (problem) return { ok: false, reason: problem };
  if (!hasInlineData(parsed as Record<string, unknown>)) return { ok: false, reason: "vega-no-inline-data" };
  // `<!--` / `-->` can only sit inside JSON strings: escaped there, the JSON parses to the same value and the text can
  // never open or close an HTML comment (a visual group marker).
  return { ok: true, text: JSON.stringify(parsed, null, 2).replace(/<!--/g, "\\u003c!--").replace(/-->/g, "--\\u003e") };
}

/** Python is text for the reader: never executed here. Only fence-breaking and size are checked. */
export function sanitizePython(text: string): SanitizeResult {
  const body = unfence(text);
  if (!body) return { ok: false, reason: "empty" };
  if (hasFence(body)) return { ok: false, reason: "nested-fence" };
  if (!/\bmatplotlib\b/.test(body)) return { ok: false, reason: "python-no-matplotlib" };
  // Comment delimiters only occur in string literals or comments: `\x21`/`\x3e` escapes keep a literal's value (and
  // read as plain text in a comment), and the text can never open or close an HTML comment.
  return { ok: true, text: body.replace(/<!--/g, "<\\x21--").replace(/-->/g, "--\\x3e") };
}

/** Spreadsheet formula injection: a text cell starting with = + - @ (or a tab/CR) is prefixed with a quote. */
function neutralizeCell(cell: string): string {
  const trimmed = cell.trim();
  if (/^[=+\-@\t\r]/.test(trimmed) && !/^[+-]?\d[\d.,eE+-]*%?$/.test(trimmed)) return `'${cell}`;
  return cell;
}

/** RFC 4180 records: quoted fields may hold commas, doubled quotes and line breaks. Null when quoting is unbalanced. */
export function parseCsvRecords(body: string): string[][] | null {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") { quoted = true; i += 1; continue; }
    if (ch === ",") { record.push(field); field = ""; i += 1; continue; }
    if (ch === "\r" || ch === "\n") {
      record.push(field);
      if (record.some((cell) => cell.trim() !== "") || record.length > 1) records.push(record);
      record = [];
      field = "";
      i += ch === "\r" && body[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted) return null;
  record.push(field);
  if (record.some((cell) => cell.trim() !== "") || record.length > 1) records.push(record);
  return records;
}

function csvField(cell: string): string {
  return /[",\r\n]/.test(cell) || /^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/**
 * CSV is parsed as RFC 4180 (quoted commas and quotes survive), every cell is checked for formula injection, and the
 * result is re-serialised, so a cell can never break out of its quotes.
 */
export function sanitizeCsv(text: string): SanitizeResult {
  const body = unfence(text);
  if (!body) return { ok: false, reason: "empty" };
  if (hasFence(body)) return { ok: false, reason: "nested-fence" };
  const records = parseCsvRecords(body);
  if (!records) return { ok: false, reason: "csv-unbalanced-quotes" };
  if (records.length < 2 || records[0]!.length < 2) return { ok: false, reason: "csv-shape" };
  const csv = records.map((record) => record.map((cell) => csvField(neutralizeCell(cell))).join(",")).join("\n");
  return { ok: true, text: breakCommentDelimiters(csv) };
}

/** Plain searchable text: no fences, no HTML, one paragraph. */
export function sanitizeDescription(text: string): SanitizeResult {
  const plain = unfence(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/`{3,}|~{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return { ok: false, reason: "empty" };
  return { ok: true, text: breakCommentDelimiters(plain.slice(0, 2000)) };
}

export function sanitizeFormatOutput(format: ChartExportFormat, text: string): SanitizeResult {
  if (text.length > CHART_EXPORT_LIMITS.maxOutputChars) return { ok: false, reason: "too-long" };
  switch (format) {
    case "mermaid": return sanitizeMermaid(text);
    case "vega-lite": return sanitizeVegaLite(text);
    case "matplotlib": return sanitizePython(text);
    case "csv": return sanitizeCsv(text);
    case "description": return sanitizeDescription(text);
  }
}
