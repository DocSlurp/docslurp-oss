import { CHART_EXTRACT_LIMITS, ExtractLimitError, refusalReason } from "./limits.js";
import { findEmbeddedSpecs } from "./embedded-spec.js";
import { extractOfficeCharts } from "./office-chart-xml.js";
import { openZipPackage } from "./safe-zip.js";
import { clamp01, finalizeChart } from "./spec-utils.js";
import { buildScene, type PointPrim } from "./svg-scene.js";
import { approximateVertexMarkers, markerPairEstimate, prepareSvgChart, withoutVertexMarkers, type PreparedSvgChart, type SvgChartAnalysis } from "./svg-geometry.js";
import { detectDiagramGenerator, graphvizDiagram, mermaidFlowchart } from "./svg-diagram.js";
import { emptyVisual, type DeterministicDeferral, type DeterministicRefusal, type DeterministicVisual, type DeterministicVisualResult } from "./types.js";
import { parseXml } from "./xml.js";

/*
 * Guest-side entry for the deterministic rungs (office-chart-xml, embedded-spec, svg-geometry). Pure: no I/O, no
 * network, no model. It parses customer bytes, so production runs it only inside the parser VM (see `host.ts` and
 * `scripts/chart-export-extract.mjs`); calling it in-process is for tests and local development.
 */

export type DeterministicVisualInput =
  /** DOCX / PPTX / XLSX package bytes. */
  | { kind: "office"; bytes: Uint8Array }
  /** EPUB package bytes (XHTML chapters and SVG files inside). */
  | { kind: "epub"; bytes: Uint8Array }
  /** A standalone SVG document (upload, Doppler figure, extracted media). */
  | { kind: "svg"; text: string }
  /** HTML or XHTML text (embedded specs and inline SVG). */
  | { kind: "html"; text: string }
  /** A standalone JSON file (Vega-Lite / Plotly spec). */
  | { kind: "json"; text: string };

export interface DeterministicVisualOptions {
  /** Also extract diagrams (Mermaid / Graphviz SVG). Default true. */
  diagrams?: boolean;
  /** Pages of the document the input belongs to, when known (a PDF's Doppler figures): scales the SVG budget. */
  pages?: number;
  /**
   * The svg-geometry budget shared by every SVG of one call. Omitted, each call gets `markerBudget(pages)` (PPTX: its
   * slide count). A guest batch passes one budget to every call, with `inputsAfter` counting the inputs still to come,
   * so the budget bounds the whole batch.
   */
  markerBudget?: MarkerBudget;
}

export type { DeterministicVisual, DeterministicVisualResult, DeterministicRefusal, DeterministicDeferral } from "./types.js";

/**
 * What the svg-geometry marker/vertex de-duplication may still spend across one input or batch (see `limits.ts`).
 * Fair shares instead of first come: SVGs whose estimate is small run exactly in place; the rest wait, then run
 * cheapest first, each with at most `min(maxMarkerPairTests, remaining / SVGs left)`. An SVG over its share is
 * approximated (`approximate-marker-dedup`, confidence capped below 0.85); past the scene ceiling, later SVGs are
 * deferred. Nothing is refused for budget, and every finished visual is kept.
 */
export interface MarkerBudget {
  /** Pair tests still available. */
  remaining: number;
  /** Pair tests run so far. */
  pairTests: number;
  /** Scene primitives built so far (`maxSvgScenePrimitivesPerInput`). */
  primitives: number;
  /** Inputs after the current call that share this budget (a guest batch), so shares leave room for them. */
  inputsAfter: number;
}

/** A fresh budget: `markerPairTestsBase`, or `markerPairTestsPerPage` × pages when larger, never over the ceiling. */
export function markerBudget(pages?: number | null): MarkerBudget {
  const L = CHART_EXTRACT_LIMITS;
  const paged = pages && Number.isSafeInteger(pages) && pages > 0 ? Math.max(L.markerPairTestsBase, pages * L.markerPairTestsPerPage) : L.markerPairTestsBase;
  return { remaining: Math.min(L.maxMarkerPairTestsPerInput, paged), pairTests: 0, primitives: 0, inputsAfter: 0 };
}

/** Reason on an SVG chart whose marker/vertex de-duplication was approximated. */
export const APPROXIMATE_MARKER_REASON = "approximate-marker-dedup";
/** Reason on an SVG deferred because the input's scene ceiling was reached. */
export const DEFERRED_SVG_REASON = "svg-scene-budget";

