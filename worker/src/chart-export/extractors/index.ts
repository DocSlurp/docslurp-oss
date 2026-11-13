import { CHART_EXTRACT_LIMITS, ExtractLimitError, pastGuestDeadline, refusalReason } from "./limits.js";
import { findEmbeddedSpecs, findEmbeddedSpecsInElements, type EmbeddedSpecHit } from "./embedded-spec.js";
import { asciiLower, indexFrom, type ScanWork } from "./scan.js";
import { extractOfficeCharts } from "./office-chart-xml.js";
import { openZipPackage } from "./safe-zip.js";
import { clamp01, finalizeChart } from "./spec-utils.js";
import { buildScene, type TextPrim } from "./svg-scene.js";
import { approximateVertexMarkers, prepareSvgChart, withoutVertexMarkers, type PreparedSvgChart, type SvgChartAnalysis } from "./svg-geometry.js";
import { detectDiagramGenerator, graphvizDiagram, mermaidFlowchart } from "./svg-diagram.js";
import { emptyVisual, type DeterministicDeferral, type DeterministicRefusal, type DeterministicVisual, type DeterministicVisualResult } from "./types.js";
import { parseXml, type XmlElement, type XmlNode } from "./xml.js";

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
  /**
   * A standalone SVG document (upload, Doppler figure, extracted media). `words`: text the SVG does not carry itself (a
   * PDF figure's axis labels, which Doppler keeps in the Markdown), as boxes in the SVG's own user space, y down.
   */
  | { kind: "svg"; text: string; words?: readonly SvgWord[] }
  /** HTML or XHTML text (embedded specs and inline SVG). */
  | { kind: "html"; text: string }
  /** A standalone JSON file (Vega-Lite / Plotly spec). */
  | { kind: "json"; text: string };

/** One word or text run placed on a figure: its box in the SVG's user units (y down); `rotated` for vertical labels. */
export interface SvgWord { text: string; x0: number; y0: number; x1: number; y1: number; rotated?: boolean }

/**
 * Words as scene text: a box's centre, its height as the font size (the scene's own text positions are centres too:
 * baseline minus ~0.35 em). Bounded: at most `maxSvgWords`, each label cut to 1,000 characters before it is normalized
 * and to 200 after, non-finite or inverted boxes dropped.
 */
export function wordsAsTexts(words: readonly SvgWord[] | undefined): TextPrim[] {
  if (!words?.length) return [];
  if (words.length > CHART_EXTRACT_LIMITS.maxSvgWords) throw new ExtractLimitError("svg-words-limit");
  const out: TextPrim[] = [];
  for (const [i, w] of words.entries()) {
    const text = typeof w?.text === "string" ? w.text.slice(0, 1000).replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const box = [w?.x0, w?.y0, w?.x1, w?.y1];
    if (!text || !box.every((n) => typeof n === "number" && Number.isFinite(n)) || !(w.x1 >= w.x0 && w.y1 > w.y0)) continue;
    const rotated = w.rotated === true;
    out.push({ kind: "text", groups: "", order: 1_000_000 + i, text, x: (w.x0 + w.x1) / 2, y: (w.y0 + w.y1) / 2, anchor: "middle", fontSize: rotated ? w.x1 - w.x0 : w.y1 - w.y0, rotated, fill: null });
  }
  return out;
}

export interface DeterministicVisualOptions {
  /** Also extract diagrams (Mermaid / Graphviz SVG). Default true. */
  diagrams?: boolean;
  /**
   * Unit checkpoints, for the guest's crash and timeout containment (scripts/chart-export-extract.mjs). A unit is one
   * SVG's analysis, one HTML / JSON embedded-spec scan, or one Office chart part, numbered in document order. Each unit
   * reports what it produced when it finishes; a later worker skips units already finished or failed, keeping SVG
   * ordinals and the visual cap where they were. Omitted (tests, in-process runs), extraction runs straight through.
   */
  units?: UnitControl;
}

/** What one unit produced: its visuals and refusals, deferral counts it added, and overflow it added. */
export interface UnitDelta {
  visuals: DeterministicVisual[];
  refusals: DeterministicRefusal[];
  deferred: DeterministicDeferral[];
  overflow: number;
}

export interface UnitControl {
  /** Units not to run again (finished by an earlier worker, or failed in it), with the visuals each produced. */
  skip: ReadonlyMap<number, number>;
  /** A unit is about to run: `svgIndex` is its SVG ordinal (or the next one, for a non-SVG unit). */
  onStart(id: number, locator: string, svgIndex: number, svg: boolean): void;
  onDone(id: number, delta: UnitDelta): void;
}

export type { DeterministicVisual, DeterministicVisualResult, DeterministicRefusal, DeterministicDeferral } from "./types.js";

