import { CHART_EXTRACT_LIMITS, ExtractLimitError, refusalReason } from "./limits.js";
import { findEmbeddedSpecs } from "./embedded-spec.js";
import { extractOfficeCharts } from "./office-chart-xml.js";
import { openZipPackage } from "./safe-zip.js";
import { clamp01, finalizeChart } from "./spec-utils.js";
import { buildScene, type TextPrim } from "./svg-scene.js";
import { analyzeSvgChart } from "./svg-geometry.js";
import { detectDiagramGenerator, graphvizDiagram, mermaidFlowchart } from "./svg-diagram.js";
import { emptyVisual, type DeterministicRefusal, type DeterministicVisual, type DeterministicVisualResult } from "./types.js";
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
 * baseline minus ~0.35 em). Bounded: at most `maxSvgWords`, each label capped, non-finite or inverted boxes dropped.
 */
export function wordsAsTexts(words: readonly SvgWord[] | undefined): TextPrim[] {
  if (!words?.length) return [];
  if (words.length > CHART_EXTRACT_LIMITS.maxSvgWords) throw new ExtractLimitError("svg-words-limit");
  const out: TextPrim[] = [];
  for (const [i, w] of words.entries()) {
    const text = typeof w?.text === "string" ? w.text.replace(/\s+/g, " ").trim().slice(0, 200) : "";
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
}

export type { DeterministicVisual, DeterministicVisualResult, DeterministicRefusal } from "./types.js";

interface Acc { visuals: DeterministicVisual[]; refusals: DeterministicRefusal[] }

function pushVisual(acc: Acc, v: DeterministicVisual) {
  if (acc.visuals.length >= CHART_EXTRACT_LIMITS.maxVisuals) throw new ExtractLimitError("visual-limit");
  acc.visuals.push(v);
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
function handleSvg(text: string, locator: string, options: DeterministicVisualOptions, acc: Acc, words?: readonly SvgWord[]) {
  try {
    if (text.length > CHART_EXTRACT_LIMITS.maxTextBytes) throw new ExtractLimitError("svg-too-large");
    const doc = parseXml(text, { keepComments: true });
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
    const r = analyzeSvgChart(svgRoot, wordsAsTexts(words));
    if (!r.spec && (r.reason === "no-numeric-axis" || r.reason === "no-text")) return; // not a chart we can see
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
    pushVisual(acc, v);
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
  const acc: Acc = { visuals: [], refusals: [] };
  try {
    switch (input.kind) {
      case "svg": handleSvg(input.text, "svg", options, acc, input.words); break;
      case "html": handleHtml(input.text, "", options, acc); break;
      case "json":
        if (input.text.length > CHART_EXTRACT_LIMITS.maxTextBytes) acc.refusals.push({ locator: "json", reason: "json-too-large" });
        else embeddedHits(input.text, "", acc);
        break;
      case "office": {
        const { visuals, refusals, pkg } = extractOfficeCharts(input.bytes);
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
  const cap = (s: string | null, n: number) => (s === null ? null : s.slice(0, n));
  return {
    schemaVersion: "chart-export-deterministic@v1",
    visuals: acc.visuals.map((v) => ({ ...v, locator: v.locator.slice(0, 512), sheet: cap(v.sheet, 200), generator: cap(v.generator, 40), reason: cap(v.reason, 120), digest: cap(v.digest, CHART_EXTRACT_LIMITS.maxDigestChars) })),
    refusals: acc.refusals.slice(0, 1000).map((r) => ({ locator: r.locator.slice(0, 512), reason: r.reason.slice(0, 120) })),
  };
}

/** Exposed for tests of the SVG scene builder. */
export { buildScene };
