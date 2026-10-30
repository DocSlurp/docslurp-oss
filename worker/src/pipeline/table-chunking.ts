import { parseFragment, type DefaultTreeAdapterTypes as Tree } from "parse5";

type Record = { label: string; value: string };
const STRUCTURE = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption"]);
const INLINE = new Set(["br", "b", "strong", "em", "i", "span", "code", "sub", "sup"]);

/** JSON string payloads cannot introduce raw HTML or Markdown structure. */
function encode(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/** Keep every source character for unsupported HTML, explicitly without inferred geometry. */
function* recordsAsChunks(source: string, maxChars: number, tableIndex: number): Generator<string> {
  if (maxChars < 128) throw new RangeError("HTML table chunks require maxChars >= 128");
  if (source.length <= maxChars) { yield source; return; }
  const records = readCells(source) ?? [{ label: "unparsed source", value: source }];
  for (const record of records) {
    let part = 1;
    let offset = 0;
    do {
      const prefix = `[Table ${tableIndex} ${record.label} part ${part}]\n`;
      const capacity = maxChars - prefix.length - 2; // JSON quotes
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
      yield prefix + encode(value);
      part++;
    } while (offset < record.value.length);
  }
}

/** Pack complete records without slicing their identity or JSON payload. */
export function* tableChunks(source: string, maxChars: number, tableIndex: number): Generator<string> {
  let current = "";
  for (const record of recordsAsChunks(source, maxChars, tableIndex)) {
    if (current && current.length + 2 + record.length > maxChars) { yield current; current = ""; }
    current += (current ? "\n\n" : "") + record;
  }
  if (current) yield current;
}

function readCells(source: string): Record[] | null {
  // Bound parser repair cost before parsing, and geometry cost separately below.
  if (source.length > 262_144 || (source.match(/</g)?.length ?? 0) > 8192) return null;
  let invalid = false;
  const root = parseFragment(source, { onParseError: () => { invalid = true; } });
  const tables = root.childNodes.filter(n => "tagName" in n && n.tagName === "table");
  if (invalid || tables.length !== 1 || root.childNodes.some(n => !("tagName" in n && n.tagName === "table") && !(n.nodeName === "#text" && !(n as Tree.TextNode).value.trim()))) return null;
  const records: Record[] = [];
  const blockedUntil = new Map<number, number>();
  let row = 0;
  let column = 1;
  let work = 0;
  function charge() { if (++work > 100_000) throw new Error("geometry limit"); }
  function text(node: Tree.Node, depth: number): string {
    charge();
    if (depth > 32) throw new Error("depth limit");
    if (node.nodeName === "#text") return (node as Tree.TextNode).value;
    if (!("tagName" in node) || !INLINE.has(node.tagName)) throw new Error("unsupported cell content");
    if (node.attrs.length) throw new Error("unsupported inline attributes");
    if (node.tagName === "br") return "\n";
    return node.childNodes.map(n => text(n, depth + 1)).join("");
  }
  function visit(node: Tree.Node, parent: string, depth: number) {
    charge();
    if (depth > 32) throw new Error("depth limit");
    if (node.nodeName === "#text" && !(node as Tree.TextNode).value.trim()) return;
    if (!("tagName" in node) || !STRUCTURE.has(node.tagName)) throw new Error("unsupported structure");
    const tag = node.tagName;
    if (tag === "table" && parent !== "root") throw new Error("nested table");
    if (tag === "tr") { row++; column = 1; }
    if (tag === "td" || tag === "th" || tag === "caption") {
      if (tag !== "caption" && (parent !== "tr" || row === 0)) throw new Error("cell outside row");
      let rowspan = 1, colspan = 1;
      for (const attr of node.attrs) {
        if (attr.name !== "rowspan" && attr.name !== "colspan") throw new Error("unsupported attributes");
        if (!/^[1-9][0-9]*$/.test(attr.value) || Number(attr.value) > 2048) throw new Error("unsupported span");
        if (attr.name === "rowspan") rowspan = Number(attr.value); else colspan = Number(attr.value);
      }
      const value = node.childNodes.map(n => text(n, depth + 1)).join("");
      if (tag === "caption") { records.push({ label: "caption", value }); return; }
      while ((blockedUntil.get(column) ?? 0) >= row) { charge(); column++; }
      if (column + colspan > 2049 || row > 8192) throw new Error("grid limit");
      for (let c = column; c < column + colspan; c++) {
        charge();
        if ((blockedUntil.get(c) ?? 0) >= row) throw new Error("overlapping spans");
        blockedUntil.set(c, row + rowspan - 1);
      }
      records.push({ label: `row ${row} column ${column} rowspan ${rowspan} colspan ${colspan}`, value });
      column += colspan;
      return;
    }
    if (node.attrs.length) throw new Error("unsupported structure attributes");
    if (tag === "table") {
      let rank = -1;
      for (const child of node.childNodes) {
        if (!("tagName" in child)) continue;
        const next = child.tagName === "thead" ? 0 : child.tagName === "tbody" || child.tagName === "tr" ? 1 : child.tagName === "tfoot" ? 2 : -1;
        if (next >= 0) { if (next < rank) throw new Error("out of order row groups"); rank = next; }
      }
    }
    for (const child of node.childNodes) visit(child, tag, depth + 1);
    if (["thead", "tbody", "tfoot"].includes(tag) && [...blockedUntil.values()].some(end => end > row)) {
      throw new Error("rowspan exceeds row group");
    }
  }
  try { visit(tables[0]!, "root", 0); } catch { return null; }
  return records.length ? records : null;
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
