import { CHART_EXTRACT_LIMITS, ExtractLimitError, pastGuestDeadline, refusalReason } from "./limits.js";
import { findEmbeddedSpecs } from "./embedded-spec.js";
import { extractOfficeCharts } from "./office-chart-xml.js";
import { openZipPackage } from "./safe-zip.js";
import { clamp01, finalizeChart } from "./spec-utils.js";
import { buildScene } from "./svg-scene.js";
import { approximateVertexMarkers, prepareSvgChart, withoutVertexMarkers, type PreparedSvgChart, type SvgChartAnalysis } from "./svg-geometry.js";
import { detectDiagramGenerator, graphvizDiagram, mermaidFlowchart } from "./svg-diagram.js";
import { emptyVisual, type DeterministicDeferral, type DeterministicRefusal, type DeterministicVisual, type DeterministicVisualResult } from "./types.js";
import { parseXml, type XmlNode } from "./xml.js";

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
}

export type { DeterministicVisual, DeterministicVisualResult, DeterministicRefusal, DeterministicDeferral } from "./types.js";

/** Reason on an SVG chart whose marker/vertex de-duplication was approximated (over `maxMarkerPairTests`). */
export const APPROXIMATE_MARKER_REASON = "approximate-marker-dedup";
/** Reason on an SVG deferred because the input already had `maxSvgsPerInput` SVGs. */
export const DEFERRED_SVG_REASON = "svg-document-limit";
type DeferralReason = DeterministicDeferral["reason"];
/** Reasons whose `count` is of SVGs at consecutive ordinals from `svgIndex` (the others count parts or visuals). */
const SVG_RANGE_REASONS = new Set<DeferralReason>(["svg-document-limit", "html-svg-limit", "guest-deadline", "visual-limit"]);

/*
 * SVG handling is bounded per SVG, not scheduled: the density gate (`limits.ts`, checked in `handleSvg` and while
 * `buildScene` walks) skips an over-dense SVG at O(bytes) and keeps nothing; under it, one SVG's scene is at most
 * 3,000 walked frames (every `<use>` re-walk counted), 4,000 primitives and 50,000 segments, so its analysis is
 * bounded too. An input analyses at most `maxSvgsPerInput` SVGs; later ones are deferred as one counted ordinal range. Every visual finished before a skipped, failed or deferred SVG is kept.
 */
interface Acc {
  visuals: DeterministicVisual[];
  refusals: DeterministicRefusal[];
  deferred: DeterministicDeferral[];
  /** SVGs seen in this input, in document / package order (the ordinal a deferral records). */
  svgs: number;
  /** The input reached `maxVisuals`: later visuals and SVGs are counted, not produced. */
  full: boolean;
  /** Ordinal of the SVG being analysed, if any (where a visual lost to the output cap came from). */
  current: number | null;
}

/**
 * Record `count` items not processed because of a per-input cap, so nothing is lost uncounted. SVG ranges advance the
 * ordinal and merge with the previous range of the same reason when contiguous; part and visual counts merge into the
 * input's entry of that reason. At most a few entries per input (one per reason, one per HTML part over its cap).
 */
function addDeferral(acc: Acc, reason: DeferralReason, count: number, advanceSvgs: boolean, at: number = acc.svgs) {
  if (count <= 0) return;
  if (advanceSvgs) acc.svgs += count;
  let same: DeterministicDeferral | undefined;
  for (let i = acc.deferred.length - 1; i >= 0 && !same; i--) if (acc.deferred[i]!.reason === reason) same = acc.deferred[i];
  // One entry per input for the output cap and for package parts; SVG ranges merge when contiguous.
  const single = reason === "visual-limit" || reason === "package-part-limit";
  if (same && (single || same.svgIndex + same.count === at || acc.deferred.length >= 1000)) same.count += count;
  else acc.deferred.push({ svgIndex: at, count, reason });
}

