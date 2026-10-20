import type { PrivacyMode, TextGenerationConfig } from "@docslurp/shared";

import { generateOpenRouterText } from "../lib/ai.js";
import type { WorkerAiUsageInput } from "../lib/ai-usage.js";
import { buildTrustedDocumentTaskPrompt } from "../lib/trusted-llm-task.js";

export const SIPHON_WINDOW_PAGES = 5;
/** Credits are cents; the agent stops once its spend reaches this. */
export const MAX_SIPHON_CREDITS = 50;
const MAX_PAGE_CHARS = 1500;
const NO_NEW_STRUCTURE_LIMIT = 2;

export interface MapNode {
  id: string;
  title: string;
  level: number;
  parentId: string | null;
  printedStart: string | null;
  printedEnd: string | null;
  physicalStart: number | null;
  physicalEnd: number | null;
  source: "outline" | "toc-text" | "index" | "glossary" | "heading" | "agent";
  confidence: number;
}

export interface MapDraft {
  nodes: MapNode[];
  terms: Array<{ term: string; printedPages: string[] }>;
}

export type SiphonDecision =
  | { action: "continue-forward" }
  | { action: "jump"; startPage: number }
  | { action: "queue"; startPage: number; endPage: number }
  | { action: "stop"; reason: string };

export interface SiphonWindowObservation { startPage: number; endPage: number; pageTexts: string[] }

const SYSTEM = [
  "You build a navigation map of a long document by reading a few pages at a time.",
  "Pages given are physical page numbers. Extract only structure that is visible: chapter/section headings with their printed page numbers, and index or glossary terms with printed page numbers.",
  "Then choose the next action: continue-forward (read the next window), jump (read a window starting at startPage, e.g. where a table of contents or index likely sits), queue (remember startPage-endPage to read later), or stop (the map is complete enough, or nothing more is findable).",
  'Reply with JSON only: {"action":"continue-forward|jump|queue|stop","startPage":n,"endPage":n,"reason":"...","nodes":[{"title":"","level":1,"printedStart":"12","printedEnd":null,"physicalStart":null}],"terms":[{"term":"","printedPages":["12"]}]}.',
].join("\n");

function summarizeMap(map: MapDraft): string {
  const recent = map.nodes.slice(-15).map((n) => `${"  ".repeat(Math.max(0, n.level - 1))}${n.title} (p.${n.printedStart ?? n.physicalStart ?? "?"})`);
  return `Nodes so far: ${map.nodes.length}; terms so far: ${map.terms.length}.${recent.length ? `\nMost recent nodes:\n${recent.join("\n")}` : ""}`;
}

function clampPage(value: unknown, pageCount: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= pageCount ? n : null;
}

