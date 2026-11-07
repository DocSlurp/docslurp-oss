/*
 * Image references in document Markdown, and how a later OCR / vision / caption result is merged back at them.
 *
 * Reference:   ![alt](docslurp-artifact:<artifactId>#p<page>o<occurrence>)
 *
 * - The target is the media-map image's artifact ID (percent-encoded outside [A-Za-z0-9._:-]); the fragment is the
 *   image's stable key in the media map, so a re-used asset on two pages is two distinct anchors.
 * - A reference is its own Markdown block (blank lines around it). Image bytes are never in Markdown.
 * - The alt text is the PDF's own alt/caption when it has one, else empty. A placeholder like "Image on page 3" would
 *   be searchable noise, so there is none.
 * - Where a reference goes is a block index the producer computed, for example by aligning Markdown blocks with the
 *   text layer. Both sides must count blocks the same way: a producer that computes positions counts with the rule in
 *   `markdownBlocks` below and tests against packages/shared/test-vectors/markdown-blocks.json.
 * - A merged result is a blockquote that follows its reference, labelled by the reader that produced it. Merging again
 *   replaces that blockquote; nothing else in the page changes.
 */

export const IMAGE_ANCHOR_SCHEME = "docslurp-artifact:";
export const MAX_IMAGE_ANCHOR_ALT_CHARS = 200;
export const MAX_MERGED_IMAGE_TEXT_CHARS = 65_536;

const ID_SAFE = /^[A-Za-z0-9._:-]+$/;
const ANCHOR_LINE = /^!\[((?:[^\]\\]|\\.)*)\]\(docslurp-artifact:([^)\s#]+)#(p[0-9]+o[0-9]+)\)$/;
const GENERIC_ALT = /^(?:image|img|picture|pic|graphic|figure|photo|untitled|logo|scan)?[\s_.-]*[0-9]*(?:\.(?:png|jpe?g|gif|bmp|tiff?|webp|svg))?$/i;

export type ImageResultKind = "ocr" | "vision" | "caption";
const RESULT_LABEL: Record<ImageResultKind, string> = { ocr: "Image text (OCR)", vision: "Figure description", caption: "Image caption" };
const RESULT_LINE = /^> \*\*(?:Image text \(OCR\)|Figure description|Image caption):\*\*/;

export function imageAnchorId(pageNumber: number, occurrence: number): string {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || !Number.isSafeInteger(occurrence) || occurrence < 0) throw new Error("Invalid image anchor");
  return `p${pageNumber}o${occurrence}`;
}

/** Alt text safe to place inside `![...]`: one line, no bracket or backslash structure, none for generic file-like names. */
export function imageAltForMarkdown(raw: string | null | undefined): string {
  if (!raw) return "";
  // eslint-disable-next-line no-control-regex
  const plain = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_IMAGE_ANCHOR_ALT_CHARS).trim();
  if (!plain || GENERIC_ALT.test(plain)) return "";
  return plain.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

export function imageAnchorMarkdown(args: { artifactId: string; pageNumber: number; occurrence: number; alt?: string | null }): string {
  const target = ID_SAFE.test(args.artifactId) ? args.artifactId : encodeURIComponent(args.artifactId).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%3A/g, ":");
  return `![${imageAltForMarkdown(args.alt)}](${IMAGE_ANCHOR_SCHEME}${target}#${imageAnchorId(args.pageNumber, args.occurrence)})`;
}

export interface ParsedImageAnchor { alt: string; artifactId: string; anchor: string; pageNumber: number; occurrence: number }

/** Parse a whole line that is an image reference, or null. */
export function parseImageAnchorLine(line: string): ParsedImageAnchor | null {
  const m = ANCHOR_LINE.exec(line.trim());
  if (!m) return null;
  const [, alt = "", target = "", anchor = ""] = m;
  const parts = /^p([0-9]+)o([0-9]+)$/.exec(anchor);
  if (!parts) return null;
  let artifactId: string;
  try { artifactId = decodeURIComponent(target); } catch { return null; }
  return { alt: alt.replace(/\\([\\[\]])/g, "$1"), artifactId, anchor, pageNumber: Number(parts[1]), occurrence: Number(parts[2]) };
}

/** `[firstLine, lastLine]` (inclusive) of each Markdown block of one page; see the file header for the counting rule. */
export function markdownBlocks(page: string): Array<[number, number]> {
  const lines = page.split("\n");
  const blocks: Array<[number, number]> = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === "") i++;
    if (i >= lines.length) break;
    const start = i;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]!);
    if (fence) {
      const marker = fence[1]![0]!;
      const length = fence[1]!.length;
      i++;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!);
        i++;
        if (close && close[1]![0] === marker && close[1]!.length >= length) break;
      }
    } else if (/^ {0,3}<table(?=\s|>|$)/i.test(lines[i]!)) {
      while (i < lines.length) {
        const closes = /<\/table\s*>/i.test(lines[i]!);
        i++;
        if (closes) break;
      }
    } else {
      while (i < lines.length && lines[i]!.trim() !== "") i++;
    }
    blocks.push([start, i - 1]);
  }
  return blocks;
}

export interface ImageInsertion { pageNumber: number; block: number; line: string }

/**
 * Insert image reference blocks into a document's Markdown (pages separated by form feeds). `block` is the index of the
 * block the reference goes before; `blocks.length` appends after the last. Everything else stays byte for byte. A page
 * outside the document or a block out of range throws: callers pass only validated producer positions.
 */
