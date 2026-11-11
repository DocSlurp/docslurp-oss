import {
  VISUAL_SPEC_LIMITS,
  type ChartAxis,
  type ChartExportFormat,
  type ChartSeries,
  type ChartSpec,
  type DiagramSpec,
  type VisualSpec,
} from "./chart-export.js";

/**
 * Deterministic renderers: `VisualSpec` -> each chart export format.
 *
 * Specs come from parsed customer files or model output, so every label is untrusted. The renderers:
 * - never let a label break out of its literal (Mermaid directives, `click` callbacks, `%%{init}`, HTML; Python code;
 *   CSV formulas);
 * - re-apply `VISUAL_SPEC_LIMITS` defensively, in case a caller passes a spec that skipped schema parsing;
 * - return `null` when a format has no faithful form for the spec (for example a heatmap in Mermaid) instead of
 *   emitting a misleading picture.
 */

type DiagramNode = DiagramSpec["nodes"][number];
type DiagramEdge = DiagramSpec["edges"][number];

// ---- Shared helpers ---------------------------------------------------------------------------------------------

/** Collapse whitespace and control characters to single spaces, trim, and cap the length. */
export function cleanVisualLabel(value: unknown, maxChars: number = VISUAL_SPEC_LIMITS.maxLabelChars): string {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  // eslint-disable-next-line no-control-regex
  const collapsed = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/gu, " ").trim();
  return Array.from(collapsed).slice(0, maxChars).join("");
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Magnitudes written in plain decimal; outside them a number is written with an exponent (`1e+300`). */
const PLAIN_NUMBER_MAX = 1e15;
const PLAIN_NUMBER_MIN = 1e-6;

/** Outside the plain-decimal range (Mermaid has no exponent syntax, so such a chart has no Mermaid form). */
function extremeNumber(value: number): boolean {
  const abs = Math.abs(value);
  return abs >= PLAIN_NUMBER_MAX || (abs > 0 && abs < PLAIN_NUMBER_MIN);
}

/**
 * Plain decimal notation for ordinary magnitudes; an exponent for huge or tiny ones, which Python, JSON and
 * spreadsheets all parse (never a 309-digit literal, never a tiny value rounded to 0).
 */
function plainNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  if (extremeNumber(value)) return String(value);
  const text = String(value);
  if (!/e/i.test(text)) return text;
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

function capChart(spec: ChartSpec): ChartSpec {
  return {
    ...spec,
    series: spec.series.slice(0, VISUAL_SPEC_LIMITS.maxSeries).map((series) => ({
      ...series,
      points: series.points.slice(0, VISUAL_SPEC_LIMITS.maxPointsPerSeries),
    })),
  };
}

function capDiagram(spec: DiagramSpec): DiagramSpec {
  return {
    ...spec,
    nodes: spec.nodes.slice(0, VISUAL_SPEC_LIMITS.maxNodes),
    edges: spec.edges.slice(0, VISUAL_SPEC_LIMITS.maxEdges),
    groups: (spec.groups ?? []).slice(0, 64),
  };
}

function xKey(x: string | number): string {
  return typeof x === "number" ? `n:${x}` : `s:${x}`;
}

interface AlignedChart {
  categories: Array<string | number>;
  /** values[seriesIndex][categoryIndex]; undefined = the series has no point at that category. */
  values: Array<Array<number | null | undefined>>;
}

/** Union of x values across series (first-seen order) with each series' y aligned to it. */
function alignSeries(series: ChartSeries[]): AlignedChart {
  const categories: Array<string | number> = [];
  const index = new Map<string, number>();
  for (const s of series) {
    for (const point of s.points) {
      const key = xKey(point.x);
      if (!index.has(key)) {
        index.set(key, categories.length);
        categories.push(point.x);
      }
    }
  }
  const values = series.map((s) => {
    const row: Array<number | null | undefined> = new Array(categories.length).fill(undefined);
    for (const point of s.points) {
      const i = index.get(xKey(point.x))!;
      if (row[i] === undefined) row[i] = finite(point.y);
    }
    return row;
  });
  return { categories, values };
}

function axisTitle(axis: ChartAxis | null | undefined): string | null {
  if (!axis) return null;
  const label = cleanVisualLabel(axis.label ?? "");
  const unit = cleanVisualLabel(axis.unit ?? "");
  if (label && unit) return `${label} (${unit})`;
  return label || unit || null;
}

// ---- Mermaid ----------------------------------------------------------------------------------------------------