function pushVisual(acc: Acc, v: DeterministicVisual) {
  // At the output cap a visual is counted as lost to it (and the rest of the input is counted, not analysed), instead
  // of aborting the input with one uncounted refusal (council r6 L1).
  if (acc.visuals.length >= CHART_EXTRACT_LIMITS.maxVisuals) {
    acc.full = true;
    addDeferral(acc, "visual-limit", 1, false, acc.current ?? acc.svgs);
    return;
  }
  acc.visuals.push(v);
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

/** Exact marker/vertex de-duplication within `maxMarkerPairTests`; over it, the bounded approximation. */
function analyzeGeometry(prepared: PreparedSvgChart, locator: string): DeterministicVisual | null {
  try {
    return geometryVisual(prepared.complete(withoutVertexMarkers(prepared.markers, prepared.lines)), locator, false);
  } catch (error) {
    if (!(error instanceof ExtractLimitError && error.reason === "svg-marker-limit")) throw error;
    return geometryVisual(prepared.complete(approximateVertexMarkers(prepared.markers, prepared.lines)), locator, true);
  }
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
  // SVGs not analysed are recorded as counted ordinal ranges, never dropped: past the input's SVG count, past the output
  // cap, or past the guest's deadline (a backstop below the host timeout, so the input returns what it has).
  if (acc.svgs >= CHART_EXTRACT_LIMITS.maxSvgsPerInput) return addDeferral(acc, DEFERRED_SVG_REASON, 1, true);
  if (acc.full) return addDeferral(acc, "visual-limit", 1, true);
  if (pastGuestDeadline()) return addDeferral(acc, "guest-deadline", 1, true);
  acc.current = acc.svgs++;
  try {
    // Density gate, first check: raw bytes (the rest run while the scene is built).
    if (text.length > CHART_EXTRACT_LIMITS.maxSvgBytes) throw new ExtractLimitError("svg-too-large");
    const doc = parseXml(text, { keepComments: true });
    // Density gate: elements, attribute and text sizes, before the diagram (Mermaid / Graphviz) and geometry paths.
    gateDocument(doc);
    const before = acc.visuals.length;
    if (/<(?:script|metadata)\b/i.test(text)) embeddedHits(text, `${locator}/`, acc);
    if (acc.visuals.length > before && acc.visuals.slice(before).some((v) => v.spec)) return;
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
    const v = analyzeGeometry(prepareSvgChart(svgRoot), locator);
    if (v) pushVisual(acc, v);
  } catch (error) {
    if (error instanceof ExtractLimitError && error.reason === "visual-limit") throw error;
    acc.refusals.push({ locator, reason: refusalReason(error) });
  } finally {
    acc.current = null;
  }
}

/** Elements whose text the walk never reads per frame (signatures slice it; embedded specs have their own limits). */
const TEXT_EXEMPT = new Set(["script", "style", "metadata", "desc", "title"]);

/**
 * The parse-time half of the density gate, one pass over the parsed SVG: element count, attribute lengths (`d` /
 * `points` and every other attribute but `href`, which is only looked up) and text under each element. Throws
 * `svg-too-dense` past any of them, so no per-frame helper ever sees an over-long value.
 */
function gateDocument(doc: { children: XmlNode[] }) {
  const L = CHART_EXTRACT_LIMITS;
  let n = 0;
  const stack: XmlNode[] = [...doc.children];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type !== "element") continue;
    if (++n > L.maxSvgElements) throw new ExtractLimitError("svg-too-dense");
    for (const k in node.attrs) {
      if (k === "href" || k === "xlink:href") continue;
      const len = node.attrs[k]!.length;
      if (len > (k === "d" || k === "points" ? L.maxSvgGeometryAttrBytes : L.maxSvgAttrBytes)) throw new ExtractLimitError("svg-too-dense");
    }
    let text = 0;
    for (const c of node.children) {
      if (c.type === "element") stack.push(c);
      else if (c.type === "text") text += c.value.length;
    }
    if (text > L.maxSvgTextBytes && !TEXT_EXEMPT.has(node.local)) throw new ExtractLimitError("svg-too-dense");
  }
}

