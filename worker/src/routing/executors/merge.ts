import type { AssignmentRole, BBox } from "@docslurp/shared";

import type { ExecutorOutput } from "./types.js";

/** Pixel density of page rasters relative to PDF points (150 dpi / 72). */
export const RASTER_PX_PER_POINT = 150 / 72;

export interface MergeInput {
  /** Page prose: accepted text layer, or the page-scope extraction output. May be empty. */
  prose: string;
  /** Region/image-scoped outputs (chart data, labels, diagrams, tables) to place in the prose. */
  inserts: readonly ExecutorOutput[];
  /** Page height in points; enables positional insertion by bbox.y. Omit to append in bbox order. */
  pageHeightPt?: number | null;
}

const insertTitle: Partial<Record<AssignmentRole, string>> = {
  "chart-data": "Chart data",
  diagram: "Diagram",
  "image-label": "Image",
  math: "Equation",
  table: "Table",
};

function bboxOf(output: ExecutorOutput): BBox | null {
  const scope = output.scope;
  if (scope.kind === "region") return scope.bbox;
  if (scope.kind === "image") return scope.bbox ?? null;
  return null;
}

export function formatInsert(output: ExecutorOutput): string {
  const text = output.text.trim();
  const imageIndex = output.scope.kind === "image" ? output.scope.imageIndex + 1 : null;
  const title = insertTitle[output.role];
  if (output.role === "image-label") {
    return `> **Image${imageIndex ? ` ${imageIndex}` : ""}:** ${text.replace(/\s*\n\s*/g, " ")}`;
  }
  if (output.role === "chart-data" || output.role === "diagram") {
    return `**${title}${imageIndex ? ` (image ${imageIndex})` : ""}**\n\n${text}`;
  }
  return text;
}

/**
 * Merges a page's prose with its scoped outputs into one markdown body. Inserts land between
 * prose paragraphs at the paragraph index proportional to the bbox's vertical position (so a
 * chart sits near where it appears on the page); without a page height or bbox they follow the
 * prose, ordered by bbox.y. Empty outputs are dropped.
 */
export function mergePageText(input: MergeInput): string {
  const paragraphs = input.prose.trim() === "" ? [] : input.prose.trim().split(/\n{2,}/);
  const inserts = input.inserts
    .filter((o) => o.text.trim() !== "")
    .map((o) => ({ output: o, bbox: bboxOf(o), block: formatInsert(o) }))
    .sort((a, b) => (a.bbox?.y ?? Infinity) - (b.bbox?.y ?? Infinity) || a.output.assignmentIndex - b.output.assignmentIndex);

  const height = input.pageHeightPt && input.pageHeightPt > 0 ? input.pageHeightPt : null;
  const merged = [...paragraphs];
  let shift = 0;
  const trailing: string[] = [];
  for (const insert of inserts) {
    if (height && insert.bbox && paragraphs.length > 0) {
      const fraction = Math.min(1, Math.max(0, insert.bbox.y / height));
      const at = Math.round(fraction * paragraphs.length) + shift;
      merged.splice(at, 0, insert.block);
      shift += 1;
    } else {
      trailing.push(insert.block);
    }
  }
  return [...merged, ...trailing].join("\n\n");
}
