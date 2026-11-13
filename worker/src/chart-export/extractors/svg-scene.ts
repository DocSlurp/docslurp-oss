import { CHART_EXTRACT_LIMITS, ExtractLimitError, pastGuestDeadline } from "./limits.js";
import { IDENTITY, apply, multiply, newPathBudget, parsePathData, parseTransform, type Matrix } from "./svg-path.js";
import { cleanLabel, normalizeColor } from "./text.js";
import { elementChildren, textContent, type XmlElement } from "./xml.js";

/*
 * Flatten an SVG tree into absolute-coordinate primitives (texts, rects, polylines, point markers). Transforms are
 * composed down the tree, `<use>` references are expanded with a budget, and every primitive keeps its ancestors' ids
 * and classes so generator adapters can tag axes, legends and series.
 */

export interface PrimBase { groups: string; order: number }
export interface TextPrim extends PrimBase { kind: "text"; text: string; x: number; y: number; anchor: "start" | "middle" | "end"; fontSize: number; rotated: boolean; fill: string | null }
export interface RectPrim extends PrimBase { kind: "rect"; x0: number; y0: number; x1: number; y1: number; fill: string | null; stroke: string | null }
export interface LinePrim extends PrimBase { kind: "line"; points: Array<[number, number]>; stroke: string | null; fill: string | null; closed: boolean; curves: number }
export interface PointPrim extends PrimBase { kind: "point"; x: number; y: number; size: number; fill: string | null; stroke: string | null }
export type Prim = TextPrim | RectPrim | LinePrim | PointPrim;

export interface Scene {
  texts: TextPrim[];
  rects: RectPrim[];
  lines: LinePrim[];
  points: PointPrim[];
  /** Raw comments and metadata text (generator signatures). */
  signatures: string;
  width: number | null;
  height: number | null;
}

interface Style { fill: string | null; stroke: string | null; fontSize: number; anchor: TextPrim["anchor"]; baseline: string; hidden: boolean }

const SKIP = new Set(["defs", "clipPath", "mask", "pattern", "marker", "symbol", "style", "script", "title", "desc", "metadata", "foreignObject", "linearGradient", "radialGradient", "filter"]);

function parseStyleAttr(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!raw) return out;
  for (const decl of raw.slice(0, 4096).split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return out;
}

function length(raw: string | undefined | null, font = 10): number | null {
  if (raw === undefined || raw === null) return null;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(px|pt|em|%)?/.exec(raw);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  if (m[2] === "pt") return v * 4 / 3;
  if (m[2] === "em") return v * font;
  return v;
}

function firstNum(raw: string | undefined): number | null {
  if (!raw) return null;
  // The first token, without splitting the whole attribute (same result as split(/[\s,]+/)[0] on the trimmed value).
  return length(/^[^\s,]*/.exec(raw.trim())![0]);
}

function deriveStyle(el: XmlElement, parent: Style): Style {
  const css = parseStyleAttr(el.attrs.style);
  const get = (name: string) => css[name] ?? el.attrs[name];
  const fill = get("fill");
  const stroke = get("stroke");
  const font = length(get("font-size"), parent.fontSize);
  const anchor = get("text-anchor");
  const baseline = get("dominant-baseline") ?? get("alignment-baseline");
  const display = get("display");
  const visibility = get("visibility");
  const opacity = Number(get("opacity") ?? "1");
  return {
    fill: fill === undefined ? parent.fill : normalizeColor(fill),
    stroke: stroke === undefined ? parent.stroke : normalizeColor(stroke),
    fontSize: font && font > 0 && font < 500 ? font : parent.fontSize,
    anchor: anchor === "middle" || anchor === "end" || anchor === "start" ? anchor : parent.anchor,
    baseline: baseline ?? parent.baseline,
    hidden: parent.hidden || display === "none" || visibility === "hidden" || opacity === 0,
  };
}

