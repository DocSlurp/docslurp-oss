/**
 * Small Markdown structure helpers shared by the extractors, the canonical
 * block builder and the plain-text chunker, so every path agrees on what is a
 * heading, what is document metadata and what a heading path entry looks like.
 */

const FRONTMATTER_OPEN = /^---\s*$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)\s*$/;
const FRONTMATTER_KEY = /^[A-Za-z_][\w.-]*\s*:(?:\s|$)/;
const FRONTMATTER_CONTINUATION = /^(?:\s+\S|\s*-\s)/;
// Some HTML converters emit a metadata block without a closing fence, so the
// final `key: value` line reads as a setext H2 and is written out as `## key: value`.
// Only lowercase identifier keys qualify, so a real heading such as
// `## Note: …` after a leading rule is never mistaken for metadata.
const FRONTMATTER_AS_HEADING = /^#{1,6}\s+[a-z_][a-z0-9_.-]*\s*:\s/;
const MAX_FRONTMATTER_LINES = 80;

/**
 * Number of lines at the start of `lines` that form a YAML-style metadata
 * block (`---` / `key: value` lines / `---`), or 0 when the text does not open
 * with one. Leading blank lines before the opening fence are included.
 * Metadata is not body content: it must not become a heading, a chunk or
 * chunk context.
 *
 * Never across a page break: a block that contains a form feed, or follows a
 * blank page, is 0. Removing a form feed would shift every later page's slot
 * (and its billed area) one page earlier (council I #2).
 */
export function leadingFrontmatterLineCount(lines: readonly string[]): number {
  const count = frontmatterLineCount(lines);
  for (let index = 0; index < count; index++) if ((lines[index] ?? "").includes("\f")) return 0;
  return count;
}

function frontmatterLineCount(lines: readonly string[]): number {
  let index = 0;
  while (index < lines.length && (lines[index] ?? "").trim() === "") index++;
  if (index >= lines.length || !FRONTMATTER_OPEN.test(lines[index] ?? "")) return 0;
  index++;

  let keyLines = 0;
  const limit = Math.min(lines.length, index + MAX_FRONTMATTER_LINES);
  for (; index < limit; index++) {
    const line = lines[index] ?? "";
    if (FRONTMATTER_CLOSE.test(line)) {
      return keyLines > 0 ? index + 1 : 0;
    }
    if (line.trim() === "") continue;
    if (FRONTMATTER_AS_HEADING.test(line)) {
      return index + 1;
    }
    if (FRONTMATTER_KEY.test(line)) {
      keyLines++;
      continue;
    }
    if (keyLines > 0 && FRONTMATTER_CONTINUATION.test(line)) continue;
    return 0;
  }
  return 0;
}

/** Remove a leading metadata block (see `leadingFrontmatterLineCount`). */
export function stripLeadingFrontmatter(markdown: string): { markdown: string; strippedLines: number } {
  const lines = markdown.split("\n");
  const count = leadingFrontmatterLineCount(lines);
  if (count === 0) return { markdown, strippedLines: 0 };
  // Blank lines after the block, never a form feed (a page break) or anything after one.
  return { markdown: lines.slice(count).join("\n").replace(/^(?:[ \t\r]*\n)+/, ""), strippedLines: count };
}

/**
 * Heading text as plain text for heading paths and section labels: link and
 * image markup become their label, inline code/emphasis markers, HTML tags and
 * a closing ATX `#` sequence are dropped.
 */
export function plainHeadingText(text: string): string {
  let out = stripClosingAtxSequence(text.trim());
  // Images first (`![alt](src)`), then inline links and reference links. Every class excludes its own opening delimiter,
  // so an attempt stops at the next opener: linear on unclosed `![`, `[`, `(` or `<` runs (council K #3).
  // A link target may hold one level of balanced parentheses (Wikipedia-style `Foo_(bar)`, council M #6).
  out = out.replace(/!\[([^\][]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
  out = out.replace(/!\[([^\][]*)\]\[[^\][]*\]/g, "$1");
  out = out.replace(/\[([^\][]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
  out = out.replace(/\[([^\][]+)\]\[[^\][]*\]/g, "$1");
  // Autolinks `<https://…>` keep their address; other tags are removed.
  out = out.replace(/<((?:https?|mailto):[^<>\s]+)>/gi, "$1");
  out = out.replace(/<\/?[A-Za-z][^<>]*>/g, "");
  // Inline code and emphasis markers. Bold and strikethrough never cross their own closing delimiter (linear).
  out = out.replace(/`+([^`]*)`+/g, "$1");
  out = out.replace(/\*\*(?=\S)((?:[^*]|\*(?!\*))+?)(?<=\S)\*\*/g, "$1");
  out = out.replace(/__(?=\S)((?:[^_]|_(?!_))+?)(?<=\S)__/g, "$1");
  out = out.replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2");
  out = out.replace(/(^|[^\w_])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2");
  out = out.replace(/~~(?=\S)((?:[^~]|~(?!~))+?)(?<=\S)~~/g, "$1");
  // Escaped Markdown punctuation.
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1");
  return out.replace(/\s+/g, " ").trim();
}

const isWhitespace = (char: string) => /\s/.test(char);

/** `## Title ##` → `## Title`: a trailing run of `#` after whitespace, removed with that whitespace (a linear scan). */
function stripClosingAtxSequence(text: string): string {
  let end = text.length;
  while (end > 0 && isWhitespace(text[end - 1]!)) end--;
  let hashes = end;
  while (hashes > 0 && text[hashes - 1] === "#") hashes--;
  if (hashes === end || hashes === 0 || !isWhitespace(text[hashes - 1]!)) return text;
  let cut = hashes;
  while (cut > 0 && isWhitespace(text[cut - 1]!)) cut--;
  return text.slice(0, cut);
}

/** Longest line read as an ATX heading; longer `#` lines are body text (council K #3). */
export const HEADING_MAX_LINE_CHARS = 8 * 1024;

/**
 * An ATX heading line (`#`–`######`, whitespace, text): its level and its text, trailing whitespace removed; null when
 * the line is not one. A linear scan in place of /^(#{1,6})\s+(.+?)\s*$/, which backtracked quadratically over long
 * whitespace runs. The text keeps any line-terminator-free content after the opening whitespace.
 */
export function parseAtxHeading(line: string): { level: number; text: string } | null {
  if (line.length > HEADING_MAX_LINE_CHARS) return null;
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  if (level < 1 || level > 6 || level >= line.length || !isWhitespace(line[level]!)) return null;
  let start = level;
  while (start < line.length && isWhitespace(line[start]!)) start++;
  const text = line.slice(start).trimEnd();
  return text && !/[\r\n\u2028\u2029]/.test(text) ? { level, text } : null;
}
