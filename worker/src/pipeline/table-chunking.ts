import { HTML_TABLE_MAX_SOURCE_CHARS, HTML_TABLE_MAX_TAGS } from "./html-table-limits.js";
import { readTableCells } from "./table-cells-guest.js";
import { preparedHtmlTableCells } from "./html-table-vm.js";
import { vmOnlyParsing } from "../lib/vm-only-parsing.js";

type Record = { label: string; value: string; header?: boolean };

/** JSON string payloads cannot introduce raw HTML or Markdown structure. */
function encode(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/** Keep every source character for unsupported HTML, explicitly without inferred geometry. */
function* recordsAsChunks(source: string, maxChars: number, tableIndex: number, compactRecords = false): Generator<string> {
  if (maxChars < 128) throw new RangeError("HTML table chunks require maxChars >= 128");
  if (source.length <= maxChars) { yield source; return; }
  const parsed = readCells(source);
  const records = parsed ?? [{ label: "unparsed source", value: source }];
  function prefix(label: string, part: number) {
    if (!compactRecords) return `[Table ${tableIndex} ${label} part ${part}]\n`;
    const compact = label.replace(/^row (\d+) column (\d+) rowspan (\d+) colspan (\d+)$/, (_, r, c, rs, cs) =>
      `r${r} c${c}` + (rs === "1" ? "" : ` rowspan=${rs}`) + (cs === "1" ? "" : ` colspan=${cs}`));
    return `[${compact}${part === 1 ? "" : ` part=${part}`}]\n`;
  }
  for (const record of records) {
    const wholePrefix = prefix(record.label, 1);
    // Encoding can expand text; avoid allocating an unbounded fallback payload.
    if (record.value.length <= maxChars - wholePrefix.length) {
      const whole = encode(record.value);
      if (wholePrefix.length + whole.length <= maxChars) {
        yield wholePrefix + whole;
        continue;
      }
    }
    let part = 1;
    let offset = 0;
    do {
      const context = prefix(record.label, part);
      const capacity = maxChars - context.length - 2; // JSON quotes
      if (capacity < 6) throw new RangeError("Table record context exceeds chunk budget");
      let value = "";
      let encodedLength = 0;
      while (offset < record.value.length) {
        const char = String.fromCodePoint(record.value.codePointAt(offset)!);
        const point = char.codePointAt(0)!;
        const size = /[<>&]/.test(char) || (point < 32 && ![8, 9, 10, 12, 13].includes(point)) || (point >= 0xd800 && point <= 0xdfff)
          ? 6 : point < 32 || char === '"' || char === "\\" ? 2 : char.length;
        if (encodedLength + size > capacity) break;
        value += char;
        encodedLength += size;
        offset += char.length;
      }
      yield context + encode(value);
      part++;
    } while (offset < record.value.length);
  }
}

function tableLegend(index: number): string {
  return `[Table ${index} v2: r=row c=column; default rowspan,colspan,part=1; JSON]`;
}

/** Keep complete rows together and repeat bounded schema/header context. */
export function* tableChunks(source: string, maxChars: number, tableIndex: number): Generator<string> {
  if (!Number.isSafeInteger(maxChars) || maxChars < 128) throw new RangeError("HTML table chunks require maxChars >= 128");
  if (source.length <= maxChars) { yield source; return; }
  const cells = readCells(source);
  const header = cells?.filter(c => c.header).map(c =>
    `[Table ${tableIndex} context ${c.label}]\n${encode(c.value)}`).join("\n\n") ?? "";
  const context = header && header.length + 2 <= Math.floor(maxChars / 3) && maxChars - header.length - 2 >= 128 ? header + "\n\n" : "";
  const compact = cells !== null && maxChars - context.length >= 256;
  const prefix = (compact ? tableLegend(tableIndex) + "\n" : "") + context;
  const budget = maxChars - prefix.length;
  function* groups(): Generator<string> {
    let row = "", group = "";
    for (const record of recordsAsChunks(source, budget, tableIndex, compact)) {
      const identity = record.match(/(?: row |^\[r)(\d+)(?: column | c)/)?.[1] ?? "";
      if (group && (identity !== row || group.length + 2 + record.length > budget)) {
        yield group; group = "";
      }
      row = identity;
      group += (group ? "\n\n" : "") + record;
    }
    if (group) yield group;
  }
  let current = "";
  for (const item of groups()) {
    if (current && current.length + 2 + item.length > budget) { yield prefix + current; current = ""; }
    current += (current ? "\n\n" : "") + item;
  }
  if (current) yield prefix + current;
}

function readCells(source: string): Record[] | null {
  if (source.length > HTML_TABLE_MAX_SOURCE_CHARS || (source.match(/</g)?.length ?? 0) > HTML_TABLE_MAX_TAGS) return null;
  if (vmOnlyParsing()) {
    const cells = preparedHtmlTableCells(source.trim());
    if (cells === undefined) throw new Error("HTML table parsing requires parser VM precomputation");
    return cells;
  }
  return readTableCells(source);
}

/** Streaming boundary scan only; no DOM, URL loading, or geometry inference. */
export class TableBoundary {
  depth = 0;
  closed = false;
  private tag = "";
  private quote = "";
  private comment = false;
  private cdata = false;
  private tail = "";
  private raw = "";
  feed(line: string) {
    for (const char of line + "\n") {
      if (this.cdata) {
        this.tail = (this.tail + char).slice(-3);
        if (this.tail === "]]>" ) { this.cdata = false; this.tail = ""; }
        continue;
      }
      if (this.comment) {
        this.tail = (this.tail + char).slice(-3);
        if (this.tail === "-->") { this.comment = false; this.tail = ""; }
        continue;
      }
      if (!this.tag) { if (char === "<") this.tag = "<"; continue; }
      this.tag += char;
      if (this.tag === "<![CDATA[" && !this.raw) { this.cdata = true; this.tag = ""; continue; }
      if (this.tag === "<!--" && !this.raw) { this.comment = true; this.tag = ""; continue; }
      if (this.quote) { if (char === this.quote) this.quote = ""; continue; }
      if (char === '"' || char === "'") { this.quote = char; continue; }
      if (char !== ">") continue;
      const match = this.tag.match(/^<\s*(\/?)\s*([a-z][a-z0-9]*)\b/i);
      this.tag = "";
      if (!match) continue;
      const closing = !!match[1], name = match[2]!.toLowerCase();
      if (this.raw) { if (closing && name === this.raw) this.raw = ""; continue; }
      if (!closing && /^(script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/.test(name)) this.raw = name;
      if (name === "table") { this.depth += closing ? -1 : 1; this.closed = closing && this.depth <= 0; }
    }
  }
}
