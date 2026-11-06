import { HTML_TABLE_MAX_SOURCE_CHARS, HTML_TABLE_MAX_TAGS } from "./html-table-limits.js";
import { parseFragment, type DefaultTreeAdapterTypes as Tree } from "parse5";
export interface HtmlTableCell { label: string; value: string; header?: boolean }
const STRUCTURE = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption"]);
const INLINE = new Set(["br", "b", "strong", "em", "i", "span", "code", "sub", "sup"]);
export function readTableCells(source: string): HtmlTableCell[] | null {
  // Bound parser repair cost before parsing, and geometry cost separately below.
  if (source.length > HTML_TABLE_MAX_SOURCE_CHARS || (source.match(/</g)?.length ?? 0) > HTML_TABLE_MAX_TAGS) return null;
  let invalid = false;
  const root = parseFragment(source, { onParseError: () => { invalid = true; } });
  const tables = root.childNodes.filter(n => "tagName" in n && n.tagName === "table");
  if (invalid || tables.length !== 1 || root.childNodes.some(n => !("tagName" in n && n.tagName === "table") && !(n.nodeName === "#text" && !(n as Tree.TextNode).value.trim()))) return null;
  const records: HtmlTableCell[] = [];
  const blockedUntil = new Map<number, number>();
  let row = 0;
  let column = 1;
  let work = 0;
  function charge() { if (++work > 1_000_000) throw new Error("geometry limit"); }
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
      records.push({ label: `row ${row} column ${column} rowspan ${rowspan} colspan ${colspan}`, value, header: tag === "th" });
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