/** Reason on an SVG chart whose marker/vertex de-duplication was approximated (over `maxMarkerPairTests`). */
export const APPROXIMATE_MARKER_REASON = "approximate-marker-dedup";
/** Reason on an SVG deferred because the input already had `maxSvgsPerInput` SVGs. */
export const DEFERRED_SVG_REASON = "svg-document-limit";
type DeferralReason = DeterministicDeferral["reason"];
/** Reasons whose `count` is of SVGs at consecutive ordinals from `svgIndex` (the others count parts or visuals). */


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
  /** Embedded-spec candidates and refusals past a per-input list cap or the deadline (counted, never silent). */
  overflow: number;
  /** Unit checkpoints (see `DeterministicVisualOptions.units`), the next unit's number, and visuals of skipped units. */
  units: UnitControl | null;
  unitSeq: number;
  baseVisuals: number;
  /** First unit after every skipped one: deadline checks before it would miscount finished units as lost. */
  resumeFrom: number;
}

/** Past the guest deadline, once past the units an earlier worker already finished or failed. */
const deadlineHere = (acc: Acc) => acc.unitSeq >= acc.resumeFrom && pastGuestDeadline();

/**
 * Run one unit under the unit checkpoints, if any: skip it when an earlier worker finished or failed it (an SVG unit
 * still takes its ordinal), otherwise run it and report what it added.
 */
function runUnit(acc: Acc, locator: string, svg: boolean, fn: () => void) {
  const ctl = acc.units;
  if (!ctl) return fn();
  const id = acc.unitSeq++;
  const skipped = ctl.skip.get(id);
  if (skipped !== undefined) {
    if (svg) acc.svgs++;
    acc.baseVisuals += skipped;
    if (acc.visuals.length + acc.baseVisuals >= CHART_EXTRACT_LIMITS.maxVisuals) acc.full = true;
    return;
  }
  const v0 = acc.visuals.length, r0 = acc.refusals.length, o0 = acc.overflow;
  const d0 = acc.deferred.map((d) => ({ ...d }));
  ctl.onStart(id, locator, acc.svgs, svg);
  fn();
  const deferred: DeterministicDeferral[] = [];
  acc.deferred.forEach((d, i) => {
    const before = i < d0.length && d0[i]!.reason === d.reason ? d0[i]!.count : 0;
    if (d.count > before) deferred.push({ svgIndex: d.svgIndex, count: d.count - before, reason: d.reason });
  });
  ctl.onDone(id, { visuals: acc.visuals.slice(v0), refusals: acc.refusals.slice(r0), deferred, overflow: acc.overflow - o0 });
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
  const single = reason === "visual-limit" || reason === "package-part-limit" || reason === "guest-deadline-part";
  if (same && (single || same.svgIndex + same.count === at || acc.deferred.length >= 1000)) same.count += count;
  else acc.deferred.push({ svgIndex: at, count, reason });
}

