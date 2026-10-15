// Page boundaries for Kreuzberg Markdown.
//
// Kreuzberg renders one Markdown string for the whole document and, in
// Markdown output mode, ignores `pages.insertPageMarkers`. Without page breaks
// the pipeline falls back to slicing the text into equal-length "pages", which
// cuts headings and lines mid-word, attributes text to the wrong page and lets
// per-page steps (vision reconciliation, parser alignment) drop the misplaced
// lines. Pages without text (scans, blank pages) also vanish, so triage cannot
// see them.
//
// The document structure (`includeDocumentStructure`) carries a page number for
// every node, in reading order. This module finds where each page's first text
// node starts inside the Markdown and inserts a form feed there, giving exactly
// one `\f`-separated section per page (empty for pages without text). When a
// boundary cannot be located it returns null, and the caller keeps the
// unmarked Markdown.

const ANCHOR_CHARS = 48;
// Anchors shorter than this ("Notes", "Ref 12", a stamp) recur often, so they only
// count when the node starts its own line, near the expected position.
const SHORT_ANCHOR_CHARS = 8;
const MIN_ANCHOR_CHARS = 3;
// Below this share of anchored nodes the structure does not describe the Markdown.
const MIN_MATCHED_NODE_SHARE = 0.6;
// Consecutive nodes render next to each other, so a node is only searched for within
// the rest of the previous node plus this slack (projected characters). A text that
// recurs later (running header or footer, repeated phrase) cannot pull the cursor
// pages ahead when the nearby occurrence is missing.
const SEARCH_SLACK_CHARS = 1500;
// How far past the expected position a node may be re-found (with confirmation by the
// next node). Bounds the work per missing node to O(window), not O(document).
const AHEAD_WINDOW_CHARS = 50_000;

function nodeText(content) {
  if (!content || typeof content !== "object") return "";
  // Groups repeat their first heading's text; the heading node itself is the anchor.
  if (content.node_type === "group") return "";
  for (const field of ["text", "heading_text", "code", "caption"]) {
    const value = content[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  // Tables carry their text in grid cells, rendered row by row.
  const cells = content.grid?.cells;
  if (Array.isArray(cells)) {
    let text = "";
    for (const cell of cells) {
      if (typeof cell?.content === "string" && cell.content.trim()) text += ` ${cell.content}`;
    }
    return text;
  }
  return "";
}

/** Lower-case letters and digits of `text`, plus each kept character's index in `text`. */
function project(text) {
  let chars = "";
  const indexes = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/[\p{L}\p{N}]/u.test(char)) {
      chars += char.toLowerCase();
      indexes.push(index);
    }
  }
  return { chars, indexes };
}

/**
 * Split Markdown into `pageCount` page sections using the per-node page numbers of
 * Kreuzberg's document structure. Returns the Markdown with `\f` between pages, or
 * null when the structure is missing or does not line up with the Markdown.
 *
 * Nodes are aligned to the Markdown in reading order: each node's leading text is
 * searched after the previous match, so text repeated across pages (running headers,
 * recurring phrases) is consumed by the page it belongs to before the next page's
 * nodes are placed. A node whose text is missing from the Markdown is skipped. A page
 * starts at the line holding its first placed node; a page with no placed node is
 * empty and its text (if any) stays with the previous page.
 */
export function insertPageMarkers(markdown, nodes, pageCount) {
  if (typeof markdown !== "string" || !Array.isArray(nodes)) return null;
  const pages = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : 0;
  if (pages <= 1) return null;

  // Anchor candidates in reading order: leading projected text plus full projected length.
  const anchors = [];
  for (const node of nodes) {
    const page = node?.page;
    if (!Number.isInteger(page) || page < 1 || page > pages) continue;
    const text = project(nodeText(node.content)).chars;
    if (text.length < MIN_ANCHOR_CHARS) continue;
    anchors.push({ page, text, anchor: text.slice(0, ANCHOR_CHARS), length: text.length });
  }
  if (anchors.length === 0) return null;

  const projected = project(markdown);
  const startsLine = (at) => {
    const offset = projected.indexes[at];
    const lineStart = markdown.lastIndexOf("\n", offset) + 1;
    return !/[\p{L}\p{N}]/u.test(markdown.slice(lineStart, offset));
  };
  // First occurrence of `anchor` starting in [from, to], scanning only that range.
  const find = (anchor, from, to) => {
    const at = projected.chars.slice(from, to + anchor.length).indexOf(anchor);
    return at < 0 ? -1 : from + at;
  };
  const within = (index, from, remaining) => {
    const { anchor } = anchors[index];
    const range = projected.chars.slice(from, from + remaining + SEARCH_SLACK_CHARS + anchor.length);
    for (let at = range.indexOf(anchor); at >= 0; at = range.indexOf(anchor, at + 1)) {
      if (anchor.length >= SHORT_ANCHOR_CHARS || startsLine(from + at)) return from + at;
    }
    return -1;
  };

  const longAnchors = anchors.filter((entry) => entry.anchor.length >= SHORT_ANCHOR_CHARS).length;
  if (longAnchors === 0) return null;
  // Once this many long anchors are unplaced the share check fails; stop early.
  const allowedMisses = Math.floor(longAnchors * (1 - MIN_MATCHED_NODE_SHARE));
  let misses = 0;

  const starts = new Array(pages + 1).fill(null);
  starts[1] = 0;
  let cursor = 0;
  let remaining = 0; // unmatched rest of the previous placed node
  let matched = 0; // long anchors placed; short ones are optional extras
  let lastStart = 0;
  let lastPage = 1;
  for (let index = 0; index < anchors.length; index += 1) {
    const { page, text, anchor, length } = anchors[index];
    let at = within(index, cursor, remaining);
    if (at < 0 && anchor.length < SHORT_ANCHOR_CHARS) continue;
    if (at < 0) {
      if (++misses > allowedMisses) return null;
      // Further ahead than expected (content between nodes the structure does not
      // describe). Accept only when the next node follows right after it.
      const ahead = find(anchor, cursor, cursor + AHEAD_WINDOW_CHARS);
      const confirmed = ahead >= 0 && index + 1 < anchors.length &&
        within(index + 1, ahead + anchor.length, length - anchor.length) >= 0;
      if (!confirmed) continue;
      misses -= 1;
      at = ahead;
    }
    if (anchor.length >= SHORT_ANCHOR_CHARS) matched += 1;
    // When the whole node renders verbatim, skip past all of it, so repetitive text
    // (identical paragraphs, table rows) cannot be matched again by the next node.
    if (projected.chars.startsWith(text, at)) {
      cursor = at + length;
      remaining = 0;
    } else {
      cursor = at + anchor.length;
      remaining = length - anchor.length;
    }
    // Reading order can revisit an earlier page (floats, footnotes); page starts only move forward.
    if (page <= lastPage) continue;
    const offset = projected.indexes[at];
    const lineStart = Math.max(lastStart, markdown.lastIndexOf("\n", offset) + 1);
    starts[page] = lineStart;
    lastStart = lineStart;
    lastPage = page;
  }
  if (matched / longAnchors < MIN_MATCHED_NODE_SHARE) return null;

  // Pages without a placed node start where the next placed page starts (empty section).
  let next = markdown.length;
  for (let page = pages; page >= 2; page -= 1) {
    if (starts[page] === null) starts[page] = next;
    else next = starts[page];
  }

  const sections = [];
  for (let page = 1; page <= pages; page += 1) {
    const end = page < pages ? starts[page + 1] : markdown.length;
    sections.push(markdown.slice(starts[page], end).replace(/\f/g, "").trim());
  }
  return sections.join("\n\f\n");
}