const MERMAID_ENTITY_SAFE = /[\p{L}\p{N} .,:!?()'/+\-_*=$@~^‹›＆]/u;

/** `<`, `>` and `&` become look-alikes before encoding, so no decoding order can ever rebuild HTML or an entity. */
function neutralizeHtml(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›").replace(/&/g, "＆");
}

/**
 * Text for flowchart / sequence labels: anything outside a conservative allowlist becomes a Mermaid entity code
 * (`#35;`), so quotes, brackets, pipes, `#`, `;`, `%`, `<`, `>`, `&` and backticks cannot end the label, start a
 * directive or inject HTML. Newlines are collapsed first, so a label can never start its own statement line.
 */
export function mermaidEntityText(value: unknown): string {
  let out = "";
  for (const ch of neutralizeHtml(cleanVisualLabel(value))) {
    out += MERMAID_ENTITY_SAFE.test(ch) ? ch : `#${ch.codePointAt(0)};`;
  }
  return out;
}

const MERMAID_PLAIN_SAFE = /[\p{L}\p{N} .,:!?()'/+\-_*=$%‹›＆]/u;

/**
 * Text for diagram types where entity codes are not reliably decoded (xychart, pie, state, ER, mindmap): unsafe
 * characters become spaces, `"` becomes `'`, and `%` runs collapse so `%%` (comments / `%%{init}`) cannot appear.
 */
export function mermaidPlainText(value: unknown): string {
  let out = "";
  for (const ch of neutralizeHtml(cleanVisualLabel(value))) {
    if (ch === '"' || ch === "`") out += "'";
    else out += MERMAID_PLAIN_SAFE.test(ch) ? ch : " ";
  }
  return out.replace(/%+/g, "%").replace(/\s+/g, " ").trim();
}

const MERMAID_RESERVED_IDS = new Set(["end", "graph", "flowchart", "subgraph", "click", "style", "class", "classdef", "linkstyle", "default", "call", "href"]);

/** Mermaid identifier: `[A-Za-z0-9_]` only, prefixed so it never collides with a keyword or edge syntax. */
export function mermaidId(raw: string, prefix = "n"): string {
  const base = raw.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 48);
  const id = `${prefix}_${base || "x"}`;
  return MERMAID_RESERVED_IDS.has(id.toLowerCase()) ? `${id}_` : id;
}

/** Stable, unique Mermaid ids for arbitrary raw ids. */
class IdMap {
  private readonly map = new Map<string, string>();
  private readonly used = new Set<string>();
  constructor(private readonly prefix: string) {}
  get(raw: string): string {
    const existing = this.map.get(raw);
    if (existing) return existing;
    let id = mermaidId(raw, this.prefix);
    if (this.used.has(id)) {
      let n = 2;
      while (this.used.has(`${id}_${n}`)) n += 1;
      id = `${id}_${n}`;
    }
    this.used.add(id);
    this.map.set(raw, id);
    return id;
  }
  has(raw: string): boolean {
    return this.map.has(raw);
  }
}

const XYCHART_TYPES = new Set(["bar", "grouped-bar", "horizontal-bar", "histogram", "line", "area", "combo"]);

function mermaidChart(spec: ChartSpec): string | null {
  if (spec.chartType === "pie" || spec.chartType === "donut") return mermaidPie(spec);
  if (!XYCHART_TYPES.has(spec.chartType)) return null; // heatmap, box, scatter, stacked, radar, waterfall: no faithful form
  if (spec.y2Axis || spec.series.some((s) => s.axis === "y2")) return null; // xychart has one y axis
  const { categories, values } = alignSeries(spec.series);
  if (categories.length === 0) return null;
  // xychart cannot draw gaps; inventing zeros would misstate the data.
  if (values.some((row) => row.some((v) => v === null || v === undefined))) return null;

  const marks: Array<"bar" | "line"> = [];
  for (const s of spec.series) {
    const fallback = spec.chartType === "line" || spec.chartType === "area" ? "line" : "bar";
    const mark = spec.chartType === "combo" ? (s.mark ?? "line") : fallback;
    if (mark === "point") return null;
    marks.push(mark === "area" ? "line" : mark);
  }

  const lines: string[] = [spec.chartType === "horizontal-bar" ? "xychart-beta horizontal" : "xychart-beta"];
  const title = mermaidPlainText(spec.title ?? "");
  if (title) lines.push(`    title "${title}"`);
  const xTitle = mermaidPlainText(axisTitle(spec.xAxis) ?? "");
  const cats = categories.map((c) => `"${mermaidPlainText(typeof c === "number" ? plainNumber(c) : c) || " "}"`).join(", ");
  lines.push(`    x-axis${xTitle ? ` "${xTitle}"` : ""} [${cats}]`);
  const yTitle = mermaidPlainText(axisTitle(spec.yAxis) ?? "");
  const yMin = finite(spec.yAxis?.min);
  const yMax = finite(spec.yAxis?.max);
  const range = yMin !== null && yMax !== null && yMax > yMin ? ` ${plainNumber(yMin)} --> ${plainNumber(yMax)}` : "";
  if (yTitle || range) lines.push(`    y-axis${yTitle ? ` "${yTitle}"` : ` " "`}${range}`);
  values.forEach((row, i) => {
    lines.push(`    ${marks[i]} [${row.map((v) => plainNumber(v as number)).join(", ")}]`);
  });
  return lines.join("\n");
}

function mermaidPie(spec: ChartSpec): string | null {
  if (spec.series.length !== 1) return null;
  const points = spec.series[0]!.points;
  if (points.length === 0) return null;
  const slices: string[] = [];
  for (const point of points) {
    const y = finite(point.y);
    if (y === null || y < 0) return null;
    const label = mermaidPlainText(typeof point.x === "number" ? plainNumber(point.x) : point.x) || " ";
    slices.push(`    "${label}" : ${plainNumber(y)}`);
  }
  const lines = ["pie showData"];
  const title = mermaidPlainText(spec.title ?? "");
  if (title) lines.push(`    title ${title}`);
  return [...lines, ...slices].join("\n");
}

/**
 * The diagram's nodes plus implicit ones: an edge endpoint the spec does not declare becomes a node labelled with its
 * id, as Mermaid itself reads an undeclared id (models often declare only the nodes they label). Bounded by maxNodes;
 * an edge whose endpoint could not be added is dropped.
 */
function diagramNodes(spec: DiagramSpec): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const nodes = [...spec.nodes];
  const known = new Set(nodes.map((n) => n.id));
  for (const edge of spec.edges) {
    for (const id of [edge.from, edge.to]) {
      if (!known.has(id) && nodes.length < VISUAL_SPEC_LIMITS.maxNodes) {
        known.add(id);
        nodes.push({ id, label: id, shape: "box", group: null });
      }
    }
  }
  return { nodes, edges: spec.edges.filter((e) => known.has(e.from) && known.has(e.to)) };
}

function nodeLabel(node: DiagramNode): string {
  return cleanVisualLabel(node.label) || cleanVisualLabel(node.id);
}

function flowchartNode(id: string, node: DiagramNode): string {
  const text = `"${mermaidEntityText(nodeLabel(node))}"`;
  switch (node.shape) {
    case "rounded":
    case "actor":
      return `${id}(${text})`;
    case "diamond":
      return `${id}{${text}}`;
    case "circle":
      return `${id}((${text}))`;
    case "stadium":
      return `${id}([${text}])`;
    case "cylinder":
      return `${id}[(${text})]`;
    default:
      return `${id}[${text}]`;
  }
}

function flowchartArrow(edge: DiagramEdge): string {
  if (edge.style === "dashed") return edge.directed === false ? "-.-" : "-.->";
  if (edge.style === "thick") return edge.directed === false ? "===" : "==>";
  return edge.directed === false ? "---" : "-->";
}

