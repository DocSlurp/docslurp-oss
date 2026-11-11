/**
 * Free lexical detector for questions that want data points, trends or diagrams: the cue for chat to suggest chart
 * export. Precision over recall: a single weak word ("table", "share") does not fire on its own; a strong cue (chart,
 * graph, plot, trend, forecast, diagram, flowchart, year-over-year) or two weaker cues together do.
 *
 * No model call. Ambiguous turns could later escalate to the cheapest decision model (TODO in core TODO.md).
 */

export interface VisualDataIntent {
  /** 0..1. `>= VISUAL_INTENT_THRESHOLD` means "suggest". */
  score: number;
  /** Matched signal names, in rule order (stable for tests and telemetry). */
  signals: string[];
}

export const VISUAL_INTENT_THRESHOLD = 0.5;

interface Rule {
  signal: string;
  weight: number;
  pattern: RegExp;
}

// Word boundaries via \b only cover ASCII; the multilingual cues use explicit (?:^|[^\p{L}]) guards.
const B = "(?:^|[^\\p{L}\\p{N}])";
const E = "(?=$|[^\\p{L}\\p{N}])";
const w = (body: string) => new RegExp(`${B}(?:${body})${E}`, "iu");

const RULES: Rule[] = [
  // Strong: the user names a visual or a time-series concept.
  { signal: "chart", weight: 0.6, pattern: w("charts?|charted|charting|bar ?charts?|pie ?charts?|histograms?|graphique|gráfic[oa]s?|grafik(?:en)?|diagramm(?:e)?|grafico|grafici") },
  { signal: "graph", weight: 0.6, pattern: w("graphs?|graphed|graphing|plots?|plotted|plotting|visuali[sz](?:e|ed|ing|ation|ations)") },
  { signal: "diagram", weight: 0.6, pattern: w("diagrams?|flow ?charts?|flow ?diagrams?|org ?charts?|organi[sz]ation(?:al)? charts?|sequence diagrams?|swim ?lanes?|mind ?maps?|diagrama|diagramme|organigram(?:me|a)?") },
  { signal: "trend", weight: 0.55, pattern: w("trends?|trending|trendline|over time|time ?series|tendencias?|tendances?|tendenz(?:en)?|andamento") },
  { signal: "forecast", weight: 0.55, pattern: w("forecasts?|forecasting|projections?|projected|predicted|predictions?|pron[oó]sticos?|prévisions?|prognosen?|previsioni") },
  { signal: "period-over-period", weight: 0.55, pattern: w("(?:year|quarter|month|week)[- ]over[- ](?:year|quarter|month|week)|yoy|qoq|cagr|run[- ]rate") },
  { signal: "flow", weight: 0.5, pattern: /\bhow (?:does|do|is|are)\b.{1,60}\b(?:flow|routed|escalated|approved|processed)\b|\b(?:process|approval|workflow|data|request) flow\b|\bwhat are the steps\b/iu },
  // Medium: data-shaped words.
  { signal: "growth", weight: 0.35, pattern: w("growth|grew|grow(?:s|ing)?|increase[sd]?|decrease[sd]?|decline[sd]?|rose|fell|crecimiento|croissance|wachstum|crescita") },
  { signal: "percentage", weight: 0.3, pattern: /\d\s?%|\b(?:percent(?:age)?s?|share of|breakdown|split by|distribution|proportion|porcentaje|pourcentage|prozent)\b/iu },
  { signal: "period", weight: 0.3, pattern: /\b(?:q[1-4](?:\s?(?:fy)?\s?'?\d{2,4})?|fy\s?'?\d{2,4}|h[12]\s?\d{4}|(?:19|20)\d{2}(?:\s?(?:-|–|to|vs\.?|versus)\s?(?:19|20)?\d{2})?|quarterly|monthly|annual(?:ly)?|year by year|per (?:year|quarter|month))\b/iu },
  { signal: "data-points", weight: 0.5, pattern: w("data ?points?|datapoints?|data series|time ?series data") },
  { signal: "data-shape", weight: 0.35, pattern: w("figures for|numbers for|values? (?:for|of|by)|metrics? (?:for|by)|kpis?|revenue by|sales by|by (?:region|quarter|month|year|segment|product)") },
  { signal: "table", weight: 0.3, pattern: w("tables?|tabular|spreadsheets?|csv|excel|xlsx|columns? and rows|pivot|tabla|tableau|tabelle") },
  { signal: "compare", weight: 0.2, pattern: w("compare|comparison|compared|versus|vs\\.?|side by side|rank(?:ed|ing)?") },
];

/** Score a chat question for "wants data points, trends, tables or a diagram". Deterministic and free. */
export function detectVisualDataIntent(question: string): VisualDataIntent {
  const text = typeof question === "string" ? question.slice(0, 4000) : "";
  if (!text.trim()) return { score: 0, signals: [] };
  const signals: string[] = [];
  let total = 0;
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      signals.push(rule.signal);
      total += rule.weight;
    }
  }
  // Saturating combination keeps the score in 0..1 and rewards corroborating cues.
  const score = Math.round(Math.min(1, total) * 100) / 100;
  return { score, signals };
}

export function hasVisualDataIntent(question: string, threshold = VISUAL_INTENT_THRESHOLD): boolean {
  return detectVisualDataIntent(question).score >= threshold;
}