function str(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function decideNextWindow(args: {
  observation: SiphonWindowObservation;
  mapSoFar: MapDraft;
  pageCount: number;
  model: string;
  apiKey: string;
  privacyMode: PrivacyMode;
  textGeneration?: TextGenerationConfig;
  usage: (u: WorkerAiUsageInput) => void;
  signal?: AbortSignal;
  /** Distinguishes node ids across windows. */
  idPrefix?: string;
}): Promise<{ decision: SiphonDecision; extracted: MapDraft }> {
  const { observation, pageCount } = args;
  const pages = observation.pageTexts
    .map((text, i) => `--- physical page ${observation.startPage + i} ---\n${text.slice(0, MAX_PAGE_CHARS)}`)
    .join("\n\n");
  const task = buildTrustedDocumentTaskPrompt({
    instruction: SYSTEM,
    outputContract: "Output one JSON object and nothing else.",
    untrustedContent: pages,
    untrustedContentLabel: "page text",
    trustedContext: [
      { label: "Document", value: `${pageCount} physical pages. Current window: pages ${observation.startPage}-${observation.endPage}.` },
      { label: "Map so far", value: summarizeMap(args.mapSoFar) },
    ],
  });
  const empty: MapDraft = { nodes: [], terms: [] };
  const result = await generateOpenRouterText({
    operation: "document-map",
    textGeneration: args.textGeneration,
    apiKey: args.apiKey,
    privacyMode: args.privacyMode,
    model: args.model,
    maxOutputTokens: 600,
    system: task.system,
    prompt: task.prompt,
    signal: args.signal,
  });
  args.usage({
    provider: args.model.startsWith("llm://") ? "private" : "openrouter",
    model: args.model,
    metric: "document-map-siphon",
    amount: 1,
    unit: "window",
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    ...(result.usage.costCents !== undefined ? { costCents: result.usage.costCents } : {}),
    metadata: { ...(result.usage.metadata as Record<string, never> | undefined), startPage: observation.startPage, endPage: observation.endPage },
  });

  const json = parseJsonObject(result.text);
  if (!json) return { decision: { action: "stop", reason: "malformed-json" }, extracted: empty };

  const prefix = args.idPrefix ?? `agent-${observation.startPage}`;
  const nodes: MapNode[] = [];
  if (Array.isArray(json.nodes)) {
    for (const raw of json.nodes.slice(0, 60)) {
      if (!raw || typeof raw !== "object") continue;
      const n = raw as Record<string, unknown>;
      const title = str(n.title);
      if (!title) continue;
      const level = Number.isInteger(n.level) && (n.level as number) >= 1 ? Math.min(6, n.level as number) : 1;
      nodes.push({
        id: `${prefix}-n${nodes.length}`, title: title.slice(0, 200), level, parentId: null,
        printedStart: str(n.printedStart), printedEnd: str(n.printedEnd),
        physicalStart: clampPage(n.physicalStart, pageCount), physicalEnd: null,
        source: "agent", confidence: 0.6,
      });
    }
  }
  const terms: MapDraft["terms"] = [];
  if (Array.isArray(json.terms)) {
    for (const raw of json.terms.slice(0, 200)) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as Record<string, unknown>;
      const term = str(t.term);
      const printed = Array.isArray(t.printedPages) ? t.printedPages.map(str).filter((p): p is string => p !== null) : [];
      if (term && printed.length > 0) terms.push({ term: term.slice(0, 120), printedPages: printed.slice(0, 30) });
    }
  }
  const extracted: MapDraft = { nodes, terms };

  const action = json.action;
  if (action === "continue-forward") return { decision: { action }, extracted };
  if (action === "jump") {
    const startPage = clampPage(json.startPage, pageCount);
    return { decision: startPage ? { action, startPage } : { action: "stop", reason: "invalid-jump-target" }, extracted };
  }
  if (action === "queue") {
    const startPage = clampPage(json.startPage, pageCount);
    const endPage = clampPage(json.endPage ?? json.startPage, pageCount);
    return { decision: startPage && endPage && endPage >= startPage ? { action, startPage, endPage } : { action: "stop", reason: "invalid-queue-range" }, extracted };
  }
  return { decision: { action: "stop", reason: str(json.reason) ?? (action === "stop" ? "agent-stop" : "unknown-action") }, extracted };
}

export interface SiphonLoopResult {
  draft: MapDraft;
  pagesRead: number[];
  creditsSpent: number;
  decisions: Array<{ startPage: number; endPage: number; decision: SiphonDecision; newNodes: number; newTerms: number }>;
  stoppedBy: "agent" | "page-budget" | "credit-budget" | "no-new-structure" | "exhausted";
}

/**
 * Agent-guided reading: windows of {@link SIPHON_WINDOW_PAGES} pages, front first then back, bounded
 * by `maxSiphonPages` physical pages and `maxCredits` cents; stops after two windows that add no
 * structure. `readWindow` supplies page text (text layer or OCR) and any spend it incurred.
 */