function mermaidFlowchart(spec: DiagramSpec, direction: string): string | null {
  const { nodes, edges } = diagramNodes(spec);
  if (nodes.length === 0) return null;
  const ids = new IdMap("n");
  const groupIds = new IdMap("g");
  const lines = [`flowchart ${direction}`];
  const groups = new Map<string, DiagramNode[]>();
  const ungrouped: DiagramNode[] = [];
  const groupLabels = new Map((spec.groups ?? []).map((g) => [g.id, g.label] as const));
  for (const node of nodes) {
    if (node.group) {
      const list = groups.get(node.group) ?? [];
      list.push(node);
      groups.set(node.group, list);
    } else {
      ungrouped.push(node);
    }
  }
  for (const node of ungrouped) lines.push(`    ${flowchartNode(ids.get(node.id), node)}`);
  for (const [groupId, members] of groups) {
    const label = mermaidEntityText(groupLabels.get(groupId) ?? groupId) || " ";
    lines.push(`    subgraph ${groupIds.get(groupId)}["${label}"]`);
    for (const node of members) lines.push(`        ${flowchartNode(ids.get(node.id), node)}`);
    lines.push("    end");
  }
  for (const edge of edges) {
    const label = edge.label ? mermaidEntityText(edge.label) : "";
    const arrow = flowchartArrow(edge);
    lines.push(`    ${ids.get(edge.from)} ${arrow}${label ? `|"${label}"|` : ""} ${ids.get(edge.to)}`);
  }
  return lines.join("\n");
}

function mermaidSequence(spec: DiagramSpec): string | null {
  const { nodes, edges } = diagramNodes(spec);
  if (nodes.length === 0) return null;
  const ids = new IdMap("p");
  const lines = ["sequenceDiagram"];
  for (const node of nodes) {
    const keyword = node.shape === "actor" ? "actor" : "participant";
    lines.push(`    ${keyword} ${ids.get(node.id)} as ${mermaidEntityText(nodeLabel(node)) || " "}`);
  }
  for (const edge of edges) {
    const arrow = edge.style === "dashed" ? (edge.directed === false ? "-->" : "-->>") : edge.directed === false ? "->" : "->>";
    const label = edge.label ? mermaidEntityText(edge.label) : "";
    lines.push(`    ${ids.get(edge.from)}${arrow}${ids.get(edge.to)}: ${label || " "}`.trimEnd());
  }
  return lines.join("\n");
}

function mermaidState(spec: DiagramSpec): string | null {
  const { nodes, edges } = diagramNodes(spec);
  if (nodes.length === 0) return null;
  const ids = new IdMap("s");
  const lines = ["stateDiagram-v2"];
  if (spec.direction === "LR" || spec.direction === "RL") lines.push("    direction LR");
  for (const node of nodes) {
    lines.push(`    state "${mermaidPlainText(nodeLabel(node)) || " "}" as ${ids.get(node.id)}`);
  }
  for (const edge of edges) {
    const label = edge.label ? mermaidPlainText(edge.label).replace(/:/g, " ") : "";
    lines.push(`    ${ids.get(edge.from)} --> ${ids.get(edge.to)}${label ? ` : ${label}` : ""}`);
  }
  return lines.join("\n");
}

/** ER text: the ER grammar also rejects `%` inside quoted names. */
function erText(value: unknown): string {
  return mermaidPlainText(value).replace(/%/g, " percent").replace(/\s+/g, " ").trim();
}

function mermaidEr(spec: DiagramSpec): string | null {
  const { nodes, edges } = diagramNodes(spec);
  if (nodes.length === 0) return null;
  const ids = new IdMap("e");
  const lines = ["erDiagram"];
  for (const node of nodes) {
    // Entity alias syntax: id["Label"].
    lines.push(`    ${ids.get(node.id)}["${erText(nodeLabel(node)) || " "}"]`);
  }
  for (const edge of edges) {
    const label = erText(edge.label ?? "") || "relates to";
    const rel = edge.style === "dashed" ? "}o..o{" : "}o--o{";
    lines.push(`    ${ids.get(edge.from)} ${rel} ${ids.get(edge.to)} : "${label}"`);
  }
  return lines.join("\n");
}

function mermaidMindmap(spec: DiagramSpec): string | null {
  const { nodes, edges } = diagramNodes(spec);
  if (nodes.length === 0) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const edge of edges) {
    if (hasParent.has(edge.to) || edge.to === edge.from) continue; // a mindmap is a tree: keep the first parent
    hasParent.add(edge.to);
    const list = children.get(edge.from) ?? [];
    list.push(edge.to);
    children.set(edge.from, list);
  }
  const roots = nodes.filter((n) => !hasParent.has(n.id));
  const ids = new IdMap("m");
  const lines = ["mindmap"];
  const visited = new Set<string>();
  const emit = (id: string, depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id)!;
    lines.push(`${"  ".repeat(depth)}${ids.get(id)}[${mermaidPlainText(nodeLabel(node)).replace(/[()]/g, " ").replace(/\s+/g, " ").trim() || " "}]`);
    for (const child of children.get(id) ?? []) emit(child, depth + 1);
  };
  if (roots.length === 1) {
    emit(roots[0]!.id, 1);
  } else {
    // Several roots (or a cycle): a synthetic root keeps one tree.
    lines.push(`  m_root[${mermaidPlainText(spec.title ?? "") || " "}]`);
    for (const root of roots.length ? roots : [nodes[0]!]) emit(root.id, 2);
  }
  for (const node of nodes) if (!visited.has(node.id)) emit(node.id, 2);
  return lines.join("\n");
}

function mermaidDiagram(spec: DiagramSpec): string | null {
  switch (spec.diagramType) {
    case "sequence":
      return mermaidSequence(spec);
    case "state":
      return mermaidState(spec);
    case "er":
      return mermaidEr(spec);
    case "mindmap":
      return mermaidMindmap(spec);
    case "org-chart":
      return mermaidFlowchart(spec, "TB");
    default:
      return mermaidFlowchart(spec, spec.direction ?? "TB");
  }
}

