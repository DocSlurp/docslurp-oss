import { parseFragment, type DefaultTreeAdapterTypes as Tree } from "parse5";

export interface Cell { table: number; row: number; column: number; rowspan: number; colspan: number; value: string }
export interface Coverage { expected: number; recovered: number; exact: number; extras: number; valueRecall: number; topologyRecall: number; precision: number }
const key = (c: Cell) => `${c.table}/${c.row}/${c.column}`;

/** Evaluation-only canonicalization. Gold must come from the source layout before extraction. */
export function htmlCells(html: string): Cell[] {
  if (html.length > 16_000_000) throw new Error("Evaluation input exceeds 16 MB");
  const root = parseFragment(html);
  const result: Cell[] = [];
  let table = 0;
  function content(n: Tree.Node, depth = 0): string {
    if (depth > 64) throw new Error("Cell content exceeds depth limit");
    if ("tagName" in n && n.tagName === "table") throw new Error("Nested tables need separate explicit gold");
    if (n.nodeName === "#text") return (n as Tree.TextNode).value;
    if (!("childNodes" in n)) return "";
    if ("tagName" in n && n.tagName === "br") return "\n";
    return n.childNodes.map(c => content(c, depth + 1)).join("");
  }
  function walk(n: Tree.Node, depth: number) {
    if (depth > 64) throw new Error("Evaluation tree exceeds depth limit");
    if ("tagName" in n && n.tagName === "table") {
      const id = ++table; let row = 0;
      const occupied = new Map<number, number>();
      const visit = (node: Tree.Node, level: number) => {
        if (level > 32) throw new Error("Table nesting exceeds limit");
        if (!("tagName" in node)) return;
        if (node !== n && node.tagName === "table") throw new Error("Nested tables need separate explicit gold");
        if (node.tagName === "tr") {
          row++; let column = 1;
          for (const cell of node.childNodes) {
            if (!("tagName" in cell) || !["td", "th"].includes(cell.tagName)) continue;
            while ((occupied.get(column) ?? 0) >= row) column++;
            const span = (name: string) => {
              const raw = cell.attrs.find(a => a.name === name)?.value ?? "1";
              if (!/^[1-9][0-9]{0,3}$/.test(raw) || Number(raw) > 2048) throw new Error("Invalid span");
              return Number(raw);
            };
            const rowspan = span("rowspan"), colspan = span("colspan");
            if (column + colspan > 2049 || row > 8192) throw new Error("Grid limit");
            for (let c = column; c < column + colspan; c++) {
              if ((occupied.get(c) ?? 0) >= row) throw new Error("Overlapping cell spans");
              occupied.set(c, row + rowspan - 1);
            }
            result.push({table:id,row,column,rowspan,colspan,value:content(cell)});
            column += colspan;
          }
        } else for (const child of node.childNodes) visit(child, level + 1);
      };
      visit(n, 0); return;
    }
    if ("childNodes" in n) for (const child of n.childNodes) walk(child, depth + 1);
  }
  walk(root, 0); return result;
}

export function coverage(gold: Cell[], actual: Cell[]): Coverage {
  if (!gold.length || new Set(gold.map(key)).size !== gold.length) throw new Error("Gold must have unique, nonempty cells");
  const remaining = new Map<string, Cell[]>();
  for (const cell of actual) { const id=JSON.stringify([key(cell),cell.value]); const bucket=remaining.get(id) ?? []; bucket.push(cell); remaining.set(id,bucket); }
  let recovered = 0, exact = 0;
  for (const expected of gold) {
    const found = remaining.get(JSON.stringify([key(expected),expected.value]))?.pop();
    if (!found) continue;
    recovered++;
    if (found.rowspan === expected.rowspan && found.colspan === expected.colspan) exact++;
  }
  return {expected:gold.length,recovered,exact,extras:actual.length-recovered,valueRecall:recovered/gold.length,topologyRecall:exact/gold.length,precision:actual.length ? recovered/actual.length : 0};
}
