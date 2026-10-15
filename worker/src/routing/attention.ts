import type { PageAttention, PageInput } from "@docslurp/shared";

// ---------------------------------------------------------------------------
// H9: unusual / unsupported features are flagged, never silently dropped.
// Pure rules over the probe's `unusualFeatures` (worker/scripts/page_probe.py).
// ---------------------------------------------------------------------------

/** Document needs a password we do not have: nothing can be extracted. */
const LOCKED = new Set(["encrypted-user-password"]);
/**
 * Content that lives in annotation/widget appearance streams, not in the page text layer. A
 * text-layer-only target would drop it, so these pages go to a target that renders the page.
 */
const APPEARANCE_ONLY = new Set(["acroform-filled", "annotation-text", "annotation-freetext", "annotation-other"]);
/** Flag-only: reported, extraction continues. */
const FLAG_ONLY: Record<string, string> = {
  "ocg-hidden": "hidden layer: text-layer text may include content not visible on the page",
  javascript: "document JavaScript present (not executed)",
  attachment: "embedded files present (not extracted)",
  "annotation-highlight": "highlight annotations present (page text unaffected)",
};

export interface AttentionAssessment {
  attention: PageAttention | null;
  /** Locked document: emit an explicit skip instead of extraction. */
  skip: boolean;
  /** Text-layer-only roles must be replaced by a render-based target. */
  renderNeeded: boolean;
}

export function assessAttention(page: PageInput): AttentionAssessment {
  const feats = page.unusualFeatures ?? [];
  const pageNumber = page.features.pageNumber;
  const locked = feats.filter((f) => LOCKED.has(f));
  if (locked.length > 0) {
    return {
      skip: true,
      renderNeeded: false,
      attention: { pageNumber, outcome: "skipped", features: locked, reason: "needs-attention: document locked (user password required); nothing extractable" },
    };
  }
  const render = feats.filter((f) => APPEARANCE_ONLY.has(f));
  const flagged = feats.filter((f) => f in FLAG_ONLY);
  const all = [...render, ...flagged];
  if (all.length === 0) return { attention: null, skip: false, renderNeeded: false };
  const notes = [
    ...(render.length ? [`form/annotation content is outside the text layer; routed to a rendering target (${render.join(", ")})`] : []),
    ...flagged.map((f) => FLAG_ONLY[f]!),
  ];
  return {
    skip: false,
    renderNeeded: render.length > 0,
    attention: { pageNumber, outcome: "flagged", features: all, reason: `needs-attention: ${notes.join("; ")}` },
  };
}

/** Attention entries for pages, one per affected page. */
export function attentionForPages(pages: readonly PageInput[]): PageAttention[] {
  return pages.map((p) => assessAttention(p).attention).filter((a): a is PageAttention => a !== null);
}