export function renderMermaid(spec: VisualSpec): string | null {
  return spec.kind === "chart" ? mermaidChart(capChart(spec)) : mermaidDiagram(capDiagram(spec));
}

// ---- Vega-Lite --------------------------------------------------------------------------------------------------

const VEGA_LITE_SCHEMA = "https://vega.github.io/schema/vega-lite/v5.json";

function vegaXType(spec: ChartSpec): "nominal" | "ordinal" | "quantitative" | "temporal" {
  if (spec.xAxis?.scale === "time") return "temporal";
  const allNumeric = spec.series.every((s) => s.points.every((p) => typeof p.x === "number"));
  if (allNumeric && (spec.xAxis?.scale === "linear" || spec.xAxis?.scale === "log" || spec.chartType === "scatter" || spec.chartType === "bubble")) {
    return "quantitative";
  }
  return "ordinal";
}

function vegaScale(axis: ChartAxis | null | undefined): Record<string, unknown> | undefined {
  if (!axis) return undefined;
  const scale: Record<string, unknown> = {};
  if (axis.scale === "log") scale.type = "log";
  const min = finite(axis.min);
  const max = finite(axis.max);
  if (min !== null && max !== null && max > min) scale.domain = [min, max];
  return Object.keys(scale).length ? scale : undefined;
}

function vegaField(field: string, type: string, axis: ChartAxis | null | undefined, extra: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = { field, type, ...extra };
  const title = axisTitle(axis);
  if (title) out.title = title;
  const scale = vegaScale(axis);
  if (scale) out.scale = scale;
  return out;
}

export function renderVegaLite(input: VisualSpec): string | null {
  if (input.kind !== "chart") return null;
  const spec = capChart(input);
  const multi = spec.series.length > 1;
  const values: Array<Record<string, unknown>> = [];
  const seriesNames = spec.series.map((s, i) => cleanVisualLabel(s.name) || `Series ${i + 1}`);
  spec.series.forEach((s, i) => {
    for (const p of s.points) {
      const row: Record<string, unknown> = {
        series: seriesNames[i],
        x: typeof p.x === "string" ? cleanVisualLabel(p.x) : finite(p.x),
        y: finite(p.y),
      };
      if (p.z !== undefined && p.z !== null) row.z = finite(p.z);
      values.push(row);
    }
  });
  if (values.length === 0) return null;
  const color = multi ? { color: { field: "series", type: "nominal", title: null } } : {};
  const xType = vegaXType(spec);
  const x = (extra: Record<string, unknown> = {}) => vegaField("x", xType, spec.xAxis, { sort: null, ...extra });
  const y = (extra: Record<string, unknown> = {}) => vegaField("y", "quantitative", spec.yAxis, extra);

  let body: Record<string, unknown>;
  switch (spec.chartType) {
    case "bar":
    case "grouped-bar":
    case "histogram":
      body = { mark: "bar", encoding: { x: x(), y: y(), ...color, ...(multi ? { xOffset: { field: "series", sort: null } } : {}) } };
      break;
    case "stacked-bar":
      body = { mark: "bar", encoding: { x: x(), y: y({ stack: "zero" }), ...color } };
      break;
    case "horizontal-bar":
      body = {
        mark: "bar",
        encoding: {
          y: vegaField("x", xType, spec.xAxis, { sort: null }),
          x: vegaField("y", "quantitative", spec.yAxis),
          ...color,
          ...(multi ? { yOffset: { field: "series", sort: null } } : {}),
        },
      };
      break;
    case "line":
      body = { mark: { type: "line", point: true }, encoding: { x: x(), y: y(), ...color } };
      break;
    case "area":
      body = { mark: { type: "area", opacity: multi ? 0.5 : 0.8 }, encoding: { x: x(), y: y({ stack: null }), ...color } };
      break;
    case "stacked-area":
      body = { mark: "area", encoding: { x: x(), y: y({ stack: "zero" }), ...color } };
      break;
    case "scatter":
      body = { mark: "point", encoding: { x: x(), y: y(), ...color } };
      break;
    case "bubble":
      body = { mark: "circle", encoding: { x: x(), y: y(), size: { field: "z", type: "quantitative" }, ...color } };
      break;
    case "pie":
    case "donut":
      if (multi) return null;
      body = {
        mark: spec.chartType === "donut" ? { type: "arc", innerRadius: 50 } : "arc",
        encoding: {
          theta: { field: "y", type: "quantitative" },
          color: { field: "x", type: "nominal", sort: null, title: axisTitle(spec.xAxis) },
        },
      };
      break;
    case "heatmap":
      body = {
        mark: "rect",
        encoding: {
          x: vegaField("x", "ordinal", spec.xAxis, { sort: null }),
          y: { field: "series", type: "ordinal", sort: null, title: axisTitle(spec.yAxis) },
          color: { field: values.some((v) => typeof v.z === "number") ? "z" : "y", type: "quantitative" },
        },
      };
      break;
    case "combo": {
      const layers = spec.series.map((s, i) => {
        const mark = s.mark ?? "line";
        const axis = s.axis === "y2" ? spec.y2Axis : spec.yAxis;
        return {
          transform: [{ filter: { field: "series", equal: seriesNames[i] } }],
          mark: mark === "line" ? { type: "line", point: true } : mark,
          encoding: { x: x(), y: vegaField("y", "quantitative", axis), color: { field: "series", type: "nominal", title: null } },
        };
      });
      const hasY2 = spec.series.some((s) => s.axis === "y2");
      body = { layer: layers, ...(hasY2 ? { resolve: { scale: { y: "independent" } } } : {}) };
      break;
    }
    default:
      // box, radar, waterfall, other: no faithful single-spec mapping from the contract's point model.
      return null;
  }

  const title = cleanVisualLabel(spec.title ?? "");
  const out: Record<string, unknown> = { $schema: VEGA_LITE_SCHEMA };
  if (title) out.title = title;
  const source = cleanVisualLabel(spec.source ?? "");
  if (source) out.description = `Source: ${source}`;
  out.data = { values };
  Object.assign(out, body);
  return JSON.stringify(out, null, 2);
}