const scaleOf = (m: Matrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/** What the density gate counted while building a scene (the measurement and the gate use the same counters). */
export interface SceneGateCounts { useExpansions: number; primitives: number; segments: number; walked: number; touched: number }

export function buildScene(root: XmlElement, counts?: SceneGateCounts): Scene {
  const scene: Scene = { texts: [], rects: [], lines: [], points: [], signatures: "", width: null, height: null };
  const svg = root.local === "svg" ? root : elementChildren(root).find((c) => c.local === "svg") ?? null;
  if (!svg) throw new ExtractLimitError("svg-no-root");
  const viewBox = (svg.attrs.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  if (viewBox.length === 4 && viewBox.every(Number.isFinite)) { scene.width = viewBox[2]!; scene.height = viewBox[3]!; }
  else { scene.width = length(svg.attrs.width); scene.height = length(svg.attrs.height); }

  // Id index for <use>.
  const ids = new Map<string, XmlElement>();
  const sigParts: string[] = [];
  {
    const stack: XmlElement[] = [root];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur.attrs.id && !ids.has(cur.attrs.id)) ids.set(cur.attrs.id, cur);
      for (const c of cur.children) {
        if (c.type === "element") stack.push(c);
        else if (c.type === "comment" && sigParts.length < 50) sigParts.push(c.value.slice(0, 200));
      }
      if (cur.local === "metadata" || cur.local === "desc" || cur.local === "title") sigParts.push(textContent(cur).slice(0, 400));
    }
  }
  scene.signatures = sigParts.join("\n");
  const budget = newPathBudget();
  let order = 0;
  let expansions = 0;
  let segments = 0;
  // Every frame the walk pops, skipped, hidden and ill-transformed ones and every <use> re-walk included: the walk's
  // real cost (a <use> of a group of 34k hidden children costs 34k pops whatever the other counters say).
  let walked = 0;
  // Attribute and text bytes every walked frame reads, re-walks included: per-frame work is O(those bytes), so this
  // bounds the walk's total work, whatever a <use> repeats (council r6 H1).
  let touched = 0;
  const frameBytes = new WeakMap<XmlElement, number>();
  const bytesOf = (el: XmlElement) => {
    let n = frameBytes.get(el);
    if (n === undefined) {
      n = 0;
      for (const k in el.attrs) n += k.length + el.attrs[k]!.length;
      // Every child costs at least 1, so empty comments iterated on each re-walk are paid for (council r7 L2).
      for (const c of el.children) n += 1 + (c.type === "element" ? 0 : c.value.length);
      frameBytes.set(el, n);
    }
    return n;
  };
  const base: Style = { fill: "#000000", stroke: null, fontSize: 10, anchor: "start", baseline: "", hidden: false };

  type Frame = { el: XmlElement; m: Matrix; style: Style; groups: string; useDepth: number };
  const stack: Frame[] = [{ el: svg, m: IDENTITY, style: base, groups: "", useDepth: 0 }];
  while (stack.length) {
    const { el, m: parentM, style: parentStyle, groups: parentGroups, useDepth } = stack.pop()!;
    // Density gate, walk: counted before anything can skip the frame.
    if (++walked > CHART_EXTRACT_LIMITS.maxSvgWalkedElements) throw new ExtractLimitError(useDepth > 0 ? "svg-use-bomb" : "svg-too-dense");
    touched += bytesOf(el);
    if (touched > CHART_EXTRACT_LIMITS.maxSvgTouchedBytes) throw new ExtractLimitError(useDepth > 0 ? "svg-use-bomb" : "svg-too-dense");
    // Guest deadline backstop: checked every 256 frames (see `setGuestDeadline`).
    if ((walked & 255) === 0 && pastGuestDeadline()) throw new ExtractLimitError("svg-too-slow");
    if (SKIP.has(el.local)) continue;
    const t = parseTransform(el.attrs.transform);
    if (!t) continue;
    const m = multiply(parentM, t);
    const style = deriveStyle(el, parentStyle);
    if (style.hidden) continue;
    const tag = [el.attrs.id, el.attrs.class, el.attrs.role, el.attrs["aria-roledescription"]].filter(Boolean).join(" ").slice(0, 200);
    // The nearest ancestors' tags are what geometry matches on; keeping the last 512 characters bounds the string
    // (it grew by up to 200 characters per nesting level).
    const groups = tag ? `${parentGroups} ${tag}`.slice(-512) : parentGroups;
    if (order >= CHART_EXTRACT_LIMITS.maxXmlNodes) throw new ExtractLimitError("svg-work-limit");
    // Density gate: expanded primitives and path segments so far (checked before each element adds more).
    if (scene.rects.length + scene.points.length + scene.texts.length + scene.lines.length > CHART_EXTRACT_LIMITS.maxSvgPrimitives) throw new ExtractLimitError("svg-too-dense");
    if (segments > CHART_EXTRACT_LIMITS.maxSvgPathSegments) throw new ExtractLimitError("svg-too-dense");
    const common = { groups, order: order++ };
    switch (el.local) {
      case "svg": case "g": case "a": case "switch": {
        // matplotlib renders text as glyph paths and keeps the string in a comment: <g id="text_3"><!-- 0.5 --><g transform>…
        const comment = el.children.find((c) => c.type === "comment");
        if (comment && comment.type === "comment" && /^text_\d+$/.test(el.attrs.id ?? "")) {
          const inner = elementChildren(el, "g")[0];
          const im = inner ? parseTransform(inner.attrs.transform) : null;
          if (inner && im) {
            const M = multiply(m, im);
            const uses = elementChildren(inner, "use");
            const lastX = uses.length ? Number(uses[uses.length - 1]!.attrs.x ?? 0) || 0 : 0;
            const width = uses.length ? lastX + 60 : 0;
            const [cx, cy] = apply(M, width / 2, 35);
            const font = 100 * Math.hypot(M[0], M[1]);
            scene.texts.push({ kind: "text", ...common, text: cleanLabel(comment.value), x: cx, y: cy, anchor: "middle", fontSize: font || 10, rotated: Math.abs(M[1]) > 1e-6, fill: style.fill });
          }
          break;
        }
        for (let k = el.children.length - 1; k >= 0; k--) {
          const c = el.children[k]!;
          if (c.type === "element") stack.push({ el: c, m, style, groups, useDepth });
        }
        break;
      }
      case "use": {
        const href = el.attrs.href ?? el.attrs["xlink:href"] ?? "";
        const target = href.startsWith("#") ? ids.get(href.slice(1)) : undefined;
        if (!target || target === el || useDepth >= CHART_EXTRACT_LIMITS.maxUseDepth) break;
        // Density gate: a "billion laughs" of <use> stops at the first expansion past the cap, never materialised.
        if (expansions + 1 > CHART_EXTRACT_LIMITS.maxSvgUseExpansions) throw new ExtractLimitError("svg-use-bomb");
        if (++expansions > CHART_EXTRACT_LIMITS.maxUseExpansions) throw new ExtractLimitError("svg-use-limit");
        const x = length(el.attrs.x) ?? 0, y = length(el.attrs.y) ?? 0;
        const um = multiply(m, [1, 0, 0, 1, x, y]);
        // A <use> of a <symbol> or <path> marker: render the target, skipping its own SKIP check for symbol.
        const targetEl = target.local === "symbol" ? { ...target, local: "g" } : target;
        stack.push({ el: targetEl, m: um, style, groups, useDepth: useDepth + 1 });
        break;
      }
      case "text": {
        const tspans = elementChildren(el, "tspan");
        let x = firstNum(el.attrs.x), y = firstNum(el.attrs.y);
        let dy = length(el.attrs.dy, style.fontSize) ?? 0;
        let fontSize = style.fontSize;
        let anchor = style.anchor;
        if (tspans[0]) {
          const ts = deriveStyle(tspans[0], style);
          fontSize = ts.fontSize; anchor = ts.anchor;
          x ??= firstNum(tspans[0].attrs.x);
          y ??= firstNum(tspans[0].attrs.y);
          dy += length(tspans[0].attrs.dy, fontSize) ?? 0;
        }
        const raw = textContent(el);
        // tspan text is not in this frame's own bytes: charge it too.
        touched += raw.length;
        if (touched > CHART_EXTRACT_LIMITS.maxSvgTouchedBytes) throw new ExtractLimitError(useDepth > 0 ? "svg-use-bomb" : "svg-too-dense");
        const text = cleanLabel(raw);
        if (!text) break;
        const b = style.baseline;
        const shift = /middle|central/.test(b) ? 0 : /hanging|text-before|before-edge/.test(b) ? 0.7 * fontSize : -0.35 * fontSize;
        const [ax, ay] = apply(m, x ?? 0, (y ?? 0) + dy + shift);
        const s = scaleOf(m);
        scene.texts.push({ kind: "text", ...common, text, x: ax, y: ay, anchor, fontSize: fontSize * s, rotated: Math.abs(m[1]) > 1e-6, fill: style.fill });
        break;
      }
      case "rect": {
        const w = length(el.attrs.width) ?? 0, h = length(el.attrs.height) ?? 0;
        if (!(w > 0 && h > 0)) break;
        const x = length(el.attrs.x) ?? 0, y = length(el.attrs.y) ?? 0;
        pushPolygon(scene, common, m, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, 0, style);
        break;
      }
      case "line": {
        const p1 = apply(m, length(el.attrs.x1) ?? 0, length(el.attrs.y1) ?? 0);
        const p2 = apply(m, length(el.attrs.x2) ?? 0, length(el.attrs.y2) ?? 0);
        scene.lines.push({ kind: "line", ...common, points: [p1, p2], stroke: style.stroke, fill: null, closed: false, curves: 0 });
        break;
      }
      case "polyline": case "polygon": {
        const nums = (el.attrs.points ?? "").match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
        budget.commands += nums.length;
        if (budget.commands > CHART_EXTRACT_LIMITS.maxPathCommands * 7) throw new ExtractLimitError("svg-path-command-limit");
        const pts: Array<[number, number]> = [];
        for (let k = 0; k + 1 < nums.length && pts.length < CHART_EXTRACT_LIMITS.maxPathVertices; k += 2) pts.push([Number(nums[k]), Number(nums[k + 1])]);
        segments += pts.length;
        if (pts.length >= 2) pushPolygon(scene, common, m, pts, el.local === "polygon", 0, style);
        break;
      }
      case "path": {
        const subs = parsePathData(el.attrs.d ?? "", budget);
        for (const sp of subs) segments += sp.points.length;
        for (const sp of subs) if (sp.points.length >= 1) pushPolygon(scene, common, m, sp.points, sp.closed, sp.curves, style);
        break;
      }
      case "circle": case "ellipse": {
        const r = el.local === "circle" ? length(el.attrs.r) ?? 0 : Math.max(length(el.attrs.rx) ?? 0, length(el.attrs.ry) ?? 0);
        const [cx, cy] = apply(m, length(el.attrs.cx) ?? 0, length(el.attrs.cy) ?? 0);
        const size = 2 * r * scaleOf(m);
        if (size > 0 && size <= 30) scene.points.push({ kind: "point", ...common, x: cx, y: cy, size, fill: style.fill, stroke: style.stroke });
        break;
      }
      default:
        break;
    }
  }
  if (counts) Object.assign(counts, { useExpansions: expansions, primitives: scene.rects.length + scene.points.length + scene.texts.length + scene.lines.length, segments, walked, touched });
  if (scene.rects.length + scene.points.length + scene.texts.length + scene.lines.length > CHART_EXTRACT_LIMITS.maxSvgPrimitives) throw new ExtractLimitError("svg-too-dense");
  if (segments > CHART_EXTRACT_LIMITS.maxSvgPathSegments) throw new ExtractLimitError("svg-too-dense");
  return scene;
}