export function insertImageAnchors(markdown: string, insertions: readonly ImageInsertion[]): string {
  if (insertions.length === 0) return markdown;
  const pages = markdown.split("\f");
  const byPage = new Map<number, ImageInsertion[]>();
  for (const insertion of insertions) {
    if (!Number.isSafeInteger(insertion.pageNumber) || insertion.pageNumber < 1 || insertion.pageNumber > pages.length) throw new Error("Image anchor page outside the document");
    (byPage.get(insertion.pageNumber) ?? byPage.set(insertion.pageNumber, []).get(insertion.pageNumber)!).push(insertion);
  }
  for (const [pageNumber, list] of byPage) {
    const text = pages[pageNumber - 1]!;
    const blocks = markdownBlocks(text);
    const lines = text.split("\n");
    if (blocks.length === 0) {
      pages[pageNumber - 1] = `${list.map((i) => i.line).join("\n\n")}${text.trim() === "" ? "" : `\n\n${text}`}`;
      continue;
    }
    const at = (insertion: ImageInsertion): { index: number; after: boolean } => {
      if (!Number.isSafeInteger(insertion.block) || insertion.block < 0 || insertion.block > blocks.length) throw new Error("Image anchor block out of range");
      return insertion.block === blocks.length ? { index: blocks[blocks.length - 1]![1], after: true } : { index: blocks[insertion.block]![0], after: false };
    };
    // Later positions first so earlier line indexes stay valid; equal positions keep the given order.
    const ordered = list.map((insertion, order) => ({ insertion, order, ...at(insertion) }))
      .sort((a, b) => (b.index + (b.after ? 0.5 : 0)) - (a.index + (a.after ? 0.5 : 0)) || b.order - a.order);
    for (const { insertion, index, after } of ordered) {
      if (after) lines.splice(index + 1, 0, "", insertion.line);
      else lines.splice(index, 0, insertion.line, "");
    }
    pages[pageNumber - 1] = lines.join("\n");
  }
  return pages.join("\f");
}

export interface MergeImageResult { markdown: string; merged: boolean; reason?: "anchor-not-found" | "empty-result" }

/**
 * Merge an OCR, vision or caption result into the Markdown at the image's reference: a labelled blockquote directly
 * after it. A second merge for the same reference replaces the first. No reference, no change.
 */
export function mergeImageResult(markdown: string, target: { pageNumber: number; occurrence: number }, result: { kind: ImageResultKind; text: string }): MergeImageResult {
  const anchor = imageAnchorId(target.pageNumber, target.occurrence);
  const pages = markdown.split("\f");
  const page = pages[target.pageNumber - 1];
  if (page === undefined) return { markdown, merged: false, reason: "anchor-not-found" };
  // eslint-disable-next-line no-control-regex
  const text = result.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_MERGED_IMAGE_TEXT_CHARS);
  if (!text) return { markdown, merged: false, reason: "empty-result" };
  const lines = page.split("\n");
  const index = lines.findIndex((line) => parseImageAnchorLine(line)?.anchor === anchor);
  if (index < 0) return { markdown, merged: false, reason: "anchor-not-found" };
  // An earlier merge: the blank line and then a labelled blockquote run right after the reference.
  let end = index + 1;
  if (lines[end]?.trim() === "" && RESULT_LINE.test(lines[end + 1] ?? "")) {
    end += 1;
    while (end < lines.length && /^>/.test(lines[end]!)) end += 1;
    lines.splice(index + 1, end - index - 1);
  }
  const [first = "", ...rest] = text.split("\n");
  const quote = [`> **${RESULT_LABEL[result.kind]}:** ${first}`, ...rest.map((line) => (line === "" ? ">" : `> ${line}`))];
  lines.splice(index + 1, 0, "", ...quote);
  if (lines[index + 1 + 1 + quote.length] !== undefined && lines[index + 1 + 1 + quote.length]!.trim() !== "") lines.splice(index + 2 + quote.length, 0, "");
  pages[target.pageNumber - 1] = lines.join("\n");
  return { markdown: pages.join("\f"), merged: true };
}

/**
 * The text an image reference line stands for: its alt text (possibly empty), or null when the line is not one. The one
 * rule every text consumer (canonical blocks, page rows, propositions, summaries, structured inputs) applies; the link
 * target is an internal artifact id and never text.
 */
export function imageAnchorLineText(line: string): string | null {
  return parseImageAnchorLine(line)?.alt ?? null;
}

/**
 * Replace every image reference line with its alt text, dropping a line with none. Exports keep the raw reference;
 * everything that reads Markdown as text uses this.
 */
export function imageAnchorsToAltText(markdown: string): string {
  if (!markdown.includes(IMAGE_ANCHOR_SCHEME)) return markdown;
  return markdown.split("\f").map((page) => page.split("\n").flatMap((line) => {
    const alt = imageAnchorLineText(line);
    if (alt !== null) return alt ? [alt] : [];
    // A reference inside a line (not where the producer puts them, but untrusted text may) becomes its alt text too.
    return [line.replace(INLINE_ANCHOR, (_match, raw: string) => raw.replace(/\\([\\[\]])/g, "$1"))];
  }).join("\n")).join("\f");
}

const INLINE_ANCHOR = /!\[((?:[^\]\\]|\\.)*)\]\(docslurp-artifact:[^)\s#]+#p[0-9]+o[0-9]+\)/g;

/** Remove every image reference line (and nothing else), for consumers that want the text alone. */
export function stripImageAnchors(markdown: string): string {
  return markdown.split("\f").map((page) => page.split("\n").filter((line) => parseImageAnchorLine(line) === null).join("\n")).join("\f");
}