/** A geometry visual held for its fair share: reserves its place in both output lists, so output order is stable. */
class Slot {
  visual: DeterministicVisual | null = null;
  refusal: DeterministicRefusal | null = null;
}

interface Pending { slot: Slot; locator: string; prepared: PreparedSvgChart | null; estimate: number; order: number }

interface Acc {
  visuals: Array<DeterministicVisual | Slot>;
  refusals: Array<DeterministicRefusal | Slot>;
  deferred: DeterministicDeferral[];
  budget: MarkerBudget;
  pending: Pending[];
  pendingPrimitives: number;
}

function pushVisual(acc: Acc, v: DeterministicVisual | Slot) {
  if (acc.visuals.length >= CHART_EXTRACT_LIMITS.maxVisuals) throw new ExtractLimitError("visual-limit");
  acc.visuals.push(v);
}

function charge(budget: MarkerBudget, tests: number) {
  budget.pairTests += tests;
  budget.remaining = Math.max(0, budget.remaining - tests);
}

/** The svg-geometry visual for an analysis, or null when it is not a chart we can see. */
function geometryVisual(r: SvgChartAnalysis, locator: string, approximate: boolean): DeterministicVisual | null {
  if (!r.spec && (r.reason === "no-numeric-axis" || r.reason === "no-text")) return null;
  const v = emptyVisual("svg-geometry", locator);
  v.generator = r.generator;
  v.digest = r.digest;
  v.reason = r.reason;
  if (r.spec) {
    const fin = finalizeChart(r.spec);
    v.spec = fin.spec;
    v.confidence = fin.spec ? clamp01(r.confidence - (fin.truncated ? 0.1 : 0)) : 0;
    v.reason = fin.reason ?? (fin.truncated ? "truncated" : r.reason);
  }
  if (approximate) {
    v.reason = APPROXIMATE_MARKER_REASON;
    v.confidence = Math.min(v.confidence, CHART_EXTRACT_LIMITS.approximateMaxConfidence);
  }
  return v;
}

/** Pass 1: de-duplicate a cheap SVG now; hold an expensive one for its share; approximate one that cannot be held. */
function scheduleGeometry(prepared: PreparedSvgChart, locator: string, acc: Acc) {
  const L = CHART_EXTRACT_LIMITS;
  const push = (markers: PointPrim[], approximate: boolean) => {
    const v = geometryVisual(prepared.complete(markers), locator, approximate);
    if (v) pushVisual(acc, v);
  };
  if (!prepared.markers.length || !prepared.lines.length) return push(prepared.markers, false);
  if (prepared.vertices > L.maxMarkerVertices) return push(approximateVertexMarkers(prepared.markers, prepared.lines), true);
  const estimate = markerPairEstimate(prepared.markers, prepared.lines);
  if (estimate <= L.cheapMarkerPairTests && estimate <= acc.budget.remaining) {
    // The estimate bounds the exact pass, so it always finishes inside what remains.
    const work = { pairTests: 0 };
    const markers = withoutVertexMarkers(prepared.markers, prepared.lines, work, Infinity);
    charge(acc.budget, work.pairTests);
    return push(markers, false);
  }
  const held = prepared.markers.length + prepared.vertices;
  if (acc.pendingPrimitives + held > L.maxPendingMarkerPrimitives) return push(approximateVertexMarkers(prepared.markers, prepared.lines), true);
  const slot = new Slot();
  pushVisual(acc, slot);
  acc.refusals.push(slot);
  acc.pendingPrimitives += held;
  acc.pending.push({ slot, locator, prepared, estimate, order: acc.pending.length });
}

/**
 * Pass 2: the held SVGs, cheapest estimate first (document order on ties), each exact within
 * `min(maxMarkerPairTests, remaining / SVGs left)` and approximated if it runs over. Deterministic: the order, shares
 * and pair counts depend only on the input.
 */