function pushPolygon(scene: Scene, common: PrimBase, m: Matrix, local: Array<[number, number]>, closed: boolean, curves: number, style: Style) {
  const pts = local.map(([x, y]) => apply(m, x, y));
  if (pts.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const first = pts[0]!, last = pts[pts.length - 1]!;
  const isClosed = closed || (pts.length > 3 && Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6);
  const unique = isClosed && pts.length > 1 && Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6 ? pts.slice(0, -1) : pts;
  const axisAligned = unique.length === 4 && curves === 0 && unique.every((p, k) => {
    const q = unique[(k + 1) % 4]!;
    return Math.abs(p[0] - q[0]) < 1e-3 || Math.abs(p[1] - q[1]) < 1e-3;
  });
  if (isClosed && axisAligned && style.fill && x1 - x0 > 0 && y1 - y0 > 0) {
    scene.rects.push({ kind: "rect", ...common, x0, y0, x1, y1, fill: style.fill, stroke: style.stroke });
    return;
  }
  const w = x1 - x0, h = y1 - y0;
  if (isClosed && (style.fill || style.stroke) && w <= 14 && h <= 14 && (curves > 0 || unique.length >= 3)) {
    scene.points.push({ kind: "point", ...common, x: (x0 + x1) / 2, y: (y0 + y1) / 2, size: Math.max(w, h), fill: style.fill ?? style.stroke, stroke: style.stroke });
    return;
  }
  if (pts.length >= 2) scene.lines.push({ kind: "line", ...common, points: pts, stroke: style.stroke, fill: isClosed ? style.fill : null, closed: isClosed, curves });
}
