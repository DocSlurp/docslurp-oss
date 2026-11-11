/**
 * Every chart-export prompt lives here (S4 tunes this file). Prompts are generic: they describe chart and diagram
 * classes, never a benchmark document, field or value.
 */
import { CHART_TYPES, DIAGRAM_TYPES, VISUAL_SPEC_LIMITS, type ChartExportFormat } from "@docslurp/shared";

import type { VisualKind } from "./types.js";

const CHART_SHAPE = `{"kind":"chart","chartType":one of ${JSON.stringify(CHART_TYPES)},"title":string|null,` +
  `"xAxis":{"label":string|null,"unit":string|null,"scale":"linear"|"log"|"band"|"time","min":number|null,"max":number|null},` +
  `"yAxis":{same as xAxis},"y2Axis":{same as xAxis}|null,` +
  `"series":[{"name":string,"mark":"bar"|"line"|"area"|"point"|null,"axis":"y"|"y2","points":[{"x":string|number,"y":number|null}]}],` +
  `"source":string|null,"summary":string}`;

const DIAGRAM_SHAPE = `{"kind":"diagram","diagramType":one of ${JSON.stringify(DIAGRAM_TYPES)},"title":string|null,` +
  `"direction":"TB"|"LR"|"BT"|"RL",` +
  `"nodes":[{"id":short identifier,"label":string,"shape":"box"|"rounded"|"diamond"|"circle"|"stadium"|"cylinder"|"actor"|"other","group":group id|null}],` +
  `"edges":[{"from":node id,"to":node id,"label":string|null,"style":"solid"|"dashed"|"thick","directed":boolean}],` +
  `"groups":[{"id":string,"label":string}],"summary":string}`;

const LIMITS = `At most ${VISUAL_SPEC_LIMITS.maxSeries} series, ${VISUAL_SPEC_LIMITS.maxPointsPerSeries} points per series, ` +
  `${VISUAL_SPEC_LIMITS.maxNodes} nodes and ${VISUAL_SPEC_LIMITS.maxEdges} edges; labels under ${VISUAL_SPEC_LIMITS.maxLabelChars} characters.`;

// Rules tuned on a synthetic dev split (eval report in the private repo); generic chart/diagram-class guidance only.
const FIDELITY = [
  "Rules:",
  "- Use the exact text printed in the image for titles, axis labels, legend names, categories and node labels.",
  "- Values: use printed data labels when present; otherwise read them against the axis ticks and gridlines as precisely as you can.",
  "- One point per category per series, in the order shown. Stacked charts: each series' own segment value, not the running total.",
  "- Pie/donut: one series, one point per slice (x = slice label, y = slice value or percent as printed).",
  "- Histogram: x = lower edge of each bin (number), y = count. Bins are contiguous and equal-width; take each bin's lower edge from where its bar starts against the x-axis ticks (ticks need not fall on bin edges) and count the bars.",
  "- Combo charts: give each series its mark and put series read on the right-hand axis on \"y2\".",
  "- Sequence diagrams: participants are nodes; every message is an edge, in order, labelled with its text.",
  "- State diagrams: represent the start and end markers as nodes labelled \"[*] start\" and \"[*] end\".",
  "- summary: one or two sentences on what the visual shows.",
  "- Never leave a value null when a mark is visible. Pie/donut without printed values: estimate each slice's share of the full circle from its angle (shares sum to 100).",
  "- Scatter plots: one point per marker with numeric x and y; count the markers carefully.",
  "- Log axes: read values on the log scale (each major tick is 10x the previous) and set the axis scale to \"log\".",
  "- Flowcharts: every arrow is one edge; decision branches carry their branch label (for example yes/no) on the edge.",
  "- Do not invent series, categories, nodes or edges that are not visible; do not omit any that are.",
].join("\n");

/** Prompt options. `chartsOnly`: the project exports no diagrams, so an unknown-kind image that is a diagram is `none`. */
export interface PromptOptions {
  chartsOnly?: boolean;
}

