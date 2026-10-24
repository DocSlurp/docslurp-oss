import { stripLeadingFrontmatter } from "./markdown-structure.js";

const MARKDOWN_TABLE_BLOCK =
  /(^|\n)(?<table>(?:\|.*\|\n)+)(?=\n|$)/g;

const DATA_URI = /data:[^,\s)"']+;base64,[a-z0-9+/=]+/gi;

export type ExtractionPlausibilitySignals = {
  plausibilityScore: number;
  charYield: number;
  averageWordLengthPlausibility: number;
  whitespacePlausibility: number;
  charCount: number;
  wordCount: number;
};

export type SanitizedExtractedMarkdown = {
  markdown: string;
  strippedDataUriCount: number;
  strippedDataUriBytes: number;
  /** Lines of a leading metadata block (`---` … `---`) removed from the body. */
  strippedFrontmatterLines: number;
};

/**
 * Binary payloads are artifacts, not document text. Keeping them in Markdown
 * corrupts yield metrics and can put megabytes of base64 into chunks/search.
 * A leading metadata block (HTML converters emit `---\ntitle: …` from
 * `<title>`/`<meta>`) is likewise dropped so it cannot become a heading,
 * a chunk or chunk context.
 */
export function sanitizeExtractedMarkdown(
  markdown: string,
): SanitizedExtractedMarkdown {
  let strippedDataUriCount = 0;
  let strippedDataUriBytes = 0;
  const body = stripLeadingFrontmatter(markdown);
  const sanitized = body.markdown.replace(DATA_URI, (match) => {
    strippedDataUriCount += 1;
    strippedDataUriBytes += Buffer.byteLength(match);
    return "artifact://externalized-data-uri";
  });

  return {
    markdown: sanitized,
    strippedDataUriCount,
    strippedDataUriBytes,
    strippedFrontmatterLines: body.strippedLines,
  };
}

/**
 * Measures whether output looks non-empty and text-like. This is deliberately
 * not calibrated extraction quality: it cannot judge correctness, reading
 * order, OCR substitutions, tables, geometry, or hallucinations.
 */
export function scoreExtractionPlausibility(
  text: string,
  pageCount: number,
): ExtractionPlausibilitySignals {
  const sanitized = sanitizeExtractedMarkdown(text).markdown;
  if (!sanitized.trim() || pageCount === 0) {
    return {
      plausibilityScore: 0,
      charYield: 0,
      averageWordLengthPlausibility: 0,
      whitespacePlausibility: 0,
      charCount: 0,
      wordCount: 0,
    };
  }
  const words = sanitized.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const charCount = sanitized.length;
  const whitespaceCount = (sanitized.match(/\s/g) ?? []).length;

  const charYield = Math.min(1, charCount / (pageCount * 500));
  const avgWordLen = wordCount > 0 ? charCount / wordCount : 0;
  const averageWordLengthPlausibility = Math.min(1, avgWordLen / 6);
  const whitespaceRatio = charCount > 0 ? whitespaceCount / charCount : 0;
  const whitespacePlausibility =
    whitespaceRatio > 0.05 && whitespaceRatio < 0.4 ? 1 : 0.5;

  return {
    plausibilityScore: Math.min(
      1,
      charYield * 0.5 +
        averageWordLengthPlausibility * 0.3 +
        whitespacePlausibility * 0.2,
    ),
    charYield,
    averageWordLengthPlausibility,
    whitespacePlausibility,
    charCount,
    wordCount,
  };
}

export function countMarkdownTables(markdown: string): number {
  return [...markdown.matchAll(MARKDOWN_TABLE_BLOCK)].length;
}