// ---- matplotlib -------------------------------------------------------------------------------------------------

/** Python `str` literal: ASCII-only, every non-printable or non-ASCII code point escaped. Cannot terminate early. */
export function pythonString(value: string): string {
  let out = "'";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === "'") out += "\\'";
    else if (code >= 0x20 && code < 0x7f) out += ch;
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return `${out}'`;
}

/** Label for matplotlib text: `$` would start mathtext, so it is escaped. */
function mplText(value: unknown): string {
  return pythonString(cleanVisualLabel(value).replace(/\$/g, "\\$"));
}

function pyNumber(value: number | null | undefined): string {
  const n = finite(value);
  return n === null ? "nan" : plainNumber(n);
}

function pyX(value: string | number): string {
  return typeof value === "number" ? pyNumber(value) : mplText(value);
}

function pyList(items: string[], indent = "    "): string {
  if (items.join(", ").length <= 100) return `[${items.join(", ")}]`;
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    if (line && line.length + item.length > 96) {
      lines.push(line);
      line = "";
    }
    line += `${item}, `;
  }
  if (line) lines.push(line);
  return `[\n${lines.map((l) => `${indent}    ${l.trimEnd()}`).join("\n")}\n${indent}]`;
}

const MPL_TYPES = new Set([
  "bar", "grouped-bar", "histogram", "stacked-bar", "horizontal-bar", "line", "area", "stacked-area", "scatter", "bubble",
  "pie", "donut", "heatmap", "waterfall", "combo",
]);

export function renderMatplotlib(input: VisualSpec): string | null {
  if (input.kind !== "chart") return null;
  const spec = capChart(input);
  if (!MPL_TYPES.has(spec.chartType)) return null;
  if ((spec.chartType === "pie" || spec.chartType === "donut" || spec.chartType === "waterfall") && spec.series.length !== 1) return null;
  const { categories, values } = alignSeries(spec.series);
  if (categories.length === 0) return null;
  const names = spec.series.map((s, i) => cleanVisualLabel(s.name) || `Series ${i + 1}`);
  const multi = spec.series.length > 1;
  const lines: string[] = ["import matplotlib.pyplot as plt", "", "nan = float('nan')", ""];
  const usesAligned = !["scatter", "bubble"].includes(spec.chartType);
  if (usesAligned) {
    lines.push(`categories = ${pyList(categories.map(pyX), "")}`);
    lines.push("series = [");
    values.forEach((row, i) => {
      lines.push(`    (${mplText(names[i])}, ${pyList(row.map((v) => pyNumber(v)))}),`);
    });
    lines.push("]");
  } else {
    lines.push("series = [");
    spec.series.forEach((s, i) => {
      const xs = pyList(s.points.map((p) => pyX(p.x)));
      const ys = pyList(s.points.map((p) => pyNumber(p.y)));
      const zs = spec.chartType === "bubble" ? `, ${pyList(s.points.map((p) => pyNumber(p.z ?? null)))}` : "";
      lines.push(`    (${mplText(names[i])}, ${xs}, ${ys}${zs}),`);
    });
    lines.push("]");
  }
  lines.push("", "fig, ax = plt.subplots(figsize=(9, 5))");
  const legend = multi ? ["ax.legend()"] : [];
  const xticks = ["ax.set_xticks(range(len(categories)))", "ax.set_xticklabels([str(c) for c in categories], rotation=45, ha='right')"];

  switch (spec.chartType) {
    case "bar":
    case "grouped-bar":
    case "histogram":
      lines.push(
        "width = 0.8 / len(series)",
        "for i, (name, values) in enumerate(series):",
        "    offset = (i - (len(series) - 1) / 2) * width",
        "    ax.bar([j + offset for j in range(len(categories))], values, width, label=name)",
        ...xticks,
        ...legend,
      );
      break;
    case "stacked-bar":
      lines.push(
        "bottom = [0.0] * len(categories)",
        "for name, values in series:",
        "    ax.bar(range(len(categories)), values, 0.8, bottom=bottom, label=name)",
        "    bottom = [b + (v if v == v else 0.0) for b, v in zip(bottom, values)]",
        ...xticks,
        ...legend,
      );
      break;
    case "horizontal-bar":
      lines.push(
        "height = 0.8 / len(series)",
        "for i, (name, values) in enumerate(series):",
        "    offset = (i - (len(series) - 1) / 2) * height",
        "    ax.barh([j + offset for j in range(len(categories))], values, height, label=name)",
        "ax.set_yticks(range(len(categories)))",
        "ax.set_yticklabels([str(c) for c in categories])",
        ...legend,
      );
      break;
    case "line":
      lines.push(
        "for name, values in series:",
        "    ax.plot(range(len(categories)), values, marker='o', label=name)",
        ...xticks,
        ...legend,
      );
      break;
    case "area":
      lines.push(
        "for name, values in series:",
        "    ax.fill_between(range(len(categories)), values, alpha=0.4, label=name)",
        "    ax.plot(range(len(categories)), values)",
        ...xticks,
        ...legend,
      );
      break;
    case "stacked-area":
      lines.push(
        "ax.stackplot(range(len(categories)), *[[v if v == v else 0.0 for v in values] for _, values in series], labels=[name for name, _ in series])",
        ...xticks,
        ...legend,
      );
      break;
    case "scatter":
      lines.push("for name, xs, ys in series:", "    ax.scatter(xs, ys, label=name)", ...legend);
      break;
    case "bubble":
      lines.push("for name, xs, ys, sizes in series:", "    ax.scatter(xs, ys, s=sizes, alpha=0.6, label=name)", ...legend);
      break;
    case "pie":
    case "donut":
      lines.push(
        "name, values = series[0]",
        spec.chartType === "donut"
          ? "ax.pie(values, labels=[str(c) for c in categories], autopct='%1.1f%%', wedgeprops={'width': 0.4})"
          : "ax.pie(values, labels=[str(c) for c in categories], autopct='%1.1f%%')",
        "ax.axis('equal')",
      );
      break;
    case "heatmap":
      lines.push(
        "matrix = [values for _, values in series]",
        "image = ax.imshow(matrix, aspect='auto')",
        "fig.colorbar(image, ax=ax)",
        ...xticks,
        "ax.set_yticks(range(len(series)))",
        "ax.set_yticklabels([name for name, _ in series])",
      );
      break;
    case "waterfall":
      lines.push(
        "name, values = series[0]",
        "running = 0.0",
        "for j, v in enumerate(values):",
        "    v = v if v == v else 0.0",
        "    ax.bar(j, v, 0.8, bottom=running, color='tab:green' if v >= 0 else 'tab:red')",
        "    running += v",
        ...xticks,
      );
      break;
    case "combo": {
      const hasY2 = spec.series.some((s) => s.axis === "y2");
      lines.push("marks = [" + spec.series.map((s) => pythonString(s.mark ?? "line")).join(", ") + "]");
      lines.push("axes = [" + spec.series.map((s) => pythonString(s.axis === "y2" ? "y2" : "y")).join(", ") + "]");
      if (hasY2) lines.push("ax2 = ax.twinx()");
      lines.push(
        "for (name, values), mark, axis in zip(series, marks, axes):",
        hasY2 ? "    target = ax2 if axis == 'y2' else ax" : "    target = ax",
        "    xs = range(len(categories))",
        "    if mark == 'bar':",
        "        target.bar(xs, values, 0.6, label=name, alpha=0.8)",
        "    elif mark == 'area':",
        "        target.fill_between(xs, values, alpha=0.4, label=name)",
        "    elif mark == 'point':",
        "        target.scatter(xs, values, label=name)",
        "    else:",
        "        target.plot(xs, values, marker='o', label=name)",
        ...xticks,
        "fig.legend()",
      );
      const y2Title = axisTitle(spec.y2Axis);
      if (hasY2 && y2Title) lines.push(`ax2.set_ylabel(${mplText(y2Title)})`);
      break;
    }
  }

  if (spec.chartType !== "pie" && spec.chartType !== "donut") {
    const xTitle = axisTitle(spec.xAxis);
    const yTitle = axisTitle(spec.yAxis);
    const valueAxis = spec.chartType === "horizontal-bar" ? "x" : "y";
    const categoryAxis = spec.chartType === "horizontal-bar" ? "y" : "x";
    if (xTitle) lines.push(`ax.set_${categoryAxis}label(${mplText(xTitle)})`);
    if (yTitle) lines.push(`ax.set_${valueAxis}label(${mplText(yTitle)})`);
    if (spec.yAxis?.scale === "log") lines.push(`ax.set_${valueAxis}scale('log')`);
    const min = finite(spec.yAxis?.min);
    const max = finite(spec.yAxis?.max);
    if (min !== null && max !== null && max > min && spec.chartType !== "heatmap") {
      lines.push(`ax.set_${valueAxis}lim(${plainNumber(min)}, ${plainNumber(max)})`);
    }
  }
  const title = cleanVisualLabel(spec.title ?? "");
  if (title) lines.push(`ax.set_title(${mplText(title)})`);
  lines.push("fig.tight_layout()", "plt.show()");
  return lines.join("\n");
}