function kindLine(kind: VisualKind | null, options: PromptOptions = {}): string {
  if (kind === "chart") return "The image is a chart or graph.";
  if (kind === "diagram") return "The image is a diagram (flowchart, sequence, org chart, state or similar).";
  if (options.chartsOnly) return "The image may contain a chart or graph. If it holds several, describe the most prominent chart.";
  return "The image may contain a chart or a diagram. If it holds several, describe the most prominent one.";
}

function shapeFor(kind: VisualKind | null, options: PromptOptions = {}): string {
  if (kind === "chart") return `Return one JSON object of this shape:\n${CHART_SHAPE}`;
  if (kind === "diagram") return `Return one JSON object of this shape:\n${DIAGRAM_SHAPE}`;
  if (options.chartsOnly) {
    return `Return one JSON object of this shape:\n${CHART_SHAPE}\n` +
      `If the image holds no chart (a diagram, a photo or text only), return {"kind":"none"}.`;
  }
  return `Return one JSON object, either a chart:\n${CHART_SHAPE}\nor a diagram:\n${DIAGRAM_SHAPE}\n` +
    `If the image holds neither, return {"kind":"none"}.`;
}

/** Derived mode: the model returns a `VisualSpec`. */
export function specPrompt(kind: VisualKind | null, options: PromptOptions = {}): string {
  return [kindLine(kind, options), shapeFor(kind, options), FIDELITY, LIMITS, "Return only the JSON object, with no prose and no code fence."].join("\n\n");
}

/**
 * Derived mode with a geometry digest (`svg-assisted`): the numbers come from the digest, the model only names and
 * types what it sees. The digest is our own bounded text built from parsed geometry, never raw SVG.
 */
export function assistedSpecPrompt(kind: VisualKind | null, digest: string, options: PromptOptions = {}): string {
  return [
    kindLine(kind, options),
    "Measured geometry of this visual (axis scales, tick labels and the value of every mark, read from the vector source):",
    digest,
    "Use these measured values as the data: do not re-estimate any number the digest gives. Use the image to name the " +
      "chart type, series, axes, units and title, and to match each measured mark to its series and category.",
    shapeFor(kind, options),
    FIDELITY,
    LIMITS,
    "Return only the JSON object, with no prose and no code fence.",
  ].join("\n\n");
}

/** One repair retry after an invalid spec: the problem is ours (schema text), never provider error text. */
export function repairPrompt(kind: VisualKind | null, previous: string, problem: string, options: PromptOptions = {}): string {
  return [
    "Your previous answer was not a valid JSON object of the required shape.",
    `Problem: ${problem}`,
    `Previous answer (truncated):\n${previous.slice(0, 4000)}`,
    specPrompt(kind, options),
  ].join("\n\n");
}

const DIRECT: Record<ChartExportFormat, (kind: VisualKind | null) => string> = {
  description: (kind) =>
    `${kindLine(kind)} Describe it in two to four plain sentences: what it shows, its axes or parts, and the main trend, ` +
    "extremes or flow, with the key numbers as printed. Plain text only, no Markdown.",
  mermaid: (kind) =>
    `${kindLine(kind)} Return only a Mermaid code block that faithfully recreates it` +
    (kind === "diagram" ? " (flowchart, sequenceDiagram, stateDiagram-v2 or similar) with every node, label and edge shown." :
      " (xychart-beta for bar and line charts, pie for pie or donut charts) with its exact data.") +
    " Do not use init directives, click handlers, HTML tags or styling.",
  "vega-lite": (kind) =>
    `${kindLine(kind)} Return only a Vega-Lite v5 JSON specification that faithfully recreates it with its exact data ` +
    "inline in data.values. Do not reference external data (no url fields) and do not add links.",
  matplotlib: (kind) =>
    `${kindLine(kind)} Return only a Python code block using matplotlib that faithfully recreates it with its exact data. ` +
    "Import only matplotlib and numpy; do not read files, access the network or call plt.show().",
  csv: (kind) =>
    `${kindLine(kind)} Return only its data as CSV in a code block: a header row, then one row per category or x value, ` +
    "one column per series, numbers without thousands separators.",
};

/** Direct mode: one prompt per format. */
export function directPrompt(format: ChartExportFormat, kind: VisualKind | null): string {
  return DIRECT[format](kind);
}
