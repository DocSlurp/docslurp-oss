import { tableChunks, TableBoundary } from "./table-chunking.js";
import { leadingFrontmatterLineCount, parseAtxHeading, plainHeadingText } from "../lib/markdown-structure.js";
import { atomizeSized, fitsLimits, headWords, normalizeNfc, tailWords, type SizeLimits } from "../lib/unicode-text.js";

export interface ChunkMeta {
  text: string;
  headingPath: string[];
  chunkIndex: number;
  overlapIndex?: number;
}

export interface ChunkOptions {
  overlapFraction?: number;
  /** Model-token limit per chunk (see `estimateTokens`); characters alone bound the chunk when omitted. */
  maxTokens?: number;
}

export function* chunkText(text: string, maxChars: number, options?: Pick<ChunkOptions, "maxTokens">): Generator<string> {
  for (const meta of chunkTextWithMeta(text, maxChars, options)) {
    yield meta.text;
  }
}

export function* chunkTextWithMeta(
  text: string,
  maxChars: number,
  options?: ChunkOptions
): Generator<ChunkMeta> {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new RangeError("maxChars must be a positive safe integer");
  if (options?.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new RangeError("maxTokens must be a positive safe integer");
  }
  const limits: SizeLimits = { maxChars, maxTokens: options?.maxTokens };
  const clean = normalizeNfc(text).trim();
  if (!clean) {
    return;
  }

  const sections = parseSections(clean);
  const overlapFraction = options?.overlapFraction ?? 0;

  if (overlapFraction <= 0) {
    let chunkIndex = 0;
    for (const section of sections) {
      for (const chunk of emitSection(section, limits)) {
        const trimmed = chunk.trim();
        if (trimmed) {
          yield { text: trimmed, headingPath: section.headingPath, chunkIndex };
          chunkIndex++;
        }
      }
    }
    return;
  }

  // Collect all base chunks, then insert overlap chunks between adjacent pairs
  const baseChunks: { text: string; headingPath: string[]; table: boolean }[] = [];
  for (const section of sections) {
    for (const chunk of emitSection(section, limits)) {
      const trimmed = chunk.trim();
      if (trimmed) {
        baseChunks.push({ text: trimmed, headingPath: section.headingPath, table: section.tableIndex !== undefined });
      }
    }
  }

  let chunkIndex = 0;
  for (let i = 0; i < baseChunks.length; i++) {
    const current = baseChunks[i]!;
    yield { text: current.text, headingPath: current.headingPath, chunkIndex, overlapIndex: 0 };
    chunkIndex++;

    if (i + 1 < baseChunks.length) {
      const next = baseChunks[i + 1]!;
      if (current.table || next.table) continue;
      // Overlap is cut on word boundaries so it never starts mid-word or mid-grapheme.
      const tail = tailWords(current.text, Math.floor(current.text.length * overlapFraction));
      const head = headWords(next.text, Math.floor(next.text.length * overlapFraction));
      const overlapText = (tail + " " + head).trim();
      if (overlapText && fitsLimits(overlapText, limits)) {
        yield { text: overlapText, headingPath: current.headingPath, chunkIndex, overlapIndex: 1 };
        chunkIndex++;
      }
    }
  }
}

interface Section {
  headingPath: string[];
  headingLevel: number;
  body: string;
  tableIndex?: number;
}

/** Bounded lexical section scan; DOM parsing is performed separately in the VM. */
export function htmlTableSources(text: string): string[] { return parseSections(text.trim()).filter(s => s.tableIndex !== undefined).map(s => s.body.trim()); }

function parseSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  const headingStack: { level: number; text: string }[] = [];
  let currentBody = "";
  let currentLevel = 0;

  function pushSection() {
    const path = headingStack.map((h) => h.text);
    if (currentBody.trim() || sections.length === 0) {
      sections.push({
        headingPath: [...path],
        headingLevel: currentLevel,
        body: currentBody.trim()
      });
    }
  }

  // A leading metadata block is not content and must not become a heading.
  const startLine = leadingFrontmatterLineCount(lines);
  let fence: string | null = null;
  let tableBody: string | null = null;
  let tableBoundary = new TableBoundary();
  let tableIndex = 0;
  function pushTable() {
    sections.push({ headingPath: headingStack.map(h => h.text), headingLevel: currentLevel, body: tableBody!, tableIndex: ++tableIndex });
    tableBody = null; tableBoundary = new TableBoundary();
  }

  for (const line of lines.slice(startLine)) {
    if (tableBody !== null || (fence === null && /^ {0,3}<table(?=\s|>|$)/i.test(line))) {
      if (tableBody === null) {
        if (currentBody.trim()) { pushSection(); currentBody = ""; }
        tableBody = "";
      }
      tableBody += (tableBody ? "\n" : "") + line;
      tableBoundary.feed(line);
      if (tableBoundary.closed) pushTable();
      continue;
    }
    // Lines inside fenced code (shell comments, Markdown samples) are never headings.
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    const headingMatch = fence === null && !fenceMatch ? parseAtxHeading(line) : null;
    if (headingMatch && plainHeadingText(headingMatch.text)) {
      const level = headingMatch.level;
      const headingText = plainHeadingText(headingMatch.text);

      // Determine if this heading starts a new section
      const isTopLevel = level <= 2;
      const isSubheading = level >= 3;

      if (isTopLevel || (isSubheading && currentBody.length >= 400)) {
        // Flush current section
        if (currentBody.trim()) {
          pushSection();
          currentBody = "";
        }
      }

      // Update heading stack
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text: headingText });
      currentLevel = level;

      // Keep the heading line attached to its body
      currentBody += (currentBody ? "\n" : "") + line;
    } else {
      currentBody += (currentBody ? "\n" : "") + line;
    }
  }

  if (tableBody !== null) pushTable();

  // Flush remaining
  if (currentBody.trim()) {
    pushSection();
  }

  return sections;
}

function* emitSection(section: Section, limits: SizeLimits): Generator<string> {
  const body = section.body;
  if (section.tableIndex !== undefined) { yield* tableChunks(body, limits.maxChars, section.tableIndex); return; }
  if (!body) {
    return;
  }

  if (fitsLimits(body, limits)) {
    yield body;
    return;
  }

  // Pack sentences (prose) and whole fenced blocks (code) into chunks. A fence
  // is split, at line boundaries, only when it cannot fit a chunk by itself.
  let current = "";
  let currentTokens = 0;
  for (const block of splitFences(body)) {
    // `atomizeSized` returns a fitting block as one piece, with the token count it needed to decide.
    for (const piece of atomizeSized(block.text, limits, { code: block.code })) {
      if (current && !fitsLimits(current + piece.text, limits, currentTokens + piece.tokens)) {
        if (current.trim()) yield current.trim();
        current = "";
        currentTokens = 0;
      }
      current += piece.text;
      currentTokens += piece.tokens;
    }
  }

  if (current.trim()) {
    yield current.trim();
  }
}

/** Splits a section body into prose and fenced-code blocks, keeping every character. */
function splitFences(body: string): Array<{ text: string; code: boolean }> {
  const blocks: Array<{ text: string; code: boolean }> = [];
  let fence: string | null = null;
  let buffer = "";
  const flush = (code: boolean) => {
    if (buffer) blocks.push({ text: buffer, code });
    buffer = "";
  };
  for (const line of body.split(/(?<=\n)/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker && fence === null) {
      flush(false);
      fence = marker;
      buffer = line;
    } else if (marker && fence !== null && marker[0] === fence[0] && marker.length >= fence.length) {
      buffer += line;
      flush(true);
      fence = null;
    } else {
      buffer += line;
    }
  }
  // An unterminated fence runs to the end of the section; it is still code.
  flush(fence !== null);
  return blocks;
}
