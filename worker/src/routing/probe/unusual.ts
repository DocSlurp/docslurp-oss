/** Unusual/unsupported features (H9): flagged, never silently dropped. Mirrors page_probe.py. */
import type { ProbeBindingDoc, ProbeBindingPage } from "./binding.js";

const ANNOT_FEATURE: Record<string, string> = {
  Highlight: "annotation-highlight",
  Underline: "annotation-highlight",
  StrikeOut: "annotation-highlight",
  Squiggly: "annotation-highlight",
  Text: "annotation-text",
  FreeText: "annotation-freetext",
};
const MOSTLY_UNMAPPED = 0.5;
// Annotation subtypes that are not user annotations: widgets, links and popups.
const NOT_ANNOTATIONS = new Set(["Widget", "Link", "Popup"]);

/** Features whose content is NOT in the native text layer (or cannot be read): a trusted text layer is not the whole page. */
export const ATTENTION_FEATURES = new Set([
  "acroform-filled", "annotation-highlight", "annotation-text", "annotation-freetext", "attachment",
  "javascript", "ocg-hidden", "encrypted-user-password",
]);

export function documentFeatures(doc: ProbeBindingDoc, encrypted: boolean): Set<string> {
  const feats = new Set<string>();
  if (doc.attachments().length > 0) feats.add("attachment");
  if (encrypted) feats.add("encrypted-empty-password");
  for (const group of doc.optionalContent()) feats.add(group.visible ? "ocg-visible" : "ocg-hidden");
  if (doc.hasJavaScript()) feats.add("javascript");
  return feats;
}

export function pageUnusualFeatures(
  doc: ProbeBindingDoc,
  page: ProbeBindingPage,
  pageIndex: number,
  size: { widthPt: number; heightPt: number; rotation: number },
  rotatedTextRatio: number,
  unmappedRatio = 0,
): Set<string> {
  const feats = new Set<string>();
  const widgets = page.widgets();
  if (widgets.length > 0) {
    feats.add(widgets.some((w) => w.value !== undefined && w.value !== "" && w.value !== "Off" && w.value !== "false") ? "acroform-filled" : "acroform-empty");
  }
  for (const annot of page.annotations()) {
    if (NOT_ANNOTATIONS.has(annot.subtype)) continue;
    feats.add(ANNOT_FEATURE[annot.subtype] ?? "annotation-other");
  }
  for (const link of page.links()) {
    if (link.kind === "uri") feats.add("link-uri");
    else if (link.kind === "goto" || link.destPage !== undefined) feats.add("link-internal");
  }
  if (size.rotation) feats.add("rotated-page");
  else if (rotatedTextRatio >= 0.5) feats.add("rotated-content");
  if (Math.max(size.widthPt, size.heightPt) > 1600) feats.add("huge-page");
  let type3 = 0;
  let noToUnicode = 0;
  let type0 = 0;
  for (const font of doc.fonts(pageIndex)) {
    if (font.isType3 || font.type === "Type3") type3++;
    else if (font.type === "Type0") {
      type0++;
      if (!font.hasToUnicode) noToUnicode++;
    }
  }
  if (type3) feats.add("type3-font");
  // The binding counts a literal `/ToUnicode null` as present (upstream ask); a page whose glyphs are mostly unmapped betrays the gap.
  if (noToUnicode || (type0 > 0 && unmappedRatio >= MOSTLY_UNMAPPED)) feats.add("no-tounicode");
  return feats;
}
