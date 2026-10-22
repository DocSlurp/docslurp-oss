/** General Markdown repair for page transcriptions whose pipe tables lost their header delimiter row. */

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const PIPE_ROW = /^\s*\|.*\|\s*$/;

function cellCount(row: string): number {
  const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).length;
}

/**
 * Inserts a `| --- |` delimiter after the first row of a run of two or more `|`-bounded rows that has
 * none, so the run renders as a GFM table instead of literal text. Runs that already have a delimiter
 * row anywhere, single pipe lines and fenced code are left as they are.
 */
export function insertMissingTableDelimiters(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || !PIPE_ROW.test(line)) {
      out.push(line);
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && PIPE_ROW.test(lines[end]!)) end++;
    const run = lines.slice(i, end);
    out.push(...run);
    if (run.length >= 2 && !run.some((row) => DELIMITER_ROW.test(row))) {
      out.splice(out.length - run.length + 1, 0, `|${" --- |".repeat(cellCount(run[0]!))}`);
    }
    i = end;
  }
  return out.join("\n");
}