// ---- CSV --------------------------------------------------------------------------------------------------------

/** RFC 4180 cell; text cells that a spreadsheet would treat as a formula get a leading `'`. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? plainNumber(value) : "";
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRows(rows: Array<Array<string | number | null | undefined>>): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function renderCsv(input: VisualSpec): string | null {
  if (input.kind === "diagram") {
    const spec = capDiagram(input);
    const { nodes, edges } = diagramNodes(spec);
    if (edges.length === 0) return null;
    const labels = new Map(nodes.map((n) => [n.id, nodeLabel(n)]));
    return csvRows([
      ["from", "to", "label"],
      ...edges.map((e) => [labels.get(e.from) ?? e.from, labels.get(e.to) ?? e.to, cleanVisualLabel(e.label ?? "")]),
    ]);
  }
  const spec = capChart(input);
  const names = spec.series.map((s, i) => cleanVisualLabel(s.name) || `Series ${i + 1}`);
  const xHeader = axisTitle(spec.xAxis) ?? "x";
  const hasZ = spec.series.some((s) => s.points.some((p) => p.z !== undefined && p.z !== null));
  const hasDuplicateX = spec.series.some((s) => new Set(s.points.map((p) => xKey(p.x))).size !== s.points.length);
  if (hasZ || hasDuplicateX) {
    // Long format keeps every point (bubble size, heatmap intensity, scatter with repeated x).
    const rows: Array<Array<string | number | null>> = [["series", xHeader, axisTitle(spec.yAxis) ?? "y", ...(hasZ ? ["z"] : [])]];
    spec.series.forEach((s, i) => {
      for (const p of s.points) {
        rows.push([names[i]!, typeof p.x === "string" ? cleanVisualLabel(p.x) : p.x, finite(p.y), ...(hasZ ? [finite(p.z)] : [])]);
      }
    });
    return rows.length > 1 ? csvRows(rows) : null;
  }
  const { categories, values } = alignSeries(spec.series);
  if (categories.length === 0) return null;
  const header = spec.series.length === 1 ? [xHeader, axisTitle(spec.yAxis) ?? names[0]!] : [xHeader, ...names];
  const rows: Array<Array<string | number | null | undefined>> = [header];
  categories.forEach((c, j) => {
    rows.push([typeof c === "string" ? cleanVisualLabel(c) : c, ...values.map((row) => row[j])]);
  });
  return csvRows(rows);
}

// ---- Description ------------------------------------------------------------------------------------------------

function fmt(value: number): string {
  const rounded = Number(value.toPrecision(4));
  return Math.abs(rounded) >= 1000 ? rounded.toLocaleString("en-US", { maximumFractionDigits: 2 }) : plainNumber(rounded);
}

function quoted(text: string): string {
  return `“${text}”`;
}

function chartTypeName(spec: ChartSpec): string {
  const names: Record<string, string> = {
    bar: "Bar chart", "grouped-bar": "Grouped bar chart", "stacked-bar": "Stacked bar chart", "horizontal-bar": "Horizontal bar chart",
    line: "Line chart", area: "Area chart", "stacked-area": "Stacked area chart", scatter: "Scatter plot", bubble: "Bubble chart",
    pie: "Pie chart", donut: "Donut chart", histogram: "Histogram", box: "Box plot", heatmap: "Heatmap", radar: "Radar chart",
    waterfall: "Waterfall chart", combo: "Combination chart", other: "Chart",
  };
  return names[spec.chartType] ?? "Chart";
}

function xText(x: string | number): string {
  return typeof x === "number" ? fmt(x) : cleanVisualLabel(x, 60);
}

function seriesSentence(name: string, series: ChartSeries, unit: string, ordered: boolean): string | null {
  const points = series.points.filter((p) => finite(p.y) !== null) as Array<{ x: string | number; y: number }>;
  if (points.length === 0) return `${quoted(name)} has no values`;
  let min = points[0]!;
  let max = points[0]!;
  for (const p of points) {
    if (p.y < min.y) min = p;
    if (p.y > max.y) max = p;
  }
  const u = unit ? ` ${unit}` : "";
  const parts = [`min ${fmt(min.y)}${u} (${xText(min.x)})`, `max ${fmt(max.y)}${u} (${xText(max.x)})`];
  if (ordered && points.length > 1) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    parts.push(`latest ${fmt(last.y)}${u} (${xText(last.x)})`);
    const range = max.y - min.y;
    const delta = last.y - first.y;
    const flat = range === 0 || Math.abs(delta) <= range * 0.1 || Math.abs(delta) < 0.03 * Math.max(Math.abs(first.y), Math.abs(last.y));
    if (!flat) {
      const pct = first.y !== 0 ? ` (${delta > 0 ? "+" : ""}${fmt((delta / Math.abs(first.y)) * 100)}%)` : "";
      parts.push(`${delta > 0 ? "rising" : "falling"} from ${fmt(first.y)} to ${fmt(last.y)}${pct}`);
    } else {
      parts.push("roughly flat from first to last");
    }
  }
  return `${quoted(name)}: ${parts.join(", ")}`;
}

function describeChart(spec: ChartSpec): string {
  const sentences: string[] = [];
  const title = cleanVisualLabel(spec.title ?? "");
  sentences.push(`${chartTypeName(spec)}${title ? ` titled ${quoted(title)}` : ""}.`);
  const xTitle = axisTitle(spec.xAxis);
  const yTitle = axisTitle(spec.yAxis);
  const axes: string[] = [];
  if (xTitle) axes.push(`x axis ${quoted(xTitle)}`);
  if (yTitle) axes.push(`y axis ${quoted(yTitle)}${spec.yAxis?.scale === "log" ? " (log scale)" : ""}`);
  const y2Title = axisTitle(spec.y2Axis);
  if (y2Title) axes.push(`secondary y axis ${quoted(y2Title)}`);
  if (axes.length) sentences.push(`${axes.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()));
  const pointCount = spec.series.reduce((sum, s) => sum + s.points.length, 0);
  sentences.push(`${spec.series.length} series, ${pointCount} data point${pointCount === 1 ? "" : "s"}.`);

  if (spec.chartType === "pie" || spec.chartType === "donut") {
    const all = (spec.series[0]?.points ?? []).filter((p) => finite(p.y) !== null) as Array<{ x: string | number; y: number }>;
    const points = all.filter((p) => p.y >= 0);
    const total = points.reduce((sum, p) => sum + p.y, 0);
    // A negative value has no share of the whole: name the values instead of inventing percentages.
    if (all.length > points.length) {
      sentences.push(`Includes negative values, so shares are not meaningful: ${all.slice(0, 5).map((p) => `${quoted(xText(p.x))} ${fmt(p.y)}`).join(", ")}.`);
    } else if (total > 0) {
      const sorted = [...points].sort((a, b) => b.y - a.y).slice(0, 3);
      sentences.push(`Largest shares: ${sorted.map((p) => `${quoted(xText(p.x))} ${fmt((p.y / total) * 100)}%`).join(", ")}.`);
    }
  } else {
    const ordered = !["scatter", "bubble", "heatmap", "box", "radar", "pie", "donut"].includes(spec.chartType);
    const unit = cleanVisualLabel(spec.yAxis?.unit ?? "", 20);
    const shown = spec.series.slice(0, 8);
    const parts = shown
      .map((s, i) => seriesSentence(cleanVisualLabel(s.name) || `Series ${i + 1}`, s, s.axis === "y2" ? cleanVisualLabel(spec.y2Axis?.unit ?? "", 20) : unit, ordered))
      .filter((p): p is string => Boolean(p));
    if (parts.length) sentences.push(`${parts.join("; ")}${spec.series.length > shown.length ? `; and ${spec.series.length - shown.length} more series` : ""}.`);
  }
  const source = cleanVisualLabel(spec.source ?? "");
  if (source) sentences.push(`Source: ${source}.`);
  return sentences.join(" ");
}

function diagramTypeName(spec: DiagramSpec): string {
  const names: Record<string, string> = {
    flowchart: "Flowchart", sequence: "Sequence diagram", "org-chart": "Org chart", state: "State diagram", er: "Entity-relationship diagram",
    mindmap: "Mind map", timeline: "Timeline", other: "Diagram",
  };
  return names[spec.diagramType] ?? "Diagram";
}

function listLabels(labels: string[], max = 5): string {
  const shown = labels.slice(0, max).map(quoted);
  return labels.length > max ? `${shown.join(", ")} and ${labels.length - max} more` : shown.join(", ");
}

function describeDiagram(spec: DiagramSpec): string {
  const { nodes, edges } = diagramNodes(spec);
  const sentences: string[] = [];
  const title = cleanVisualLabel(spec.title ?? "");
  sentences.push(`${diagramTypeName(spec)}${title ? ` titled ${quoted(title)}` : ""} with ${nodes.length} node${nodes.length === 1 ? "" : "s"} and ${edges.length} connection${edges.length === 1 ? "" : "s"}.`);
  const incoming = new Set(edges.map((e) => e.to));
  const outgoing = new Set(edges.map((e) => e.from));
  const label = (n: DiagramNode) => cleanVisualLabel(nodeLabel(n), 60);
  if (edges.length > 0) {
    const starts = nodes.filter((n) => !incoming.has(n.id) && outgoing.has(n.id)).map(label);
    const ends = nodes.filter((n) => incoming.has(n.id) && !outgoing.has(n.id)).map(label);
    if (spec.diagramType === "org-chart" || spec.diagramType === "mindmap") {
      if (starts.length) sentences.push(`Top: ${listLabels(starts)}.`);
    } else {
      if (starts.length) sentences.push(`Starts at ${listLabels(starts)}.`);
      if (ends.length) sentences.push(`Ends at ${listLabels(ends)}.`);
    }
    const decisions = nodes.filter((n) => n.shape === "diamond").map(label);
    if (decisions.length) sentences.push(`Decisions: ${listLabels(decisions)}.`);
  } else if (nodes.length) {
    sentences.push(`Nodes: ${listLabels(nodes.map(label))}.`);
  }
  const groups = (spec.groups ?? []).map((g) => cleanVisualLabel(g.label, 60) || cleanVisualLabel(g.id, 60)).filter(Boolean);
  if (groups.length) sentences.push(`Groups: ${listLabels(groups)}.`);
  return sentences.join(" ");
}

export function renderDescription(input: VisualSpec): string {
  const spec = input.kind === "chart" ? capChart(input) : capDiagram(input);
  const summary = cleanVisualLabel(spec.summary ?? "", VISUAL_SPEC_LIMITS.maxSummaryChars);
  const body = spec.kind === "chart" ? describeChart(spec) : describeDiagram(spec);
  return summary ? `${summary}\n\n${body}` : body;
}

// ---- Dispatch ---------------------------------------------------------------------------------------------------

/** Render one format, or `null` when the format has no faithful form for this spec. */
/**
 * Why `format` cannot faithfully show this spec's data, or null when it can. Checked by `renderVisual` (which then
 * returns null) and by callers that record a reason for the skipped format.
 * - `negative-share`: a pie or donut with a negative value has no wedge for it.
 * - `log-scale-nonpositive`: a log axis cannot place zero or negative values.
 * - `duplicate-x`: a category repeats within a series; aligned formats would silently keep one value.
 * - `number-out-of-range`: Mermaid has no exponent notation for huge or tiny values.
 */