function runPending(acc: Acc) {
  const pending = [...acc.pending].sort((a, b) => a.estimate - b.estimate || a.order - b.order);
  pending.forEach((p, k) => {
    const prepared = p.prepared!;
    p.prepared = null;
    try {
      const left = pending.length - k + Math.max(0, acc.budget.inputsAfter);
      const share = Math.min(CHART_EXTRACT_LIMITS.maxMarkerPairTests, Math.floor(acc.budget.remaining / left));
      const work = { pairTests: 0 };
      let markers: PointPrim[];
      let approximate = false;
      try {
        markers = withoutVertexMarkers(prepared.markers, prepared.lines, work, share);
      } catch (error) {
        if (!(error instanceof ExtractLimitError && error.reason === "svg-marker-limit")) throw error;
        markers = approximateVertexMarkers(prepared.markers, prepared.lines);
        approximate = true;
      }
      charge(acc.budget, Math.min(work.pairTests, share));
      p.slot.visual = geometryVisual(prepared.complete(markers), p.locator, approximate);
    } catch (error) {
      p.slot.refusal = { locator: p.locator, reason: refusalReason(error) };
    }
  });
  acc.pending = [];
  acc.pendingPrimitives = 0;
}

function embeddedHits(text: string, prefix: string, acc: Acc) {
  for (const hit of findEmbeddedSpecs(text)) {
    const v = emptyVisual("embedded-spec", `${prefix}${hit.locator}`);
    v.generator = hit.generator;
    v.reason = hit.reason;
    if (hit.spec) {
      const fin = finalizeChart(hit.spec);
      v.spec = fin.spec;
      v.confidence = fin.spec ? clamp01(hit.confidence - (fin.truncated ? 0.1 : 0)) : 0;
      v.reason = fin.reason ?? (fin.truncated ? "truncated" : hit.reason);
    }
    pushVisual(acc, v);
  }
}

/** One SVG document → at most one visual (a diagram, an embedded spec, or a geometry chart). */
function handleSvg(text: string, locator: string, options: DeterministicVisualOptions, acc: Acc) {
  // Past the input's scene ceiling the SVG is not parsed: it is recorded for a later pass, never dropped.
  if (acc.budget.primitives >= CHART_EXTRACT_LIMITS.maxSvgScenePrimitivesPerInput) {
    acc.deferred.push({ locator, reason: DEFERRED_SVG_REASON });
    return;
  }
  try {
    if (text.length > CHART_EXTRACT_LIMITS.maxTextBytes) throw new ExtractLimitError("svg-too-large");
    const doc = parseXml(text, { keepComments: true });
    const before = acc.visuals.length;
    if (/<(?:script|metadata)\b/i.test(text)) embeddedHits(text, `${locator}/`, acc);
    if (acc.visuals.length > before && acc.visuals.slice(before).some((v) => !(v instanceof Slot) && v.spec)) return;
    const sigs = buildSignatures(text);
    const diagram = detectDiagramGenerator(doc, sigs);
    if (diagram) {
      if (options.diagrams === false) return;
      const r = diagram === "graphviz" ? graphvizDiagram(doc) : mermaidFlowchart(doc);
      const v = emptyVisual("svg-geometry", locator);
      v.kind = "diagram";
      v.generator = r.generator;
      v.spec = r.spec;
      v.confidence = r.spec ? clamp01(r.confidence) : 0;
      v.reason = r.spec ? r.reason : r.reason ?? "diagram-invalid";
      pushVisual(acc, v);
      return;
    }
    const svgRoot = doc.children.find((c) => c.type === "element" && c.local === "svg");
    if (!svgRoot || svgRoot.type !== "element") throw new ExtractLimitError("svg-no-root");
    const prepared = prepareSvgChart(svgRoot);
    acc.budget.primitives += prepared.primitives;
    scheduleGeometry(prepared, locator, acc);
  } catch (error) {
    if (error instanceof ExtractLimitError && error.reason === "visual-limit") throw error;
    acc.refusals.push({ locator, reason: refusalReason(error) });
  }
}

function buildSignatures(text: string): string {
  const out: string[] = [];
  for (const m of text.slice(0, 64 * 1024).matchAll(/<!--([\s\S]{0,300}?)-->/g)) { out.push(m[1]!); if (out.length > 20) break; }
  return out.join("\n");
}

/** `<svg>...</svg>` regions in HTML (outermost only). */
export function inlineSvgs(html: string, max = CHART_EXTRACT_LIMITS.maxPartsPerPackage): string[] {
  const out: string[] = [];
  const re = /<(\/?)svg\b[^>]*?(\/?)>/gi;
  let depth = 0;
  let start = -1;
  for (const m of html.matchAll(re)) {
    if (m[1]) {
      if (depth > 0 && --depth === 0 && start >= 0) { out.push(html.slice(start, m.index! + m[0].length)); start = -1; if (out.length >= max) break; }
    } else if (!m[2]) {
      if (depth++ === 0) start = m.index!;
    }
  }
  return out;
}

