/**
 * Markdown for an exported visual: the description as plain, searchable text first, then one fenced block per
 * requested format in the project's order. Routed inserts get their heading from `routing/executors/merge.ts`
 * (`**Chart data (image N)**`); pages without a router insert use `visualBlock`, which adds the same heading.
 */
import { randomBytes } from "node:crypto";

import type { ChartExportFormat, ExportedVisual } from "@docslurp/shared";

import { renderFencedBlock } from "./render-adapter.js";

/**
 * Breaks HTML comment delimiters in prose (descriptions, captions, CSV cells) with a zero-width space, so text taken
 * from a document or a model can never open or close a comment, and so never forge or split a visual group marker.
 */
export function breakCommentDelimiters(text: string): string {
  return text.replace(/<!--/g, "<!​--").replace(/-->/g, "--​>");
}

function caption(visual: ExportedVisual): string {
  const title = visual.spec?.title?.replace(/\s+/g, " ").trim();
  const noun = visual.kind === "diagram" ? "Diagram" : "Chart";
  return title ? breakCommentDelimiters(`${noun}: ${title}`) : "";
}

/** Body only (no heading): description (or a short caption), then fenced blocks. */
export function visualBody(visual: ExportedVisual, formats: readonly ChartExportFormat[]): string {
  const parts: string[] = [];
  const description = visual.outputs.description?.trim();
  if (description) parts.push(description);
  else if (caption(visual)) parts.push(caption(visual));
  for (const format of formats) {
    if (format === "description") continue;
    const text = visual.outputs[format];
    if (text?.trim()) parts.push(renderFencedBlock(format, text));
  }
  return parts.join("\n\n");
}

/** Heading + body, matching the routed insert format. */
export function visualBlock(visual: ExportedVisual, formats: readonly ChartExportFormat[]): string {
  const title = visual.kind === "diagram" ? "Diagram" : "Chart data";
  const where = visual.imageIndex !== null ? ` (image ${visual.imageIndex + 1})` : "";
  const body = visualBody(visual, formats);
  return body ? `**${title}${where}**\n\n${body}` : "";
}

// ---- Stable visual groups ------------------------------------------------------------------------------------
//
// Every exported block is wrapped in a pair of short HTML comments carrying the visual id and the export's nonce, so a
// later run can find and replace (or, with export off, remove) exactly what chart export added: a partial reprocess
// seeds the previous canonical document, which already holds the previous run's blocks. Only groups the previous
// export recorded (id and nonce, in its chart-export artifact) are removed, so marker-like text in the customer's
// document, which cannot know the random nonce, is never touched. The markers sit on their own paragraphs so the
// canonical document keeps them as separate blocks; chunking drops them (`lib/visual-markers.ts`).

const VISUAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE = /^[0-9a-f]{16}$/;

/** A group the export wrote: its visual id and the export's nonce. */
export interface VisualGroupRef {
  id: string;
  nonce: string;
}

/** A fresh per-export nonce (64 random bits, hex). */
export function newVisualMarkerNonce(): string {
  return randomBytes(8).toString("hex");
}

function checkRef(id: string, nonce: string): void {
  if (!VISUAL_ID.test(id)) throw new Error("invalid visual id");
  if (!NONCE.test(nonce)) throw new Error("invalid visual marker nonce");
}

export function visualGroupOpen(id: string, nonce: string): string {
  checkRef(id, nonce);
  return `<!-- docslurp:visual ${id} ${nonce} -->`;
}

export function visualGroupClose(id: string, nonce: string): string {
  checkRef(id, nonce);
  return `<!-- /docslurp:visual ${id} ${nonce} -->`;
}

/**
 * `content` wrapped in the visual's markers (empty content stays empty). Any comment opener left in the content is
 * broken first (the sanitizers already escape it per format; this is the backstop), so a body can never hold a marker.
 */
export function wrapVisualGroup(id: string, nonce: string, content: string): string {
  const body = content.replace(/<!--/g, "<!​--").trim();
  return body ? `${visualGroupOpen(id, nonce)}\n\n${body}\n\n${visualGroupClose(id, nonce)}` : "";
}

/** The routed merge's heading (`**Chart data (image N)**` / `**Diagram**`), which it puts outside the markers. */
const HEADING_BEFORE = /\n\*\*(?:Chart data|Diagram)(?: \(image \d{1,4}\))?\*\*[ \t]*\n+$/;

/**
 * Removes exactly the listed groups (open marker through the matching close marker, both with the group's id and
 * nonce), with the routed heading right before one. Anything else, marker-like text included, is left as it is.
 * Returns the text and the removed ids.
 */
export function stripVisualGroups(text: string, groups: readonly VisualGroupRef[]): { text: string; removed: string[] } {
  if (groups.length === 0 || !text.includes("<!-- docslurp:visual ")) return { text, removed: [] };
  const removed: string[] = [];
  let out = text;
  for (const group of groups) {
    if (!VISUAL_ID.test(group.id) || !NONCE.test(group.nonce)) continue;
    const open = visualGroupOpen(group.id, group.nonce);
    const close = visualGroupClose(group.id, group.nonce);
    for (let guard = 0; guard < 1000; guard += 1) {
      const start = out.indexOf(open);
      if (start < 0) break;
      const end = out.indexOf(close, start + open.length);
      if (end < 0) break;
      // The heading must start a line: a window from the text's start counts as one.
      const windowStart = Math.max(0, start - 200);
      const heading = HEADING_BEFORE.exec((windowStart === 0 ? "\n" : "") + out.slice(windowStart, start));
      const from = heading ? start - (heading[0].length - 1) : start;
      out = out.slice(0, from) + out.slice(end + close.length);
      if (!removed.includes(group.id)) removed.push(group.id);
    }
  }
  return removed.length === 0 ? { text, removed } : { text: out.replace(/\n{3,}/g, "\n\n").trim(), removed };
}
