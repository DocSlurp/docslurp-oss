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

const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;

/**
 * The field separator of a delimited text file. `.tsv` is tab-separated; for
 * anything else the first lines vote: a delimiter wins when it splits (outside
 * quotes) the same number of fields on the most lines. Decimal commas make
 * `;` files common in Europe ("1,5;2,5"), and the comma loses there because
 * its count differs from line to line. Ties keep the comma.
 */
export function detectDelimiter(content: string, filename = ""): string {
  if (filename.toLowerCase().endsWith(".tsv")) return "\t";
  const source = content.replace(/^\uFEFF/, "");
  const counts = new Map<string, number[]>(CANDIDATE_DELIMITERS.map((delimiter) => [delimiter, [0]]));
  let quoted = false;
  let lines = 0;
  for (let i = 0; i < source.length && lines < 25; i++) {
    const char = source[i]!;
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      lines++;
      for (const list of counts.values()) list.push(0);
      continue;
    }
    const list = counts.get(char);
    if (list) list[list.length - 1]!++;
  }
  let best = ",";
  let bestScore = 0;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const perLine = counts.get(delimiter)!.filter((count, index, all) => count > 0 || index < all.length - 1);
    const modal = [...new Set(perLine.filter((count) => count > 0))]
      .map((count) => ({ count, lines: perLine.filter((value) => value === count).length }))
      .sort((a, b) => b.lines - a.lines || b.count - a.count)[0];
    if (!modal) continue;
    const score = modal.lines * 1000 + modal.count;
    if (score > bestScore) { best = delimiter; bestScore = score; }
  }
  return best;
}

/** Text of a delimited file's bytes: UTF-16 by its byte-order mark, UTF-8 when valid, otherwise Windows-1252 (the usual legacy export). */
export function decodeDelimitedBytes(data: Uint8Array): string {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

export function delimitedTableMarkdown(content: string, filename: string): string {
  const rows = parseDelimitedRows(content, detectDelimiter(content, filename));
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
