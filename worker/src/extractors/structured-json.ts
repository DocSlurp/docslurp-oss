/**
 * In-process JSON / JSON Lines → searchable Markdown.
 *
 * Every scalar in the input is kept in the output (until the output budget is
 * reached) so keyword and hybrid search can find it:
 * - objects render as headings plus `key.path: value` lines,
 * - arrays of similar objects render as Markdown tables (split into bounded
 *   row blocks), with overlong or nested cell values listed below the table,
 * - JSON Lines render one section per record; unparseable lines are skipped
 *   and listed at the end.
 *
 * The output never contains form feeds, so page splitting behaves like other
 * plain-text formats.
 */
import { readFile, stat, writeFile } from "node:fs/promises";

export interface StructuredJsonOptions {
  /** Hard cap on Markdown characters emitted; a truncation note follows. */
  maxOutputChars?: number;
  /** Rows per table block; larger arrays render as several blocks. */
  maxTableRows?: number;
  /** Arrays whose flattened records need more columns fall back to key paths. */
  maxTableColumns?: number;
  /** Longer cell values are shortened in the table and listed in full below it. */
  maxCellChars?: number;
  /** Maximum heading nesting below the section level before switching to key paths. */
  maxHeadingDepth?: number;
  /** Skipped JSONL lines listed individually; the rest are counted. */
  maxSkippedLinesListed?: number;
}

export interface StructuredJsonResult {
  markdown: string;
  format: "json" | "jsonl";
  recordCount: number;
  skippedLines: Array<{ line: number; error: string }>;
  truncated: boolean;
}

export const STRUCTURED_JSON_DEFAULTS: Required<StructuredJsonOptions> = {
  maxOutputChars: 2_000_000,
  maxTableRows: 100,
  maxTableColumns: 16,
  maxCellChars: 120,
  maxHeadingDepth: 3,
  maxSkippedLinesListed: 50,
};

/** Refuse to buffer inputs past this size; JSON.parse needs the whole text. */
export const STRUCTURED_JSON_MAX_INPUT_BYTES = 128 * 1024 * 1024;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

class OutputBudgetExceeded extends Error {}

class BoundedWriter {
  private readonly parts: string[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  line(text = ""): void {
    const piece = `${text}\n`;
    if (this.size + piece.length > this.limit) {
      this.truncated = true;
      throw new OutputBudgetExceeded();
    }
    this.parts.push(piece);
    this.size += piece.length;
  }

  toString(): string {
    return this.parts.join("");
  }
}

export class StructuredJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredJsonError";
  }
}

function isObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: Json): value is null | boolean | number | string {
  return value === null || typeof value !== "object";
}

const IDENTIFIER = /^[A-Za-z_$][\w$-]*$/;

function joinPath(base: string, key: string): string {
  const segment = IDENTIFIER.test(key) ? key : `[${JSON.stringify(key)}]`;
  return appendPath(base, segment);
}

/** Append an already-formatted relative path (`a.b`, `["x y"]`) to `base`. */
function appendPath(base: string, relative: string): string {
  if (!base) return relative;
  return relative.startsWith("[") ? `${base}${relative}` : `${base}.${relative}`;
}

function indexPath(base: string, index: number): string {
  return `${base}[${index}]`;
}

/** Strip control characters (notably form feed, the page separator). */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
}

function scalarText(value: null | boolean | number | string): string {
  if (typeof value === "string") return value === "" ? '""' : clean(value);
  return JSON.stringify(value);
}

function emptyContainerText(value: Json): string | null {
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (isObject(value) && Object.keys(value).length === 0) return "{}";
  return null;
}

function codePath(path: string): string {
  return path.includes("`") ? `\`\` ${path} \`\`` : `\`${path}\``;
}

/** A list item whose multi-line value keeps every line inside the item. */
function keyValueLine(path: string, text: string): string {
  const label = path ? `${codePath(path)}: ` : "";
  return `- ${label}${text.split("\n").join("\n  ")}`;
}

/** Short scalar arrays read better on one line; long ones get one item per line. */
function inlineList(values: Json[]): string | null {
  const text = values.map((item) => scalarText(item as never)).join(", ");
  return text.length <= 200 && !text.includes("\n") ? text : null;
}