export function visualRenderIssue(input: VisualSpec, format: ChartExportFormat): string | null {
  if (input.kind !== "chart" || format === "csv" || format === "description") return null;
  const spec = capChart(input);
  const ys = spec.series.flatMap((s) => s.points.map((p) => finite(p.y)).filter((y): y is number => y !== null));
  if ((spec.chartType === "pie" || spec.chartType === "donut") && ys.some((y) => y < 0)) return "negative-share";
  if (format !== "mermaid") {
    if (spec.yAxis?.scale === "log" && ys.some((y) => y <= 0)) return "log-scale-nonpositive";
    const xs = spec.series.flatMap((s) => s.points.map((p) => finite(p.x)).filter((x): x is number => x !== null));
    if (spec.xAxis?.scale === "log" && xs.some((x) => x <= 0)) return "log-scale-nonpositive";
  }
  const pointwise = ["scatter", "bubble"].includes(spec.chartType);
  if (!pointwise && spec.series.some((s) => new Set(s.points.map((p) => xKey(p.x))).size !== s.points.length)) return "duplicate-x";
  if (format === "mermaid") {
    const numbers = [...ys, ...spec.series.flatMap((s) => s.points.map((p) => finite(p.x)).filter((x): x is number => x !== null))];
    if (numbers.some(extremeNumber)) return "number-out-of-range";
  }
  return null;
}