function handleHtml(text: string, prefix: string, options: DeterministicVisualOptions, acc: Acc) {
  if (text.length > CHART_EXTRACT_LIMITS.maxTextBytes) { acc.refusals.push({ locator: prefix || "html", reason: "html-too-large" }); return; }
  try {
    embeddedHits(text.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, ""), prefix, acc);
  } catch (error) {
    if (error instanceof ExtractLimitError && error.reason === "visual-limit") throw error;
    acc.refusals.push({ locator: prefix || "html", reason: refusalReason(error) });
  }
  inlineSvgs(text).forEach((svg, k) => handleSvg(svg, `${prefix}svg[${k}]`, options, acc));
}

export function extractDeterministicVisuals(input: DeterministicVisualInput, options: DeterministicVisualOptions = {}): DeterministicVisualResult {
  const acc: Acc = { visuals: [], refusals: [], deferred: [], budget: options.markerBudget ?? markerBudget(options.pages), pending: [], pendingPrimitives: 0 };
  try {
    switch (input.kind) {
      case "svg": handleSvg(input.text, "svg", options, acc); break;
      case "html": handleHtml(input.text, "", options, acc); break;
      case "json":
        if (input.text.length > CHART_EXTRACT_LIMITS.maxTextBytes) acc.refusals.push({ locator: "json", reason: "json-too-large" });
        else embeddedHits(input.text, "", acc);
        break;
      case "office": {
        const { visuals, refusals, pkg } = extractOfficeCharts(input.bytes);
        // A deck has a page count (its slides); documents and workbooks keep the base budget.
        if (!options.markerBudget && !options.pages) {
          const slides = pkg.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).length;
          if (slides > 0) acc.budget = markerBudget(slides);
        }
        visuals.forEach((v) => pushVisual(acc, v));
        acc.refusals.push(...refusals);
        const media = pkg.names.filter((n) => /^(word|ppt|xl)\/media\/[^/]+\.svg$/i.test(n)).slice(0, CHART_EXTRACT_LIMITS.maxPartsPerPackage);
        for (const name of media) {
          try { handleSvg(pkg.readText(name), name, options, acc); } catch (error) {
            if (error instanceof ExtractLimitError && error.reason === "visual-limit") throw error;
            acc.refusals.push({ locator: name, reason: refusalReason(error) });
          }
        }
        break;
      }
      case "epub": {
        const pkg = openZipPackage(input.bytes);
        const parts = pkg.names.filter((n) => /\.(x?html?|svg)$/i.test(n)).sort().slice(0, CHART_EXTRACT_LIMITS.maxPartsPerPackage);
        for (const name of parts) {
          try {
            const text = pkg.readText(name);
            if (/\.svg$/i.test(name)) handleSvg(text, name, options, acc);
            else handleHtml(text, `${name}#`, options, acc);
          } catch (error) {
            if (error instanceof ExtractLimitError && error.reason === "visual-limit") throw error;
            acc.refusals.push({ locator: name, reason: refusalReason(error) });
          }
        }
        break;
      }
    }
  } catch (error) {
    acc.refusals.push({ locator: input.kind, reason: refusalReason(error) });
  }
  // Held SVGs finish even when a later part of the input failed: finished and held work is never dropped.
  runPending(acc);
  const visuals = acc.visuals.flatMap((v) => (v instanceof Slot ? (v.visual ? [v.visual] : []) : [v]));
  const refusals = acc.refusals.flatMap((r) => (r instanceof Slot ? (r.refusal ? [r.refusal] : []) : [r]));
  const cap = (s: string | null, n: number) => (s === null ? null : s.slice(0, n));
  return {
    schemaVersion: "chart-export-deterministic@v1",
    visuals: visuals.map((v) => ({ ...v, locator: v.locator.slice(0, 512), sheet: cap(v.sheet, 200), generator: cap(v.generator, 40), reason: cap(v.reason, 120), digest: cap(v.digest, CHART_EXTRACT_LIMITS.maxDigestChars) })),
    refusals: refusals.slice(0, 1000).map((r) => ({ locator: r.locator.slice(0, 512), reason: r.reason.slice(0, 120) })),
    // Only when something was deferred, so every other result keeps today's exact shape (and older hosts accept it).
    ...(acc.deferred.length ? { deferred: acc.deferred.slice(0, 1000).map((d) => ({ locator: d.locator.slice(0, 512), reason: d.reason.slice(0, 120) })) } : {}),
  };
}

/** Exposed for tests of the SVG scene builder. */
export { buildScene };