function cellText(text: string): string {
  return text.replace(/\n+/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

class Renderer {
  constructor(
    private readonly out: BoundedWriter,
    private readonly options: Required<StructuredJsonOptions>,
  ) {}

  /** Render one top-level value (a JSON document or JSONL record) at heading level `level`. */
  section(value: Json, path: string, level: number): void {
    if (isScalar(value)) {
      this.out.line(keyValueLine(path, scalarText(value)));
      return;
    }
    const empty = emptyContainerText(value);
    if (empty) {
      this.out.line(keyValueLine(path, empty));
      return;
    }
    if (Array.isArray(value)) {
      this.array(value, path, level);
      return;
    }
    this.object(value, path, level);
  }

  private headingAllowed(level: number): boolean {
    return level <= Math.min(6, 1 + this.options.maxHeadingDepth);
  }

  private heading(level: number, path: string): void {
    this.out.line();
    this.out.line(`${"#".repeat(level)} ${path}`);
    this.out.line();
  }

  private object(value: JsonObject, path: string, level: number): void {
    const nested: Array<[string, Json]> = [];
    for (const [key, child] of Object.entries(value)) {
      const childPath = joinPath(path, key);
      if (isScalar(child)) {
        this.out.line(keyValueLine(childPath, scalarText(child)));
      } else if (emptyContainerText(child)) {
        this.out.line(keyValueLine(childPath, emptyContainerText(child)!));
      } else if (Array.isArray(child) && child.every(isScalar) && inlineList(child) !== null) {
        this.out.line(keyValueLine(childPath, inlineList(child)!));
      } else {
        nested.push([childPath, child]);
      }
    }
    for (const [childPath, child] of nested) {
      if (!this.headingAllowed(level)) {
        this.keyPaths(child, childPath);
        continue;
      }
      this.heading(level, childPath);
      if (Array.isArray(child)) this.array(child, childPath, level + 1);
      else this.object(child as JsonObject, childPath, level + 1);
    }
  }

  private array(value: Json[], path: string, level: number): void {
    if (value.every(isScalar)) {
      value.forEach((item, index) => this.out.line(keyValueLine(indexPath(path, index), scalarText(item as never))));
      return;
    }
    const columns = this.tableColumns(value);
    if (columns) {
      this.table(value as JsonObject[], columns, path);
      return;
    }
    value.forEach((item, index) => {
      const itemPath = indexPath(path, index);
      if (isScalar(item) || emptyContainerText(item) || !this.headingAllowed(level)) {
        this.keyPaths(item, itemPath);
        return;
      }
      this.heading(level, itemPath);
      if (Array.isArray(item)) this.array(item, itemPath, level + 1);
      else this.object(item as JsonObject, itemPath, level + 1);
    });
  }

  /** Every scalar under `value` as a `path: value` list item. */
  private keyPaths(value: Json, path: string): void {
    if (isScalar(value)) {
      this.out.line(keyValueLine(path, scalarText(value)));
      return;
    }
    const empty = emptyContainerText(value);
    if (empty) {
      this.out.line(keyValueLine(path, empty));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.keyPaths(item, indexPath(path, index)));
      return;
    }
    for (const [key, child] of Object.entries(value)) this.keyPaths(child, joinPath(path, key));
  }

  /** Flattened column paths for records; arrays stay whole as one cell. */
  private recordCells(record: JsonObject, prefix = "", into = new Map<string, Json>()): Map<string, Json> {
    for (const [key, child] of Object.entries(record)) {
      const column = joinPath(prefix, key);
      if (isObject(child) && Object.keys(child).length > 0) this.recordCells(child, column, into);
      else into.set(column, child);
    }
    return into;
  }

  /** Columns when `value` is an array of similar objects, otherwise null. */
  private tableColumns(value: Json[]): string[] | null {
    if (value.length < 2 || !value.every((item) => isObject(item) && Object.keys(item).length > 0)) return null;
    const order: string[] = [];
    const seen = new Set<string>();
    let filled = 0;
    for (const item of value) {
      const cells = this.recordCells(item as JsonObject);
      filled += cells.size;
      for (const column of cells.keys()) {
        if (seen.has(column)) continue;
        seen.add(column);
        order.push(column);
        if (order.length > this.options.maxTableColumns) return null;
      }
    }
    // Similar records share most columns; sparse unions read better as key paths.
    return filled / (value.length * order.length) >= 0.5 ? order : null;
  }

  private table(records: JsonObject[], columns: string[], path: string): void {
    const { maxTableRows, maxCellChars } = this.options;
    for (let start = 0; start < records.length; start += maxTableRows) {
      const block = records.slice(start, start + maxTableRows);
      const end = start + block.length;
      if (records.length > maxTableRows) {
        this.out.line();
        this.out.line(`_${path || "records"} rows ${start + 1}–${end} of ${records.length}_`);
      }
      this.out.line();
      this.out.line(`| # | ${columns.map(cellText).join(" | ")} |`);
      this.out.line(`| --- | ${columns.map(() => "---").join(" | ")} |`);
      const overflow: Array<[string, Json]> = [];
      block.forEach((record, offset) => {
        const index = start + offset;
        const cells = this.recordCells(record);
        const row = columns.map((column) => {
          if (!cells.has(column)) return "";
          const cell = cells.get(column)!;
          const cellPath = appendPath(indexPath(path, index), column);
          let text: string;
          if (isScalar(cell)) text = scalarText(cell);
          else if (emptyContainerText(cell)) text = emptyContainerText(cell)!;
          else if (Array.isArray(cell) && cell.every(isScalar)) text = cell.map((item) => scalarText(item as never)).join(", ");
          else {
            overflow.push([cellPath, cell]);
            return `${plural(Array.isArray(cell) ? cell.length : Object.keys(cell).length, "item")} (below)`;
          }
          if (text.length > maxCellChars || text.includes("\n")) {
            overflow.push([cellPath, cell]);
            return `${cellText(text.slice(0, maxCellChars).trimEnd())}…`;
          }
          return cellText(text);
        });
        this.out.line(`| ${index + 1} | ${row.join(" | ")} |`);
      });
      if (overflow.length > 0) {
        this.out.line();
        for (const [cellPath, cell] of overflow) {
          if (Array.isArray(cell) && cell.every(isScalar)) {
            this.out.line(keyValueLine(cellPath, cell.map((item) => scalarText(item as never)).join(", ")));
          } else {
            this.keyPaths(cell, cellPath);
          }
        }
      }
    }
  }
}

function describeParseError(error: unknown, text: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const position = Number(/position (\d+)/.exec(message)?.[1]);
  if (!Number.isFinite(position) || /line \d+ column \d+/.test(message)) return message;
  const before = text.slice(0, position);
  const line = before.split("\n").length;
  const column = position - before.lastIndexOf("\n");
  return `${message} (line ${line} column ${column})`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Convert JSON or JSONL text to Markdown. Throws StructuredJsonError on malformed JSON. */
export function structuredJsonToMarkdown(input: string, options: StructuredJsonOptions = {}): StructuredJsonResult {
  const settings = { ...STRUCTURED_JSON_DEFAULTS, ...options };
  const text = input.replace(/^﻿/, "");
  if (text.trim() === "") throw new StructuredJsonError("structured-json: input is empty");

  let format: "json" | "jsonl" = "json";
  let records: Array<{ value: Json; line?: number }>;
  const skippedLines: Array<{ line: number; error: string }> = [];
  try {
    records = [{ value: JSON.parse(text) as Json }];
  } catch (error) {
    const lines = text.split("\n");
    const nonEmpty = lines.filter((line) => line.trim() !== "").length;
    const parsed: Array<{ value: Json; line: number }> = [];
    if (nonEmpty >= 2) {
      lines.forEach((raw, index) => {
        const line = raw.trim();
        if (!line) return;
        try {
          parsed.push({ value: JSON.parse(line) as Json, line: index + 1 });
        } catch (lineError) {
          skippedLines.push({ line: index + 1, error: lineError instanceof Error ? lineError.message : String(lineError) });
        }
      });
    }
    if (parsed.length === 0) {
      throw new StructuredJsonError(`structured-json: malformed JSON: ${describeParseError(error, text)}`);
    }
    format = "jsonl";
    records = parsed;
  }

  const out = new BoundedWriter(settings.maxOutputChars);
  const renderer = new Renderer(out, settings);
  let rendered = 0;
  try {
    if (format === "jsonl") {
      const summary = [`JSON Lines`, plural(records.length, "record")];
      if (skippedLines.length > 0) summary.push(`${plural(skippedLines.length, "malformed line")} skipped`);
      out.line(`_${summary.join(" · ")}_`);
      for (const [index, record] of records.entries()) {
        out.line();
        out.line(`## Record ${index + 1} (line ${record.line})`);
        out.line();
        renderer.section(record.value, "", 3);
        rendered += 1;
      }
    } else {
      renderer.section(records[0]!.value, "", 2);
      rendered = 1;
    }
  } catch (error) {
    if (!(error instanceof OutputBudgetExceeded)) throw error;
  }

  let markdown = out.toString();
  const notes: string[] = [];
  if (out.truncated) {
    notes.push(
      format === "jsonl"
        ? `_Output truncated at ${settings.maxOutputChars} characters after ${rendered} of ${records.length} records._`
        : `_Output truncated at ${settings.maxOutputChars} characters._`,
    );
  }
  if (skippedLines.length > 0) {
    notes.push("## Skipped lines", "");
    for (const skipped of skippedLines.slice(0, settings.maxSkippedLinesListed)) {
      notes.push(`- line ${skipped.line}: ${clean(skipped.error)}`);
    }
    if (skippedLines.length > settings.maxSkippedLinesListed) {
      notes.push(`- …and ${skippedLines.length - settings.maxSkippedLinesListed} more`);
    }
  }
  if (notes.length > 0) markdown = `${markdown.trimEnd()}\n\n${notes.join("\n")}\n`;

  return {
    markdown: `${markdown.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`,
    format,
    recordCount: records.length,
    skippedLines,
    truncated: out.truncated,
  };
}

/** Read a JSON/JSONL file, convert it, and write Markdown to `outputPath`. */
export async function extractStructuredJsonFile(
  sourcePath: string,
  outputPath: string,
  options: StructuredJsonOptions = {},
  signal?: AbortSignal,
): Promise<StructuredJsonResult> {
  const { size } = await stat(sourcePath);
  if (size > STRUCTURED_JSON_MAX_INPUT_BYTES) {
    throw new StructuredJsonError(
      `structured-json: input is ${size} bytes; the in-process limit is ${STRUCTURED_JSON_MAX_INPUT_BYTES} bytes`,
    );
  }
  signal?.throwIfAborted();
  const result = structuredJsonToMarkdown(await readFile(sourcePath, "utf8"), options);
  signal?.throwIfAborted();
  await writeFile(outputPath, result.markdown, "utf8");
  return result;
}