function buildSignatures(text: string): string {
  const out: string[] = [];
  for (const m of text.slice(0, 64 * 1024).matchAll(/<!--([\s\S]{0,300}?)-->/g)) { out.push(m[1]!); if (out.length > 20) break; }
  return out.join("\n");
}

/** `<svg>...</svg>` regions in HTML (outermost only). */
/** `<svg>...</svg>` regions in HTML (outermost only). Past `max`, regions are counted in `dropped`, not returned. */
export function inlineSvgs(html: string, max = CHART_EXTRACT_LIMITS.maxPartsPerPackage, dropped?: { count: number }): string[] {
  const out: string[] = [];
  const re = /<(\/?)svg\b[^>]*?(\/?)>/gi;
  let depth = 0;
  let start = -1;
  for (const m of html.matchAll(re)) {
    if (m[1]) {
      if (depth > 0 && --depth === 0 && start >= 0) {
        if (out.length < max) out.push(html.slice(start, m.index! + m[0].length));
        else if (dropped) dropped.count++;
        else break;
        start = -1;
      }
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
  const dropped = { count: 0 };
  inlineSvgs(text, CHART_EXTRACT_LIMITS.maxPartsPerPackage, dropped).forEach((svg, k) => handleSvg(svg, `${prefix}svg[${k}]`, options, acc));
  // Inline SVGs past the per-part cap: counted as an ordinal range after this part's analysed ones (council r6 L1).
  addDeferral(acc, "html-svg-limit", dropped.count, true);
}

export function extractDeterministicVisuals(input: DeterministicVisualInput, options: DeterministicVisualOptions = {}): DeterministicVisualResult {
  const acc: Acc = { visuals: [], refusals: [], deferred: [], svgs: 0, full: false, current: null };
  // Package parts past maxPartsPerPackage, recorded after the analysed parts (so svgIndex is the next ordinal).
  let partsDropped = 0;
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
        visuals.forEach((v) => pushVisual(acc, v));
        acc.refusals.push(...refusals);
        const allMedia = pkg.names.filter((n) => /^(word|ppt|xl)\/media\/[^/]+\.svg$/i.test(n));
        const media = allMedia.slice(0, CHART_EXTRACT_LIMITS.maxPartsPerPackage);
        partsDropped = allMedia.length - media.length;

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
        const allParts = pkg.names.filter((n) => /\.(x?html?|svg)$/i.test(n)).sort();
        const parts = allParts.slice(0, CHART_EXTRACT_LIMITS.maxPartsPerPackage);
        partsDropped = allParts.length - parts.length;

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
  // Media SVGs / EPUB parts past the package cap: counted (as parts), never silently skipped (council r6 L1).
  addDeferral(acc, "package-part-limit", partsDropped, false);
  const { visuals, refusals } = acc;
  const cap = (s: string | null, n: number) => (s === null ? null : s.slice(0, n));
  return {
    schemaVersion: "chart-export-deterministic@v1",
    visuals: visuals.map((v) => ({ ...v, locator: v.locator.slice(0, 512), sheet: cap(v.sheet, 200), generator: cap(v.generator, 40), reason: cap(v.reason, 120), digest: cap(v.digest, CHART_EXTRACT_LIMITS.maxDigestChars) })),
    refusals: refusals.slice(0, 1000).map((r) => ({ locator: r.locator.slice(0, 512), reason: r.reason.slice(0, 120) })),
    // Only when something was deferred, so every other result keeps today's exact shape (and older hosts accept it).
    ...(acc.deferred.length ? { deferred: acc.deferred } : {}),
  };
}

/** Exposed for tests of the SVG scene builder. */
export { buildScene };
