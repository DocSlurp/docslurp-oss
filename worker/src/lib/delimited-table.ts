/** Read RFC 4180 CSV (or TSV) without losing quoted separators and line breaks. */
export function parseDelimitedRows(content: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const source = content.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      row.push(cell); rows.push(row); row = []; cell = "";
      if (char === "\r" && source[i + 1] === "\n") i++;
    } else cell += char;
  }
  if (quoted) throw new Error("Delimited file has an unterminated quoted field");
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function delimitedTableMarkdown(content: string, filename: string): string {
  const rows = parseDelimitedRows(content, filename.toLowerCase().endsWith(".tsv") ? "\t" : ",");
  if (!rows.length) return "";
  const escape = (cell: string) => cell.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
  const columns = Math.max(...rows.map(row => row.length));
  const format = (row: string[]) => `| ${Array.from({ length: columns }, (_, i) => escape(row[i] ?? "")).join(" | ")} |`;
  const header = format(rows[0]!);
  const separator = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
  const tables: string[] = [];
  const data = rows.slice(1);
  if (!data.length) return `${header}\n${separator}`;
  for (let i = 0; i < data.length; i += 50) tables.push([header, separator, ...data.slice(i, i + 50).map(format)].join("\n"));
  return tables.join("\n\n");
}