export function renderVisual(spec: VisualSpec, format: ChartExportFormat): string | null {
  if (visualRenderIssue(spec, format) !== null) return null;
  switch (format) {
    case "description":
      return renderDescription(spec);
    case "mermaid":
      return renderMermaid(spec);
    case "vega-lite":
      return renderVegaLite(spec);
    case "matplotlib":
      return renderMatplotlib(spec);
    case "csv":
      return renderCsv(spec);
    default:
      return null;
  }
}

export interface RenderedVisualOutputs {
  outputs: Partial<Record<ChartExportFormat, string>>;
  skipped: Array<{ format: ChartExportFormat; reason: string }>;
}

/** Render every requested format; unsupported ones land in `skipped` with a machine reason (matches `ExportedVisual`). */
export function renderVisualOutputs(spec: VisualSpec, formats: readonly ChartExportFormat[]): RenderedVisualOutputs {
  const outputs: Partial<Record<ChartExportFormat, string>> = {};
  const skipped: RenderedVisualOutputs["skipped"] = [];
  for (const format of new Set(formats)) {
    const issue = visualRenderIssue(spec, format);
    const text = issue ? null : renderVisual(spec, format);
    if (text === null) skipped.push({ format, reason: issue ?? `unsupported:${spec.kind === "chart" ? spec.chartType : spec.diagramType}` });
    else outputs[format] = text;
  }
  return { outputs, skipped };
}

const FENCE_INFO: Record<ChartExportFormat, string | null> = {
  description: null,
  mermaid: "mermaid",
  "vega-lite": "vega-lite",
  matplotlib: "python",
  csv: "csv",
};

/**
 * Markdown block for one output. Code formats get a backtick fence longer than any backtick run in the text, so the
 * text can never close the fence; `description` is prose and is returned unfenced.
 */
export function renderFencedBlock(format: ChartExportFormat, text: string): string {
  const info = FENCE_INFO[format];
  const body = text.replace(/\r?\n$/, "");
  if (info === null) return body;
  const longestRun = Math.max(0, ...Array.from(body.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${info}\n${body}\n${fence}`;
}