export async function runSiphonLoop(args: {
  pageCount: number;
  maxSiphonPages: number;
  maxCredits?: number;
  seed: MapDraft;
  readWindow: (startPage: number, endPage: number) => Promise<{ pageTexts: string[]; costCents?: number }>;
  decide: (observation: SiphonWindowObservation, mapSoFar: MapDraft) => Promise<{ decision: SiphonDecision; extracted: MapDraft; costCents?: number }>;
  alreadyRead?: Set<number>;
  /**
   * Windows whose text is already in memory (sampled pages the deterministic parser could not explain).
   * They are shown to the agent first, cost no page budget, and are not re-read.
   */
  initialObservations?: SiphonWindowObservation[];
  /** Checked before every window (e.g. the run's cost cap). */
  shouldStop?: () => boolean;
  signal?: AbortSignal;
}): Promise<SiphonLoopResult> {
  const maxCredits = args.maxCredits ?? MAX_SIPHON_CREDITS;
  const draft: MapDraft = { nodes: [...args.seed.nodes], terms: [...args.seed.terms] };
  const read = new Set<number>();
  const budgeted = new Set<number>();
  const skip = args.alreadyRead ?? new Set<number>();
  const decisions: SiphonLoopResult["decisions"] = [];
  const front = { start: 1, end: Math.min(args.pageCount, SIPHON_WINDOW_PAGES) };
  const back = { start: Math.max(front.end + 1, args.pageCount - SIPHON_WINDOW_PAGES + 1), end: args.pageCount };
  const queue: Array<{ start: number; end: number }> = [front];
  if (back.start <= back.end) queue.push(back);
  const pending = [...(args.initialObservations ?? [])];
  let creditsSpent = 0;
  let quiet = 0;
  let stoppedBy: SiphonLoopResult["stoppedBy"] = "exhausted";

  /** Runs one observation through the agent; returns true when the loop must end. */
  const step = async (observation: SiphonWindowObservation, seeded = false): Promise<boolean> => {
    const { startPage, endPage } = observation;
    const { decision, extracted, costCents = 0 } = await args.decide(observation, draft);
    creditsSpent += costCents;
    draft.nodes.push(...extracted.nodes);
    draft.terms.push(...extracted.terms);
    decisions.push({ startPage, endPage, decision, newNodes: extracted.nodes.length, newTerms: extracted.terms.length });
    quiet = extracted.nodes.length + extracted.terms.length === 0 ? quiet + 1 : 0;
    if (!seeded && quiet >= NO_NEW_STRUCTURE_LIMIT) { stoppedBy = "no-new-structure"; return true; }
    if (decision.action === "stop") { stoppedBy = "agent"; return true; }
    if (decision.action === "continue-forward") {
      if (endPage < args.pageCount) queue.unshift({ start: endPage + 1, end: endPage + SIPHON_WINDOW_PAGES });
    } else if (decision.action === "jump") {
      queue.unshift({ start: decision.startPage, end: decision.startPage + SIPHON_WINDOW_PAGES - 1 });
    } else {
      for (let s = decision.startPage + Math.floor((decision.endPage - decision.startPage) / SIPHON_WINDOW_PAGES) * SIPHON_WINDOW_PAGES; s >= decision.startPage; s -= SIPHON_WINDOW_PAGES) {
        queue.unshift({ start: s, end: Math.min(decision.endPage, s + SIPHON_WINDOW_PAGES - 1) });
      }
    }
    return false;
  };

  const guard = (): boolean => {
    if (args.signal?.aborted) return true;
    if (args.shouldStop?.()) { stoppedBy = "credit-budget"; return true; }
    if (creditsSpent >= maxCredits) { stoppedBy = "credit-budget"; return true; }
    return false;
  };

  let done = false;
  while (!done && pending.length > 0) {
    if (guard()) { done = true; break; }
    const observation = pending.shift()!;
    for (let p = observation.startPage; p <= observation.endPage; p++) read.add(p);
    done = await step(observation, true);
  }

  // Seeded observations are free context; only windows the loop itself reads count toward the quiet stop.
  quiet = 0;

  while (!done && queue.length > 0) {
    if (budgeted.size >= args.maxSiphonPages) { stoppedBy = "page-budget"; break; }
    if (guard()) break;
    const window = queue.shift()!;
    const pages: number[] = [];
    for (let p = window.start; p <= Math.min(window.end, args.pageCount); p++) {
      if (!read.has(p) && !skip.has(p) && budgeted.size + pages.length < args.maxSiphonPages) pages.push(p);
    }
    if (pages.length === 0) continue;
    const startPage = pages[0]!;
    const endPage = pages[pages.length - 1]!;
    const { pageTexts, costCents: readCost = 0 } = await args.readWindow(startPage, endPage);
    pages.forEach((p) => { read.add(p); budgeted.add(p); });
    creditsSpent += readCost;
    done = await step({ startPage, endPage, pageTexts });
  }
  return { draft, pagesRead: [...read].sort((a, b) => a - b), creditsSpent, decisions, stoppedBy };
}
