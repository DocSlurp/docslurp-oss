import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { Sql } from "postgres";
import {
  calculateAiUsageCostCents,
  DEFAULT_SERVER_MATERIALIZATION_POLICY,
  narrowMaterializationPolicy,
  qualityAllowsPageReading,
  resolvePipelineTextModel,
  type MaterializationPolicy,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import { calibrateSegments, intToRoman, parseLabel, readPrintedPageNumber, resolvePrintedPage, segmentsFromPageLabels, type LabelSegment } from "../deferred/page-labels.js";
import { ensurePageRows } from "../deferred/page-ledger.js";
import { firstHeading, flattenOutline, parseIndexText, parseTocText, readPdfStructure, sectionKind, type PdfStructure } from "../deferred/pdf-structure.js";
import { SIPHON_WINDOW_PAGES, decideNextWindow, runSiphonLoop, type MapDraft, type MapNode, type SiphonLoopResult, type SiphonWindowObservation } from "../deferred/siphon-agent.js";
import { resolvePageImageEmbedder, type PageImageEmbedder } from "../deferred/page-image-embedders.js";
import { runLocalArtifactCommand } from "../extractors/local-artifact-adapters.js";
import { allowHostedCall, openRouterTextCall } from "../lib/privacy-guard.js";
import { createPiiTextScanner } from "../lib/pii-redaction.js";
import { textModelApiKey } from "../lib/text-model-route.js";
import type { Document } from "../models.js";
import { runDocumentStage, runDocuments, isCostCapExceeded } from "../pipeline/checkpoints.js";
import { resolvePolicy } from "./pii-detect.js";
import { PdfRasterCache, PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { embedPageImages, withinCostCap, type PageEmbedDeps } from "./page-embed.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";

export const MAP_BLOCK_PAGES = 15;
export const COVERAGE_THRESHOLD = 0.85;
export const LABEL_SLACK = 3;
const BORN_DIGITAL_MIN_CHARS = 40;
const BORN_DIGITAL_MIN_SHARE = 0.7;
const COARSE_ALL_PAGES_ABOVE = 400;
const TEXT_MAX_BYTES = 64 * 1024 * 1024;
const TEXT_TIMEOUT_MS = 120_000;
const OCR_DPI = 150;

/** Share of physical pages covered by at least one node range. */
export function mapCoverage(nodes: MapNode[], pageCount: number): number {
  if (pageCount < 1) return 0;
  const covered = new Uint8Array(pageCount + 1);
  for (const node of nodes) {
    if (node.physicalStart === null) continue;
    const start = Math.max(1, node.physicalStart);
    const end = Math.min(pageCount, node.physicalEnd ?? node.physicalStart);
    for (let p = start; p <= end; p++) covered[p] = 1;
  }
  let count = 0;
  for (let p = 1; p <= pageCount; p++) count += covered[p]!;
  return count / pageCount;
}

/** Side-effecting edges, injectable so tests need no poppler, vision model or LLM. */
export interface DocumentMapOps {
  readStructure(bytes: Uint8Array): Promise<PdfStructure>;
  /** Text layer for pages first..last, one string per page (a single pdftotext call). */
  extractText(sourcePath: string, first: number, last: number, signal?: AbortSignal): Promise<string[]>;
  /** OCR pages first..last of a scanned document. */
  ocrPages(args: { document: Document; first: number; last: number; state: WorkflowState; signal?: AbortSignal }): Promise<{ pageTexts: string[]; costCents: number }>;
  decide: typeof decideNextWindow;
}

export interface DocumentMapDeps {
  /** Postgres handle; defaults to the checkpoint store's connection. */
  sql?: (state: WorkflowState) => Sql;
  ops?: Partial<DocumentMapOps>;
  pageMappedFeeUsd?: number;
  /** Coarse visual layer embedder for uncovered scanned pages; undefined resolves from env/pipeline, null disables. */
  pageEmbedder?: PageImageEmbedder | null;
  /** Test seams for the raster cache and artifact store used by the coarse visual layer. */
  pageEmbedIo?: Partial<Pick<PageEmbedDeps, "rasters" | "storage">>;
}

export interface BuiltMap {
  nodes: MapNode[];
  terms: Array<{ term: string; physicalPages: number[] }>;
  segments: LabelSegment[];
  labelSource: "pdf-page-labels" | "ocr-calibrated" | "none";
  coverage: number;
  pagesRead: number[];
  bornDigital: boolean;
  siphon: SiphonLoopResult | null;
  title: string | null;
}

export class DocumentMapStage implements Stage {
  readonly name = "document-map";
  private readonly rasters: PdfRasterCache;

  constructor(
    private readonly sources: PdfSourceCache,
    private readonly storage: ArtifactStore,
    private readonly runner: CommandRunner,
    private readonly config: Config,
    private readonly deps: DocumentMapDeps = {},
  ) {
    this.rasters = new PdfRasterCache(runner as never, storage as never, sources);
  }

  private ops(): DocumentMapOps {
    return {
      readStructure: readPdfStructure,
      extractText: async (sourcePath, first, last, signal) => {
        const out = await runLocalArtifactCommand("pdftotext", ["-f", String(first), "-l", String(last), "-layout", "-enc", "UTF-8", sourcePath, "-"], TEXT_MAX_BYTES, TEXT_TIMEOUT_MS, signal);
        const pages = out.toString("utf8").split("\f");
        return Array.from({ length: last - first + 1 }, (_, i) => pages[i] ?? "");
      },
      ocrPages: (args) => this.ocrPages(args),
      decide: decideNextWindow,
      ...this.deps.ops,
    };
  }

  private sqlFor(state: WorkflowState): Sql {
    if (this.deps.sql) return this.deps.sql(state);
    const sql = (state.store as unknown as { sql?: Sql } | undefined)?.sql;
    if (!sql) throw new Error("document-map requires a database-backed checkpoint store");
    return sql;
  }

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    await runDocuments(state.documents, state.docConcurrency, async (document) => {
      await runDocumentStage(state, document, this.name, `${document.id}:document-map`, "document map ready", async () => {
        if (document.mimeType !== "application/pdf") return { stats: { skipped: "not-a-pdf" } };
        const built = await this.mapDocument(state, document, signal);
        return {
          stats: {
            coverage: Number(built.coverage.toFixed(3)),
            nodes: built.nodes.length,
            terms: built.terms.length,
            pagesRead: built.pagesRead.length,
            siphonWindows: built.siphon?.decisions.length ?? 0,
            labelSource: built.labelSource,
            bornDigital: built.bornDigital,
          },
        };
      }, signal);
    });
  }

  private policy(state: WorkflowState): MaterializationPolicy {
    return narrowMaterializationPolicy(DEFAULT_SERVER_MATERIALIZATION_POLICY, state.run.pipeline.materialization);
  }

  async mapDocument(state: WorkflowState, document: Document, signal?: AbortSignal): Promise<BuiltMap> {
    const ops = this.ops();
    const sql = this.sqlFor(state);
    const source = await this.sources.get(document);
    // A corrupt or encrypted PDF degrades to text-only mapping instead of failing the stage.
    const structure = await ops.readStructure(await readFile(source.path)).catch((error): PdfStructure => {
      console.warn(`[document-map] structure read failed document=${document.id}: ${error instanceof Error ? error.message : String(error)}`);
      return { pageCount: Math.max(1, document.pageCount), outline: [], pageLabels: null };
    });
    const pageCount = structure.pageCount;
    const policy = this.policy(state);

    // (2) structural text: exactly two pdftotext calls (front and back blocks).
    const text = new Map<number, string>();
    const frontEnd = Math.min(MAP_BLOCK_PAGES, pageCount);
    const backStart = Math.max(frontEnd + 1, pageCount - MAP_BLOCK_PAGES + 1);
    const readBlock = async (first: number, last: number) => {
      const pages = await ops.extractText(source.path, first, last, signal).catch(() => Array.from({ length: last - first + 1 }, () => ""));
      pages.forEach((t, i) => text.set(first + i, t));
    };
    await readBlock(1, frontEnd);
    if (backStart <= pageCount) await readBlock(backStart, pageCount);
    const sampled = [...text.values()];
    const bornDigital = sampled.length > 0
      && sampled.filter((t) => t.replace(/\s/g, "").length >= BORN_DIGITAL_MIN_CHARS).length / sampled.length >= BORN_DIGITAL_MIN_SHARE;

    // One cheap middle sample (a single pdftotext call) so calibration sees the body, not just the ends.
    if (!structure.pageLabels && bornDigital) {
      const mid = Math.floor(pageCount / 2);
      const first = Math.max(frontEnd + 1, mid - 2);
      const last = Math.min(backStart - 1, first + 4);
      if (first <= last) await readBlock(first, last);
    }

    // (3) labels.
    let segments: LabelSegment[] = [];
    let labelSource: BuiltMap["labelSource"] = "none";
    const observations: Array<{ physicalPage: number; printed: string }> = [];
    const calibrate = () => {
      observations.length = 0;
      for (const [physicalPage, t] of text) {
        const printed = readPrintedPageNumber(t);
        if (printed) observations.push({ physicalPage, printed });
      }
      return calibrateSegments(observations, pageCount);
    };
    // Offsets (physical - printed value) found by locating TOC titles in sampled text.
    const anchorOffsets: Record<"roman" | "arabic", number[]> = { roman: [], arabic: [] };
    if (structure.pageLabels) {
      const fromLabels = segmentsFromPageLabels(structure.pageLabels);
      if (fromLabels.some((s) => s.style !== "other")) { segments = fromLabels; labelSource = "pdf-page-labels"; }
    }
    if (labelSource === "none") {
      segments = calibrate();
      if (segments.length > 0) labelSource = "ocr-calibrated";
    }

    // Keyed by source + id so agent-assigned ids can never collide with t<i>/o<i>.
    const widenKeys = new Set<string>();
    const widenKey = (n: Pick<MapNode, "source" | "id">) => `${n.source}\u0000${n.id}`;
    const estimateOffset = (style: "roman" | "arabic", value: number): number => {
      const ofStyle = segments.filter((seg) => seg.style === style);
      if (ofStyle.length > 0) {
        // Nearest segment by printed value.
        return ofStyle.reduce((best, seg) => Math.abs(seg.printedStart - value) < Math.abs(best.printedStart - value) ? seg : best).offset;
      }
      const anchors = anchorOffsets[style];
      if (anchors.length > 0) {
        const counts = new Map<number, number>();
        for (const o of anchors) counts.set(o, (counts.get(o) ?? 0) + 1);
        return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]![0];
      }
      const single = observations.map((o) => ({ ...parseLabel(o.printed), physical: o.physicalPage })).find((o) => o.style === style);
      return single ? single.physical - single.value : 0;
    };
    // Exact when a segment resolves it; otherwise the best offset estimate (caller widens by the label slack).
    const toPhysical = (printed: string | null): { page: number; exact: boolean } | null => {
      if (!printed) return null;
      const exact = resolvePrintedPage(printed, segments);
      if (exact !== null) return { page: exact, exact: true };
      const parsed = parseLabel(printed);
      if (parsed.style === "other" || parsed.value < 1) return null;
      const page = Math.min(pageCount, Math.max(1, parsed.value + estimateOffset(parsed.style, parsed.value)));
      return { page, exact: false };
    };

    // (1)+(2) nodes from evidence in order: outline, then TOC text.
    const draft: MapNode[] = [];
    const outline = flattenOutline(structure.outline).filter((n) => n.physicalPage !== null);
    const stack: Array<{ level: number; id: string }> = [];
    outline.forEach((n, i) => {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= n.level) stack.pop();
      const id = `o${i}`;
      const label = structure.pageLabels?.[n.physicalPage! - 1] ?? null;
      draft.push({ id, title: n.title, level: n.level, parentId: stack[stack.length - 1]?.id ?? null, printedStart: label, printedEnd: null, physicalStart: n.physicalPage, physicalEnd: null, source: "outline", confidence: 1 });
      stack.push({ level: n.level, id });
    });

    if (draft.length === 0 && bornDigital) {
      const toc = parseTocText([...text.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t));
      const tocPages = new Set([...text.entries()].filter(([, t]) => parseTocText([t]).length > 0).map(([p]) => p));
      for (const entry of toc.slice(0, 5)) {
        const style = parseLabel(entry.printed);
        if (style.style === "other") continue;
        const wanted = entry.title.replace(/^\d+(?:\.\d+)*[.)]?\s+/, "").toLowerCase();
        if (wanted.length < 4) continue;
        for (const [page, t] of [...text.entries()].sort((a, b) => a[0] - b[0])) {
          if (tocPages.has(page)) continue;
          if (t.split(/\r?\n/).some((line) => line.trim().toLowerCase().replace(/^\d+(?:\.\d+)*[.)]?\s+/, "") === wanted)) {
            anchorOffsets[style.style].push(page - style.value);
            break;
          }
        }
      }
      const tocStack: Array<{ level: number; id: string }> = [];
      toc.forEach((entry, i) => {
        const resolved = toPhysical(entry.printed);
        if (!resolved) return;
        while (tocStack.length > 0 && tocStack[tocStack.length - 1]!.level >= entry.level) tocStack.pop();
        const id = `t${i}`;
        draft.push({ id, title: entry.title, level: entry.level, parentId: tocStack[tocStack.length - 1]?.id ?? null, printedStart: entry.printed, printedEnd: null, physicalStart: resolved.page, physicalEnd: null, source: "toc-text", confidence: resolved.exact ? 0.9 : 0.6 });
        if (!resolved.exact) widenKeys.add(widenKey(draft[draft.length - 1]!));
        tocStack.push({ level: entry.level, id });
      });
    }

    // Index / glossary sections and terms.
    const terms = new Map<string, Set<number>>();
    const addTerms = (entries: Array<{ term: string; printedPages: string[] }>) => {
      for (const entry of entries) {
        const set = terms.get(entry.term) ?? new Set<number>();
        for (const printed of entry.printedPages) {
          const resolved = toPhysical(printed);
          if (resolved) set.add(resolved.page);
        }
        if (set.size > 0) terms.set(entry.term, set);
      }
    };
    if (bornDigital) {
      const backPages = [...text.entries()].filter(([p]) => p >= backStart).sort((a, b) => a[0] - b[0]);
      addTerms(parseIndexText(backPages.map(([, t]) => t)));
      const kinds = backPages.map(([p, t]) => [p, sectionKind(t)] as const).filter(([, k]) => k !== null);
      for (const [p, kind] of kinds) {
        draft.push({ id: `s${p}`, title: kind === "index" ? "Index" : "Glossary", level: 1, parentId: null, printedStart: null, printedEnd: null, physicalStart: p, physicalEnd: null, source: kind!, confidence: 0.8 });
      }
    }

    let nodes = finalizeNodes(draft, pageCount);
    let coverage = mapCoverage(nodes, pageCount);
    // Only pages that yielded text count as read; empty (scanned) pages are still open to the siphon.
    const pagesRead = new Set([...text.entries()].filter(([, t]) => t.replace(/\s/g, "").length >= BORN_DIGITAL_MIN_CHARS).map(([p]) => p));

    // (4) agent siphon.
    let siphon: SiphonLoopResult | null = null;
    const noOutline = outline.length === 0;
    if (coverage < COVERAGE_THRESHOLD && (!bornDigital || noOutline) && policy.allowAgentDiscovery) {
      siphon = await this.siphon({ state, document, ops, source: source.path, pageCount, bornDigital, draft: { nodes: nodes, terms: [] }, initialObservations: unexplainedSamples(text, pageCount, backStart, bornDigital), text, signal });
      if (siphon) {
        for (const p of siphon.pagesRead) pagesRead.add(p);
        if (labelSource === "none") {
          const calibrated = calibrate();
          if (calibrated.length > 0) { segments = calibrated; labelSource = "ocr-calibrated"; }
        }
        const added: MapNode[] = [];
        for (const n of siphon.draft.nodes.slice(nodes.length)) {
          const located = n.physicalStart !== null ? { page: n.physicalStart, exact: true } : toPhysical(n.printedStart);
          if (!located) continue;
          if (!located.exact) widenKeys.add(widenKey(n));
          added.push({ ...n, physicalStart: located.page });
        }
        addTerms(siphon.draft.terms);
        nodes = finalizeNodes([...nodes, ...added], pageCount);
        coverage = mapCoverage(nodes, pageCount);
      }
    }

    // (5) widen estimated ranges by the label slack (nodes placed without an exact label).
    nodes = nodes.map((n) => widenKeys.has(widenKey(n)) && n.physicalStart !== null
      ? { ...n, physicalStart: Math.max(1, n.physicalStart - LABEL_SLACK), physicalEnd: Math.min(pageCount, (n.physicalEnd ?? n.physicalStart) + LABEL_SLACK) }
      : n);
    coverage = mapCoverage(nodes, pageCount);

    const title = outline[0]?.title ?? nodes.find((n) => n.source === "toc-text")?.title ?? firstHeading(text.get(1) ?? "") ?? null;
    const built: BuiltMap = {
      nodes: nodes.map(contractNode), terms: [...terms.entries()].map(([term, set]) => ({ term, physicalPages: [...set].sort((a, b) => a - b) })),
      segments, labelSource, coverage, pagesRead: [...pagesRead].sort((a, b) => a - b), bornDigital, siphon, title,
    };

    // (6) coarse layer: plain page text for pages the map does not cover.
    const coarsePages = bornDigital && (pageCount > COARSE_ALL_PAGES_ABOVE || coverage < COVERAGE_THRESHOLD)
      ? uncoveredPages(nodes, pageCount, pageCount > COARSE_ALL_PAGES_ABOVE)
      : [];

    await this.persist({ state, document, sql, built, structure, coarsePages, ops, sourcePath: source.path, text, signal });

    // (7) coarse visual layer: scanned pages the map does not cover get page-image vectors (cost-capped).
    // Page-image embedding costs per page, so it runs only on explicit opt-in (`visualPages.coarseFallback`).
    // Under Fast, embedPageImages refuses (stoppedBy "quality-fast"): nothing is rendered, embedded or charged.
    if (!bornDigital && coverage < COVERAGE_THRESHOLD && state.run.pipeline.visualPages?.coarseFallback === true) {
      const embedder = this.deps.pageEmbedder !== undefined
        ? this.deps.pageEmbedder
        : resolvePageImageEmbedder({ route: state.run.pipeline.visualPages?.route ?? "auto", privacyMode: state.run.pipeline.privacyMode });
      if (embedder) {
        // Optional layer: a raster or embedding failure must not fail the stage or lose the persisted map.
        try {
          const outcome = await embedPageImages(
            { sql, rasters: this.rasters, storage: this.storage as never, ...this.deps.pageEmbedIo, embedder, usage: state.usageLedger },
            { document, pages: uncoveredPages(nodes, pageCount, false), run: state.run, signal, canAfford: (cents) => withinCostCap(state, cents) },
          );
          if (outcome.stoppedBy) console.warn(`[document-map] coarse page embedding stopped by ${outcome.stoppedBy} document=${document.id} embedded=${outcome.embeddedPages.length}`);
        } catch (error) {
          if (signal?.aborted) throw error;
          console.warn(`[document-map] coarse page embedding failed document=${document.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return built;
  }

  private async siphon(args: {
    state: WorkflowState; document: Document; ops: DocumentMapOps; source: string; pageCount: number; bornDigital: boolean;
    draft: MapDraft & { nodes: MapNode[] }; initialObservations: SiphonWindowObservation[]; text: Map<number, string>; signal?: AbortSignal;
  }): Promise<SiphonLoopResult | null> {
    const { state, document, ops, pageCount } = args;
    const tg = state.run.pipeline.textGeneration;
    const model = resolvePipelineTextModel(state.run.pipeline, tg?.models["document-map"] ? "document-map" : "document-summary", this.config.textGenerationModel);
    // The siphon inherits document-summary's effort and output limits unless "document-map" sets its own.
    const textGeneration = tg && {
      ...tg,
      reasoningEfforts: { ...(tg.reasoningEfforts?.["document-summary"] ? { "document-map": tg.reasoningEfforts["document-summary"] } : {}), ...tg.reasoningEfforts },
      maxOutputTokens: { ...(tg.maxOutputTokens?.["document-summary"] ? { "document-map": tg.maxOutputTokens["document-summary"] } : {}), ...tg.maxOutputTokens },
    };
    const apiKey = textModelApiKey(this.config.openRouterApiKey, model);
    if (!apiKey || isCostCapExceeded(state)) return null;
    if (!(await allowHostedCall(state, openRouterTextCall("document-map", model), [document.id]))) return null;
    const maxSiphonPages = Math.min(60, Math.ceil(0.05 * pageCount));
    if (maxSiphonPages < 1) return null;
    return await runSiphonLoop({
      pageCount, maxSiphonPages, seed: args.draft, initialObservations: args.initialObservations, shouldStop: () => isCostCapExceeded(state), signal: args.signal,
      readWindow: async (first, last) => {
        // Fast never reads a page with a model: the siphon sees only the text layer, and scanned pages stay unread.
        if (args.bornDigital || !qualityAllowsPageReading(state.run.pipeline.quality)) {
          const pageTexts = await ops.extractText(args.source, first, last, args.signal);
          pageTexts.forEach((t, i) => args.text.set(first + i, t));
          return { pageTexts };
        }
        const ocr = await ops.ocrPages({ document, first, last, state, signal: args.signal });
        ocr.pageTexts.forEach((t, i) => args.text.set(first + i, t));
        return ocr;
      },
      decide: async (observation, mapSoFar) => {
        let costCents = 0;
        const result = await ops.decide({
          observation, mapSoFar, pageCount, model, apiKey, privacyMode: state.run.pipeline.privacyMode, textGeneration, signal: args.signal,
          idPrefix: `a${observation.startPage}`,
          usage: (u) => {
            const event = state.usageLedger.record({
              ...u,
              ...(u.costCents === undefined ? { costCents: calculateAiUsageCostCents({ inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, costPer1kInputTokens: this.config.costPer1kInputTokens, costPer1kOutputTokens: this.config.costPer1kOutputTokens }) } : {}),
              metadata: { ...u.metadata, documentId: document.id },
            });
            costCents += event?.costCents ?? 0;
          },
        });
        return { ...result, costCents };
      },
    });
  }

  private async ocrPages(args: { document: Document; first: number; last: number; state: WorkflowState; signal?: AbortSignal }): Promise<{ pageTexts: string[]; costCents: number }> {
    const { document, state } = args;
    const pageNumbers = Array.from({ length: args.last - args.first + 1 }, (_, i) => args.first + i);
    // Fail closed: Fast never sends a page to a vision model, whoever asks.
    if (!qualityAllowsPageReading(state.run.pipeline.quality)) return { pageTexts: pageNumbers.map(() => ""), costCents: 0 };
    const artifacts = await this.rasters.renderSelectedPages({ document, runId: state.run.id, pageNumbers, dpi: OCR_DPI, signal: args.signal });
    const byPage = new Map(artifacts.map((a) => [a.pageNumber, a]));
    let costCents = 0;
    const pageTexts: string[] = [];
    for (const pageNumber of pageNumbers) {
      const artifact = byPage.get(pageNumber);
      if (!artifact) { pageTexts.push(""); continue; }
      const imagePath = await this.storage.downloadToTempFile(artifact.artifactKey, `map-${pageNumber}-*.png`);
      try {
        const result = await executeVisionRuntime({
          imagePath, mimeType: artifact.mimeType, outputPath: `${imagePath}.vision.json`, vision: state.run.pipeline.vision,
          cfg: this.config, runner: this.runner, privacyMode: state.run.pipeline.privacyMode,
          signal: args.signal,
        });
        const cents = result.costCents ?? calculateAiUsageCostCents({ inputTokens: result.inputTokens, outputTokens: result.outputTokens, costPer1kInputTokens: this.config.costPer1kInputTokens, costPer1kOutputTokens: this.config.costPer1kOutputTokens });
        costCents += cents;
        state.usageLedger.record({
          provider: result.provider ?? "vision-runtime", model: result.model, metric: "document-map-ocr", amount: 1, unit: "page",
          inputTokens: result.inputTokens, outputTokens: result.outputTokens, costCents: cents, metadata: { documentId: document.id, pageNumber },
        });
        pageTexts.push(result.text);
      } finally {
        await rm(`${imagePath}.vision.json`, { force: true });
        await rm(path.dirname(imagePath), { recursive: true, force: true });
      }
    }
    return { pageTexts, costCents };
  }

  private async persist(args: {
    state: WorkflowState; document: Document; sql: Sql; built: BuiltMap; structure: PdfStructure; coarsePages: number[];
    ops: DocumentMapOps; sourcePath: string; text: Map<number, string>; signal?: AbortSignal;
  }): Promise<void> {
    const { state, document, sql, built } = args;
    const pageCount = args.structure.pageCount;
    await ensurePageRows(sql, document.id, pageCount);

    // Coarse layer: one pdftotext call per contiguous span (not per page).
    const coarse = new Map<number, string>();
    for (const [first, last] of contiguousSpans(args.coarsePages)) {
      const pages = await args.ops.extractText(args.sourcePath, first, last, args.signal);
      pages.forEach((t, i) => coarse.set(first + i, t));
    }
    let coarseRows = [...coarse.entries()].filter(([, t]) => t.trim().length > 0);
    // The coarse layer is searchable, so it obeys the workspace PII policy exactly like materialized pages.
    const policy = resolvePolicy(state.run.pipeline);
    const blockedPages: number[] = [];
    if (policy.enabled && policy.patterns.length > 0) {
      const scan = createPiiTextScanner(policy.patterns, policy.allowlistPatterns);
      coarseRows = coarseRows.flatMap(([pageNumber, text]): Array<[number, string]> => {
        const scanned = scan(text, pageNumber);
        if (scanned.matches.length === 0) return [[pageNumber, text]];
        if (policy.action === "block_indexing") { blockedPages.push(pageNumber); return []; }
        return [[pageNumber, policy.action === "redact_artifacts" ? scanned.redacted : text]];
      });
    }

    const searchText = [...built.nodes.map((n) => n.title), ...built.terms.map((t) => t.term)].join(" \n");
    const decisions = built.siphon?.decisions ?? [];
    await sql.begin(async (tx) => {
      const q = tx as unknown as Sql;
      await q`
        insert into document_maps (document_id, run_id, version, nodes, terms, label_segments, coverage, siphon_pages, siphon_decisions, search_text)
        values (${document.id}, ${state.run.id}, 1, ${sql.json(built.nodes as never)}, ${sql.json(built.terms as never)}, ${sql.json(built.segments as never)},
                ${built.coverage}, ${built.siphon?.pagesRead.length ?? 0}, ${sql.json(decisions as never)}, to_tsvector('simple', ${searchText}))
        on conflict (document_id) do update set
          run_id = excluded.run_id, version = document_maps.version + 1, nodes = excluded.nodes, terms = excluded.terms,
          label_segments = excluded.label_segments, coverage = excluded.coverage, siphon_pages = excluded.siphon_pages,
          siphon_decisions = excluded.siphon_decisions, search_text = excluded.search_text, updated_at = now()
      `;

      // Labels for every page; `mapped` for the pages actually read.
      const read = new Set(built.pagesRead);
      const pageRows = Array.from({ length: pageCount }, (_, i) => ({
        page: i + 1,
        label: labelFor(i + 1, args.structure.pageLabels, built.segments, built.labelSource),
        mapped: read.has(i + 1),
      }));
      await q`
        update document_page_states s
        set page_label = v.label, label_source = ${built.labelSource}, mapped = v.mapped, updated_at = now()
        from jsonb_to_recordset(${sql.json(pageRows as never)}) as v(page int, label text, mapped boolean)
        where s.document_id = ${document.id} and s.page_number = v.page
      `;

      if (coarseRows.length > 0) {
        const rows = coarseRows.map(([pageNumber, t]) => ({
          id: `${document.id}-page-${String(pageNumber).padStart(4, "0")}`, document_id: document.id, run_id: state.run.id,
          user_id: document.userId, page_number: pageNumber, text: t, token_estimate: Math.ceil(t.length / 4),
        }));
        for (let i = 0; i < rows.length; i += 200) {
          await q`
            insert into document_pages ${q(rows.slice(i, i + 200), "id", "document_id", "run_id", "user_id", "page_number", "text", "token_estimate")}
            on conflict (id) do update set run_id = excluded.run_id, text = excluded.text, token_estimate = excluded.token_estimate
          `;
        }
        const parsed = coarseRows.map(([p]) => p);
        await q`
          update document_page_states set state = 'parsed', updated_at = now()
          where document_id = ${document.id} and page_number = any(${parsed}::int[]) and state in ('unseen', 'failed')
        `;
      }

      if (blockedPages.length > 0) {
        await q`
          update document_page_states set state = 'blocked-pii', failure_reason = 'pii-policy', updated_at = now()
          where document_id = ${document.id} and page_number = any(${blockedPages}::int[]) and state in ('unseen', 'failed', 'parsed')
        `;
        // A coarse row written before the policy tightened must not survive, nor a kept model read of the page.
        await q`delete from document_pages where document_id = ${document.id} and page_number = any(${blockedPages}::int[])`;
        await q`
          update document_page_states set read_text = null
          where document_id = ${document.id} and page_number = any(${blockedPages}::int[]) and read_text is not null
        `;
      }

      if (built.title) {
        await q`update documents set metadata = metadata || ${sql.json({ mapTitle: built.title })} where id = ${document.id}`;
      }
    });

    const fee = this.deps.pageMappedFeeUsd ?? Number.parseFloat(process.env.DOCSLURP_PAGE_MAPPED_FEE_USD ?? "0");
    if (built.pagesRead.length > 0) {
      state.usageLedger.enqueue({
        provider: "docslurp", model: "document-map", metric: "page-mapped", amount: built.pagesRead.length, unit: "page",
        costCents: Number.isFinite(fee) && fee > 0 ? fee * 100 * built.pagesRead.length : 0,
        metadata: { documentId: document.id, coverage: built.coverage, coarsePages: coarse.size },
      });
    }
  }
}

/**
 * Sampled pages whose text the deterministic parsers did not turn into structure, as the agent's first
 * observations (front window, then back window). Text is already in memory: no extraction cost.
 */
function unexplainedSamples(text: Map<number, string>, pageCount: number, backStart: number, bornDigital: boolean): SiphonWindowObservation[] {
  if (!bornDigital) return [];
  const usable = (p: number) => (text.get(p) ?? "").replace(/\s/g, "").length >= BORN_DIGITAL_MIN_CHARS;
  const explained = (p: number) => parseTocText([text.get(p) ?? ""]).length > 0 || parseIndexText([text.get(p) ?? ""]).length > 0;
  const windowOf = (first: number, last: number): SiphonWindowObservation | null => {
    const pages: number[] = [];
    for (let p = first; p <= last; p++) if (usable(p) && !explained(p)) pages.push(p);
    if (pages.length === 0) return null;
    const startPage = pages[0]!, endPage = pages[pages.length - 1]!;
    return { startPage, endPage, pageTexts: Array.from({ length: endPage - startPage + 1 }, (_, i) => text.get(startPage + i) ?? "") };
  };
  const front = windowOf(1, Math.min(SIPHON_WINDOW_PAGES, pageCount));
  const back = backStart <= pageCount ? windowOf(Math.max(backStart, pageCount - SIPHON_WINDOW_PAGES + 1), pageCount) : null;
  return [front, back].filter((o): o is SiphonWindowObservation => o !== null);
}

function contractNode(n: MapNode): MapNode {
  const { id, title, level, parentId, printedStart, printedEnd, physicalStart, physicalEnd, source, confidence } = n;
  return { id, title, level, parentId, printedStart, printedEnd, physicalStart, physicalEnd, source, confidence };
}

function labelFor(page: number, pdfLabels: string[] | null, segments: LabelSegment[], source: BuiltMap["labelSource"]): string | null {
  if (source === "pdf-page-labels") return pdfLabels?.[page - 1] ?? null;
  if (source === "none") return null;
  const segment = segments.find((s) => page >= s.physicalStart && page <= s.physicalEnd);
  if (!segment || segment.style === "other") return null;
  const value = page - segment.offset;
  if (value < 1) return null;
  return segment.style === "roman" ? intToRoman(value) : String(value);
}

function contiguousSpans(pages: number[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const p of [...pages].sort((a, b) => a - b)) {
    const last = spans[spans.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else spans.push([p, p]);
  }
  return spans;
}

function uncoveredPages(nodes: MapNode[], pageCount: number, all: boolean): number[] {
  const covered = new Uint8Array(pageCount + 1);
  if (!all) {
    for (const node of nodes) {
      if (node.physicalStart === null) continue;
      for (let p = Math.max(1, node.physicalStart); p <= Math.min(pageCount, node.physicalEnd ?? node.physicalStart); p++) covered[p] = 1;
    }
  }
  const out: number[] = [];
  for (let p = 1; p <= pageCount; p++) if (!covered[p]) out.push(p);
  return out;
}

/**
 * Orders nodes by physical start (stable), assigns parents from level nesting where missing, and ends each
 * node at the page before its next sibling (the next node of the same or a shallower level); the last
 * sibling ends where its parent ends, or at the final page.
 */
export function finalizeNodes<T extends MapNode>(input: T[], pageCount: number): T[] {
  const located = input.filter((n) => n.physicalStart !== null && n.physicalStart >= 1 && n.physicalStart <= pageCount);
  const ordered = located.map((n, i) => ({ n, i })).sort((a, b) => a.n.physicalStart! - b.n.physicalStart! || a.i - b.i).map((x) => ({ ...x.n }));
  const stack: T[] = [];
  const byId = new Map<string, T>();
  for (const node of ordered) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= node.level) stack.pop();
    if (node.parentId === null || !ordered.some((o) => o.id === node.parentId)) node.parentId = stack[stack.length - 1]?.id ?? null;
    stack.push(node);
    byId.set(node.id, node);
  }
  ordered.forEach((node, i) => {
    let end: number | null = null;
    for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[j]!.level <= node.level) { end = Math.max(node.physicalStart!, ordered[j]!.physicalStart! - 1); break; }
    }
    if (end === null) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      end = parent?.physicalEnd ?? pageCount;
    }
    node.physicalEnd = Math.min(pageCount, Math.max(node.physicalStart!, end));
  });
  return ordered;
}