export function countHtmlTables(markdown: string): number {
  return (markdown.match(/<table[\s>]/gi) ?? []).length;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderHtmlTable(
  header: string[],
  rows: string[][],
  title?: string,
): string {
  const titleHtml = title
    ? `<thead>\n<tr><th colspan="${header.length}">${escapeHtml(title)}</th></tr>\n<tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr>\n</thead>`
    : `<thead>\n<tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr>\n</thead>`;
  const bodyHtml = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table>\n${titleHtml}\n<tbody>\n${bodyHtml}\n</tbody>\n</table>`;
}

function renderSupportingPolicyFormTable(rows: string[][]): string {
  return renderHtmlTable(
    ["Supporting Policy Form", "Supporting Policy Form"],
    rows,
  );
}

function extractHtmlCells(
  rowHtml: string,
  cellTag: "th" | "td",
): string[] {
  const matcher = new RegExp(`<${cellTag}[^>]*>([\\s\\S]*?)<\\/${cellTag}>`, "gi");
  return [...rowHtml.matchAll(matcher)]
    .map((match) => stripInlineMarkdown(match[1] ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function splitSupportFormCodes(value: string): string[] {
  const tokens = value.split(/\s+/).filter(Boolean);
  const startIndexes = tokens
    .map((token, index) =>
      /^[A-Z]{2,}\d[\w.-]*$/.test(token) ? index : -1,
    )
    .filter((index) => index >= 0);

  if (startIndexes.length <= 1) {
    return [value.trim()].filter(Boolean);
  }

  const codes: string[] = [];
  for (let index = 0; index < startIndexes.length; index += 1) {
    const start = startIndexes[index]!;
    const end = startIndexes[index + 1] ?? tokens.length;
    codes.push(tokens.slice(start, end).join(" "));
  }
  return codes;
}

function splitSupportFormDescriptions(
  value: string,
  expectedCount: number,
): string[] {
  const normalized = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  if (expectedCount <= 1) {
    return [normalized];
  }

  const words = normalized.split(" ").filter(Boolean);
  for (let phraseLength = 1; phraseLength <= Math.min(4, words.length); phraseLength += 1) {
    const phraseWords = words.slice(0, phraseLength);
    const phrase = phraseWords.join(" ");
    let cursor = 0;
    let repeatCount = 0;
    while (
      cursor + phraseLength <= words.length &&
      words.slice(cursor, cursor + phraseLength).join(" ") === phrase
    ) {
      repeatCount += 1;
      cursor += phraseLength;
    }
    if (repeatCount >= 2 && repeatCount < expectedCount) {
      const descriptions = Array.from(
        { length: Math.min(repeatCount, expectedCount - 1) },
        () => phrase,
      );
      const remainder = words.slice(cursor).join(" ").trim();
      if (remainder) {
        descriptions.push(remainder);
      }
      if (descriptions.length === expectedCount) {
        return descriptions;
      }
    }
  }

  return [normalized];
}

function normalizeSupportingPolicyFormHtmlTable(markdown: string): string {
  return markdown.replace(/<table>[\s\S]*?<\/table>/gi, (tableHtml, offset) => {
    const precedingText = markdown
      .slice(Math.max(0, offset - 160), offset)
      .replace(/\s+/g, " ");
    if (!/supporting policy form:/i.test(precedingText)) {
      return tableHtml;
    }

    const headerRowMatch = tableHtml.match(/<thead>\s*<tr>([\s\S]*?)<\/tr>\s*<\/thead>/i);
    const bodyRowMatches = [...tableHtml.matchAll(/<tbody>\s*([\s\S]*?)\s*<\/tbody>/gi)];
    if (!headerRowMatch || bodyRowMatches.length === 0) {
      return tableHtml;
    }

    const headerCells = extractHtmlCells(headerRowMatch[1] ?? "", "th");
    const tbodyRowsHtml = [...(bodyRowMatches[0]?.[1] ?? "").matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
    const bodyRows = tbodyRowsHtml.map((match) => extractHtmlCells(match[1] ?? "", "td"));
    if (
      headerCells.length !== 2 ||
      bodyRows.length !== 1 ||
      bodyRows[0]?.length !== 2 ||
      /supporting policy form/i.test(headerCells[0]) ||
      !/^[A-Z0-9.' -]{8,}$/.test(headerCells[0])
    ) {
      return tableHtml;
    }

    const codeRows = splitSupportFormCodes(bodyRows[0][0]!);
    const descriptionRows = splitSupportFormDescriptions(
      bodyRows[0][1]!,
      codeRows.length,
    );
    if (codeRows.length <= 1 || descriptionRows.length !== codeRows.length) {
      return tableHtml;
    }

    return renderSupportingPolicyFormTable([
      [headerCells[0], headerCells[1]],
      ...codeRows.map((code, index) => [code, descriptionRows[index] ?? ""]),
    ]);
  });
}

function expandCollapsedFourColumnTable(markdown: string): string {
  return markdown.replace(
    /<table>\s*<thead>\s*<tr>\s*<th>\s*Class\s*<\/th>\s*<th>\s*Relativity\s*<\/th>\s*<th>\s*Class\s*<\/th>\s*<th>\s*Relativity\s*<\/th>\s*<\/tr>\s*<\/thead>\s*<tbody>\s*<tr>\s*<td>\s*([^<]+?)\s*<\/td>\s*<td>\s*([^<]+?)\s*<\/td>\s*<td>\s*<\/td>\s*<td>\s*<\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>/i,
    (match, classCell: string, relativityCell: string) => {
      const classes = classCell.trim().split(/\s+/).filter(Boolean);
      const relativities = relativityCell.trim().split(/\s+/).filter(Boolean);
      if (
        classes.length < 4 ||
        classes.length !== relativities.length ||
        classes.length % 2 !== 0
      ) {
        return match;
      }

      const midpoint = Math.ceil(classes.length / 2);
      const rows: string[][] = [];
      for (let index = 0; index < midpoint; index += 1) {
        rows.push([
          classes[index] ?? "",
          relativities[index] ?? "",
          classes[index + midpoint] ?? "",
          relativities[index + midpoint] ?? "",
        ]);
      }
      return renderHtmlTable(
        ["Class", "Relativity", "Class", "Relativity"],
        rows,
      );
    },
  );
}

function linearizeTwoUpClassRelativityTables(markdown: string): string {
  return markdown.replace(
    /<table>\s*<thead>\s*<tr>\s*<th>\s*Class\s*<\/th>\s*<th>\s*Relativity\s*<\/th>\s*<th>\s*Class\s*<\/th>\s*<th>\s*Relativity\s*<\/th>\s*<\/tr>\s*<\/thead>\s*<tbody>\s*([\s\S]*?)\s*<\/tbody>\s*<\/table>/gi,
    (tableHtml, tbodyHtml: string) => {
      const rowMatches = [...tbodyHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
      const rows = rowMatches.map((match) => extractHtmlCells(match[1] ?? "", "td"));
      if (rows.length < 2 || rows.some((row) => row.length !== 4)) {
        return tableHtml;
      }

      const linearizedRows = [
        ...rows.map((row) => [row[0] ?? "", row[1] ?? "", "", ""]),
        ...rows
          .filter((row) => (row[2] ?? "").trim() || (row[3] ?? "").trim())
          .map((row) => [row[2] ?? "", row[3] ?? "", "", ""]),
      ];
      if (linearizedRows.length === rows.length) {
        return tableHtml;
      }

      return renderHtmlTable(
        ["Class", "Relativity", "Class", "Relativity"],
        linearizedRows,
      );
    },
  );
}

function synthesizeSupportingFormTable(markdown: string): string {
  if (/<table[\s>]/i.test(markdown) || !markdown.includes("Supporting Policy Form")) {
    return markdown;
  }

  const lines = markdown.split("\n");
  const rows: string[][] = [];
  let insertAt = -1;
  let pendingRow: string[] | null = null;
  let consumedThrough = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (/^\*\*Supporting Policy Form:\*\*$/i.test(line)) {
      insertAt = index;
      continue;
    }
    const pairMatch = line.match(/^\*\*([^*]+?)\*\*\s+\*\*([^*]+?)\*\*$/);
    if (pairMatch && insertAt !== -1) {
      pendingRow = [
        stripInlineMarkdown(pairMatch[1]),
        stripInlineMarkdown(pairMatch[2]),
      ];
      rows.push(pendingRow);
      consumedThrough = index;
      continue;
    }
    const continuationMatch = line.match(/^\*\*([^*]+?)\*\*$/);
    if (continuationMatch && pendingRow) {
      pendingRow[1] = `${pendingRow[1]} ${stripInlineMarkdown(continuationMatch[1])}`.trim();
      consumedThrough = index;
      continue;
    }
    pendingRow = null;
    if (rows.length > 0) {
      break;
    }
  }

  if (insertAt === -1 || rows.length < 3) {
    return markdown;
  }

  const table = renderSupportingPolicyFormTable(rows);
  const before = lines.slice(0, insertAt).join("\n");
  const after = lines.slice(consumedThrough + 1).join("\n");
  return `${before}\n${table}\n\n${after}`.trim() + "\n";
}

function markdownTableToHtml(tableMarkdown: string): string | null {
  const lines = tableMarkdown
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return null;
  }

  const rows = lines
    .filter((line, index) => {
      if (index !== 1) {
        return true;
      }
      return !/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
    })
    .map((line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => escapeHtml(stripInlineMarkdown(cell.trim()))),
    )
    .filter((row) => row.length > 0 && row.some((cell) => cell.length > 0));

  if (rows.length < 2) {
    return null;
  }

  const [header, ...body] = rows;
  const headerHtml = `<tr>${header.map((cell) => `<th>${cell}</th>`).join("")}</tr>`;
  const bodyHtml = body
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  return `<table>\n<thead>\n${headerHtml}\n</thead>\n<tbody>\n${bodyHtml}\n</tbody>\n</table>`;
}

function supportingPolicyMarkdownTableToHtml(
  tableMarkdown: string,
): string | null {
  const lines = tableMarkdown
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) {
    return null;
  }

  const rows = lines
    .filter((line, index) => {
      if (index !== 1) {
        return true;
      }
      return !/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
    })
    .map((line) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => stripInlineMarkdown(cell.trim()).replace(/\s+/g, " ").trim()),
    )
    .filter((row) => row.length === 2 && row.every((cell) => cell.length > 0));

  if (
    rows.length !== 2 ||
    !/^[A-Z0-9.' -]{8,}$/.test(rows[0]![0]!) ||
    !/^[A-Z]{2,}\d[\w.-]*(?:\s+[A-Z0-9.-]+)+/.test(rows[1]![0]!)
  ) {
    return null;
  }

  const codeRows = splitSupportFormCodes(rows[1]![0]!);
  const descriptionRows = splitSupportFormDescriptions(
    rows[1]![1]!,
    codeRows.length,
  );
  if (codeRows.length <= 1 || descriptionRows.length !== codeRows.length) {
    return null;
  }

  return renderSupportingPolicyFormTable([
    [rows[0]![0]!, rows[0]![1]!],
    ...codeRows.map((code, index) => [code, descriptionRows[index] ?? ""]),
  ]);
}

function normalizeSupportingPolicyFormMarkdownTable(markdown: string): string {
  return markdown.replace(
    MARKDOWN_TABLE_BLOCK,
    (fullMatch, prefix, table, offset, source) => {
      const precedingText = String(source)
        .slice(Math.max(0, Number(offset) - 160), Number(offset))
        .replace(/\s+/g, " ");
      if (!/supporting policy form:/i.test(precedingText)) {
        return fullMatch;
      }

      const html = supportingPolicyMarkdownTableToHtml(String(table));
      return html ? `${String(prefix)}${html}\n` : fullMatch;
    },
  );
}

export function normalizeExtractedMarkdown(args: {
  markdown: string;
  preserveTables: boolean;
}): string {
  if (!args.preserveTables) {
    return args.markdown;
  }

  const normalized = linearizeTwoUpClassRelativityTables(
    expandCollapsedFourColumnTable(
      normalizeSupportingPolicyFormHtmlTable(
        normalizeSupportingPolicyFormMarkdownTable(
          synthesizeSupportingFormTable(args.markdown),
        ),
      ),
    ),
  );
  if (countHtmlTables(normalized) > 0) {
    return normalized;
  }

  const converted = normalized.replace(
    MARKDOWN_TABLE_BLOCK,
    (fullMatch, prefix, table) => {
      const html = markdownTableToHtml(table);
      return html ? `${prefix}${html}\n` : fullMatch;
    },
  );
  return linearizeTwoUpClassRelativityTables(
    expandCollapsedFourColumnTable(
      converted.replace(/\b(1\/3V|2\/3V|V)\s+DD\b/g, "$1DD"),
    ),
  );
}

export function scoreMarkdownCandidate(args: {
  markdown: string;
  pageCount?: number;
}): {
  plausibilityScore: number;
  plausibilitySignals: ExtractionPlausibilitySignals;
  markdownTableCount: number;
  htmlTableCount: number;
  formattingScore: number;
  selectionScore: number;
} {
  const sanitized = sanitizeExtractedMarkdown(args.markdown).markdown;
  const markdownTableCount = countMarkdownTables(sanitized);
  const htmlTableCount = countHtmlTables(sanitized);
  const plausibilitySignals = scoreExtractionPlausibility(
    sanitized,
    args.pageCount ?? 1,
  );
  const plausibilityScore = plausibilitySignals.plausibilityScore;
  const formattingSignals =
    (sanitized.match(/^#{1,6}\s+/gm) ?? []).length * 2 +
    (sanitized.match(/\*\*[^*\n][^*\n]*\*\*/g) ?? []).length +
    (sanitized.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length +
    (sanitized.match(/^\s*[-*+]\s+/gm) ?? []).length;
  const formattingScore = Math.min(0.2, formattingSignals * 0.02);
  const selectionScore =
    plausibilityScore +
    markdownTableCount * 0.2 +
    htmlTableCount * 0.25 +
    formattingScore;

  return {
    plausibilityScore,
    plausibilitySignals,
    markdownTableCount,
    htmlTableCount,
    formattingScore,
    selectionScore,
  };
}