function pushVisual(acc: Acc, v: DeterministicVisual) {
  // At the output cap a visual is counted as lost to it (and the rest of the input is counted, not analysed), instead
  // of aborting the input with one uncounted refusal (council r6 L1).
  if (acc.visuals.length + acc.baseVisuals >= CHART_EXTRACT_LIMITS.maxVisuals) {
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

function embeddedHits(hits: EmbeddedSpecHit[], prefix: string, acc: Acc) {
  for (const hit of hits) {
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
function handleSvg(text: string, locator: string, options: DeterministicVisualOptions, acc: Acc, words?: readonly SvgWord[]) {
  // SVGs not analysed are recorded as counted ordinal ranges, never dropped: past the input's SVG count, past the output
  // cap, or past the guest's deadline (a backstop below the host timeout, so the input returns what it has).
  if (acc.svgs >= CHART_EXTRACT_LIMITS.maxSvgsPerInput) return addDeferral(acc, DEFERRED_SVG_REASON, 1, true);
  if (acc.full) return addDeferral(acc, "visual-limit", 1, true);
  if (deadlineHere(acc)) return addDeferral(acc, "guest-deadline", 1, true);
  runUnit(acc, locator, true, () => {
    acc.current = acc.svgs++;
    try {
      // Density gate, first check: raw bytes (the rest run while the scene is built).
      if (text.length > CHART_EXTRACT_LIMITS.maxSvgBytes) throw new ExtractLimitError("svg-too-large");
      const doc = parseXml(text, { keepComments: true });
      // Density gate: elements, attribute and text sizes, before the diagram (Mermaid / Graphviz) and geometry paths.
      gateDocument(doc);
      const before = acc.visuals.length;
      // Only the SVG's parsed <script> / <metadata> elements, never raw text (a comment could hide thousands of unclosed
      // `<script` starts; council r7 H1).
      const stats = { overflow: 0 };
      embeddedHits(findEmbeddedSpecsInElements(doc as unknown as XmlElement, stats), `${locator}/`, acc);
      acc.overflow += stats.overflow;
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
      const v = analyzeGeometry(prepareSvgChart(svgRoot, wordsAsTexts(words)), locator);
      if (v) pushVisual(acc, v);
    } catch (error) {
      if (error instanceof ExtractLimitError && error.reason === "visual-limit") throw error;
      acc.refusals.push({ locator, reason: refusalReason(error) });
    } finally {
      acc.current = null;
    }
  });
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

/**
 * Comment bodies of at most 300 characters in the first 64 KiB (the matches of `/<!--([\s\S]{0,300}?)-->/g`), with
 * indexOf: each close is searched for once and reused, so many unclosed `<!--` cost O(n), not O(n²).
 */
export function buildSignatures(text: string): string {
  const head = text.slice(0, 64 * 1024);
  const out: string[] = [];
  let close = -1;
  for (let i = head.indexOf("<!--"); i >= 0; ) {
    if (close < i + 4) close = head.indexOf("-->", i + 4);
    if (close < 0) break;
    if (close - (i + 4) <= 300) {
      out.push(head.slice(i + 4, close));
      if (out.length > 20) break;
      i = head.indexOf("<!--", close + 3);
    } else i = head.indexOf("<!--", i + 1);
  }
  return out.join("\n");
}

const wordAt = (s: string, i: number) => { const c = s.charCodeAt(i); return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; };

/** Next `<svg` (opening) or `</svg` (closing) tag start at or after `from` with a word boundary after the name, or -1. */
interface SvgTagCursor { open: number; close: number }

/** `cursor` keeps each needle's next position, re-searched only once the scan has passed it (-2: not searched yet). */
function nextSvgTag(lower: string, from: number, cursor: SvgTagCursor, work?: ScanWork): { at: number; closing: boolean } | null {
  for (let i = from; ; ) {
    if (cursor.open !== -1 && cursor.open < i) cursor.open = indexFrom(work, lower, "<svg", i);
    if (cursor.close !== -1 && cursor.close < i) cursor.close = indexFrom(work, lower, "</svg", i);
    const o = cursor.open, c = cursor.close;
    if (o < 0 && c < 0) return null;
    const closing = c >= 0 && (o < 0 || c < o);
    const at = closing ? c : o;
    if (!wordAt(lower, at + (closing ? 5 : 4))) return { at, closing };
    i = at + 1;
  }
}

/**
 * The HTML text with every `<svg …>…</svg>` region removed, as `/<svg\b[\s\S]*?<\/svg\s*>/gi` replaced with "": one linear
 * pass. Once an `<svg` has no `</svg>` after it, none later can either, so the rest is kept as is.
 */
export function stripInlineSvgs(html: string, work?: ScanWork): string {
  const lower = asciiLower(html);
  let out = "";
  let i = 0;
  for (;;) {
    let open = -1;
    for (let p = indexFrom(work, lower, "<svg", i); p >= 0; p = indexFrom(work, lower, "<svg", p + 1)) if (!wordAt(lower, p + 4)) { open = p; break; }
    if (open < 0) break;
    let end = -1;
    for (let c = indexFrom(work, lower, "</svg", open + 4); c >= 0; c = indexFrom(work, lower, "</svg", c + 1)) {
      let k = c + 5;
      while (k < lower.length && /\s/.test(lower[k]!)) k++;
      if (lower[k] === ">") { end = k + 1; break; }
    }
    if (end < 0) break;
    out += html.slice(i, open);
    i = end;
  }
  return out + html.slice(i);
}

/** `<svg>...</svg>` regions in HTML (outermost only). */
/** `<svg>...</svg>` regions in HTML (outermost only). Past `max`, regions are counted in `dropped`, not returned. */
export function inlineSvgs(html: string, max = CHART_EXTRACT_LIMITS.maxPartsPerPackage, dropped?: { count: number }, work?: ScanWork): string[] {
  // The tags `/<(\/?)svg\b[^>]*?(\/?)>/gi` matches, found with indexOf (linear; that regex rescans to the end for every
  // start with no `>` after it, council r7 H1). A start with no `>` after it ends the scan: no later tag can match.
  const out: string[] = [];
  const lower = asciiLower(html);
  let depth = 0;
  let start = -1;
  const cursor: SvgTagCursor = { open: -2, close: -2 };
  for (let i = 0; ; ) {
    const tag = nextSvgTag(lower, i, cursor, work);
    if (!tag) break;
    const gt = indexFrom(work, lower, ">", tag.at);
    if (gt < 0) break;
    const end = gt + 1;
    if (tag.closing) {
      if (depth > 0 && --depth === 0 && start >= 0) {
        if (out.length < max) out.push(html.slice(start, end));
        else if (dropped) dropped.count++;
        else break;
        start = -1;
      }
    } else if (lower[gt - 1] !== "/") {
      if (depth++ === 0) start = tag.at;
    }
    i = end;
  }
  return out;
}

function handleHtml(text: string, prefix: string, options: DeterministicVisualOptions, acc: Acc) {
  if (text.length > CHART_EXTRACT_LIMITS.maxTextBytes) { acc.refusals.push({ locator: prefix || "html", reason: "html-too-large" }); return; }
  runUnit(acc, prefix || "html", false, () => {
    try {
      // Deadline per part: past it the part's embedded specs are counted, not scanned (its SVGs defer on their own).
      if (deadlineHere(acc)) acc.overflow++;
      else {
        const stats = { overflow: 0 };
        embeddedHits(findEmbeddedSpecs(stripInlineSvgs(text), stats), prefix, acc);
        acc.overflow += stats.overflow;
      }
    } catch (error) {
      acc.refusals.push({ locator: prefix || "html", reason: refusalReason(error) });
    }
  });
  const dropped = { count: 0 };
  inlineSvgs(text, CHART_EXTRACT_LIMITS.maxPartsPerPackage, dropped).forEach((svg, k) => handleSvg(svg, `${prefix}svg[${k}]`, options, acc));
  // Inline SVGs past the per-part cap: counted as an ordinal range after this part's analysed ones (council r6 L1).
  addDeferral(acc, "html-svg-limit", dropped.count, true);
}

export function extractDeterministicVisuals(input: DeterministicVisualInput, options: DeterministicVisualOptions = {}): DeterministicVisualResult {
  const skipIds = options.units ? [...options.units.skip.keys()] : [];
  const acc: Acc = { visuals: [], refusals: [], deferred: [], svgs: 0, full: false, current: null, overflow: 0, units: options.units ?? null, unitSeq: 0, baseVisuals: 0, resumeFrom: skipIds.length ? Math.max(...skipIds) + 1 : 0 };
  // Package parts past maxPartsPerPackage, recorded after the analysed parts (so svgIndex is the next ordinal).
  let partsDropped = 0;
  try {
    switch (input.kind) {
      case "svg": handleSvg(input.text, "svg", options, acc, input.words); break;
      case "html": handleHtml(input.text, "", options, acc); break;
      case "json":
        if (input.text.length > CHART_EXTRACT_LIMITS.maxTextBytes) acc.refusals.push({ locator: "json", reason: "json-too-large" });
        else runUnit(acc, "json", false, () => { const stats = { overflow: 0 }; embeddedHits(findEmbeddedSpecs(input.text, stats), "", acc); acc.overflow += stats.overflow; });
        break;
      case "office": {
        // Each chart part is its own unit; its visual goes straight to the output in document order.
        const { pkg, partsDropped: chartParts, deadlineParts } = extractOfficeCharts(input.bytes, {
          unit: (part, fn) => runUnit(acc, part, false, fn),
          deadline: () => deadlineHere(acc),
          visual: (v) => pushVisual(acc, v),
          refusal: (r) => acc.refusals.push(r),
        });
        // Chart XML parts past the package cap, and any the deadline stopped: counted (council r7 L1).
        addDeferral(acc, "package-part-limit", chartParts, false);
        addDeferral(acc, "guest-deadline-part", deadlineParts, false);
        const allMedia = pkg.names.filter((n) => /^(word|ppt|xl)\/media\/[^/]+\.svg$/i.test(n));
        const media = allMedia.slice(0, CHART_EXTRACT_LIMITS.maxPartsPerPackage);
        partsDropped = allMedia.length - media.length;

        for (const [p, name] of media.entries()) {
          if (deadlineHere(acc)) { addDeferral(acc, "guest-deadline-part", media.length - p, false); break; }
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

        for (const [p, name] of parts.entries()) {
          if (deadlineHere(acc)) { addDeferral(acc, "guest-deadline-part", parts.length - p, false); break; }
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
    // Refusals past the 1,000 kept, and embedded-spec candidates past their caps or the deadline: one count.
    ...(acc.overflow + Math.max(0, refusals.length - 1000) > 0 ? { overflow: acc.overflow + Math.max(0, refusals.length - 1000) } : {}),
    // Only when something was deferred, so every other result keeps today's exact shape (and older hosts accept it).
    ...(acc.deferred.length ? { deferred: acc.deferred } : {}),
  };
}

/** Exposed for tests of the SVG scene builder. */
export { buildScene };
