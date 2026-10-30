import { tableChunks, TableBoundary } from "./table-chunking.js";
import { leadingFrontmatterLineCount, plainHeadingText } from "../lib/markdown-structure.js";

export interface ChunkMeta {
  text: string;
  headingPath: string[];
  chunkIndex: number;
  overlapIndex?: number;
}

export function* chunkText(text: string, maxChars: number): Generator<string> {
  for (const meta of chunkTextWithMeta(text, maxChars)) {
    yield meta.text;
  }
}

export function* chunkTextWithMeta(
  text: string,
  maxChars: number,
  options?: { overlapFraction?: number }
): Generator<ChunkMeta> {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new RangeError("maxChars must be a positive safe integer");
  const clean = text.trim();
  if (!clean) {
    return;
  }

  const sections = parseSections(clean);
  const overlapFraction = options?.overlapFraction ?? 0;

  if (overlapFraction <= 0) {
    let chunkIndex = 0;
    for (const section of sections) {
      for (const chunk of emitSection(section, maxChars)) {
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
    for (const chunk of emitSection(section, maxChars)) {
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
      const tailLen = Math.floor(current.text.length * overlapFraction);
      const headLen = Math.floor(next.text.length * overlapFraction);
      const tail = current.text.slice(-tailLen);
      const head = next.text.slice(0, headLen);
      const overlapText = (tail + " " + head).trim();
      if (overlapText && overlapText.length <= maxChars) {
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
    const headingMatch = fence === null && !fenceMatch ? line.match(/^(#{1,6})\s+(.+)$/) : null;
    if (headingMatch && plainHeadingText(headingMatch[2]!)) {
      const level = headingMatch[1]!.length;
      const headingText = plainHeadingText(headingMatch[2]!);

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

function* emitSection(section: Section, maxChars: number): Generator<string> {
  const body = section.body;
  if (section.tableIndex !== undefined) { yield* tableChunks(body, maxChars, section.tableIndex); return; }
  if (!body) {
    return;
  }

  if (body.length <= maxChars) {
    yield body;
    return;
  }

  // Split on sentence boundaries
  const sentences = splitSentences(body);
  let current = "";

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // Flush current buffer
      if (current.trim()) {
        yield current.trim();
        current = "";
      }
      // Hard split oversized sentence
      let remainder = sentence;
      while (remainder.length > maxChars) {
        yield remainder.slice(0, maxChars).trim();
        remainder = remainder.slice(maxChars);
      }
      if (remainder.trim()) {
        current = remainder;
      }
      continue;
    }

    if (current && current.length + sentence.length > maxChars) {
      yield current.trim();
      current = sentence;
      continue;
    }

    current += sentence;
  }

  if (current.trim()) {
    yield current.trim();
  }
}

function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace and a capital letter or newline
  const parts: string[] = [];
  const pattern = /([.!?])\s+(?=[A-Z\n])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const end = match.index + match[1]!.length;
    parts.push(text.slice(lastIndex, end));
    lastIndex = end;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}
