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
 */
export function leadingFrontmatterLineCount(lines: readonly string[]): number {
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
  return { markdown: lines.slice(count).join("\n").replace(/^\s*\n/, ""), strippedLines: count };
}

/**
 * Heading text as plain text for heading paths and section labels: link and
 * image markup become their label, inline code/emphasis markers, HTML tags and
 * a closing ATX `#` sequence are dropped.
 */
export function plainHeadingText(text: string): string {
  let out = text.trim();
  // Closing ATX sequence: `## Title ##`.
  out = out.replace(/\s+#+\s*$/, "");
  // Images first (`![alt](src)`), then inline links and reference links.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  // Autolinks `<https://…>` keep their address; other tags are removed.
  out = out.replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1");
  out = out.replace(/<\/?[A-Za-z][^>]*>/g, "");
  // Inline code and emphasis markers.
  out = out.replace(/`+([^`]*)`+/g, "$1");
  out = out.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2");
  out = out.replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2");
  out = out.replace(/(^|[^\w_])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2");
  out = out.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1");
  // Escaped Markdown punctuation.
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1");
  return out.replace(/\s+/g, " ").trim();
}
