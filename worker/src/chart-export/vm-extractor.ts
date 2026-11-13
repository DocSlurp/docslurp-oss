/**
 * The production `DeterministicVisualExtractor`: stages the inputs the deterministic rungs read and hands each one to
 * the parser-VM guest through `extractDeterministicVisualsFile` (S2). The host only downloads bytes, verifies the
 * source hash and reads our own Doppler figure index; it never parses a customer file. A refused or unavailable guest
 * is logged and skipped, so the stage continues with the model rungs (fail closed: no host fallback).
 *
 * Inputs, each only when a free signal says it can hold a chart (a parser-VM boot is not free):
 * - the document source when its type can carry exact chart data: DOCX/PPTX/XLSX (`office`) with chart parts counted by
 *   quarantine; EPUB (`epub`), HTML (`html`), a standalone SVG (`svg`) or JSON (`json`) document with an embed hint or a
 *   detected candidate (a file type alone never boots the VM);
 * - the stored Doppler SVG figures (`svg`), all in ONE guest run, each placed on the page the figure index records.
 */
import { DOPPLER_FIGURE_LIMITS, dopplerFigureRecordSchema, dopplerFigureSlot, type BBox, type DopplerFigureRecord } from "@docslurp/shared";

import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import type { UsageEvent } from "../models.js";
import { buildAllocatedResourceObservation, buildLocalComputeUsageEvent, resolveWorkerDeploymentProfile } from "../pipeline/local-compute-cost.js";
import { stageSourceFile } from "../sandbox/source-integrity.js";
import type { CommandRunner } from "../tools/runner.js";
import { cleanupTempFile, keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";
import { ChartExtractRefusedError, extractDeterministicVisualsBatch, extractDeterministicVisualsFile, MAX_BATCH_INPUTS, type DeterministicInputKind } from "./extractors/host.js";
import type { DeterministicVisual, DeterministicVisualResult as GuestResult } from "./extractors/types.js";
import { chartExportInlineEnabled, inlineNeedsStandalone } from "./inline.js";
import { FIGURE_CHARTS_SLOT, readStoredFigureCharts } from "./figure-charts.js";
import type { DeterministicVisualExtractor, DeterministicVisualInput, DeterministicVisualPartial, DeterministicVisualResult } from "./types.js";

/** SVG figures sent to the guest per document (one batched VM run). */
export const MAX_SVG_FIGURES_PER_DOCUMENT = MAX_BATCH_INPUTS;

const SOURCE_KINDS: Record<string, DeterministicInputKind> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "office",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "office",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "office",
  "application/epub+zip": "epub",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "image/svg+xml": "svg",
  "application/json": "json",
};

/** The guest input kind for a document's source, or null when its type carries no deterministic chart data. */
export function deterministicSourceKind(mimeType: string): DeterministicInputKind | null {
  return SOURCE_KINDS[mimeType.split(";")[0]!.trim().toLowerCase()] ?? null;
}

const OFFICE_CHART_PART = /(?:^|\/)charts\/chart[^/]*\.xml$/i;

/**
 * S2's visual -> S3's partial. Slides become pages; sheets and DOCX parts have none (page 1 downstream). `bbox` is the
 * placement the host's own figure index records (page points, y down), never a value from the guest.
 */
export function toPartial(visual: DeterministicVisual, pageNumber: number | null, bbox: BBox | null = null): DeterministicVisualPartial {
  return {
    source: visual.source,
    confidence: visual.confidence,
    spec: visual.spec,
    digest: visual.digest,
    kind: visual.kind,
    pageNumber: pageNumber ?? visual.slide ?? null,
    imageIndex: null,
    bbox,
  };
}

/** A Doppler figure's `[x0, y0, x1, y1]` (page points, y down) as a router-space box; null when degenerate. */
export function figureBox(bbox: readonly [number, number, number, number]): BBox | null {
  const [x0, y0, x1, y1] = bbox;
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The only slot a figure's file may be read from: `doppler-figure:<its own id>` (never another artifact slot). */
function ownFigureSlot(figure: DopplerFigureRecord): string | null {
  try {
    const slot = dopplerFigureSlot(figure.id);
    return figure.slot === slot ? slot : null;
  } catch {
    return null;
  }
}

/** Free presence counts from guest results (found, whether or not a spec resolved). */
export function presenceOf(results: readonly GuestResult[], svgFigures: number): NonNullable<DeterministicVisualResult["presence"]> {
  let officeChartParts = 0;
  let embeddedSpecs = 0;
  for (const result of results) {
    for (const visual of result.visuals) {
      if (visual.source === "office-chart-xml") officeChartParts += 1;
      else if (visual.source === "embedded-spec") embeddedSpecs += 1;
    }
    // A chart part the guest refused (limit, malformed) is still a chart the document holds.
    officeChartParts += result.refusals.filter((r) => OFFICE_CHART_PART.test(r.locator)).length;
  }
  return { officeChartParts, embeddedSpecs, svgFigures };
}

/** Usage metric of the parser-VM time chart extraction spends (cost only, `billable: false`). */
export const CHART_EXPORT_VM_USAGE_METRIC = "chart-export-vm";

/**
 * The parser-VM time one guest run of chart extraction took, as a local-compute cost event scoped to the document.
 * `costRollup: "included"`: the sandbox provider's or the runner's own compute event already carries the authoritative
 * cost, so this one attributes it to chart export without counting it twice. Never a customer charge.
 */
export function chartExportVmUsageEvent(args: { documentId: string; wallTimeMs: number; reason: string; inputs: number; outcome: "ok" | "refused" | "failed"; stage?: "vision-extract" | "quarantine" }): UsageEvent {
  const profile = resolveWorkerDeploymentProfile();
  return buildLocalComputeUsageEvent({
    metric: CHART_EXPORT_VM_USAGE_METRIC,
    profile,
    observation: buildAllocatedResourceObservation({ profile, wallTimeMs: Math.max(0, args.wallTimeMs) }),
    costRollup: "included",
    metadata: {
      stage: args.stage ?? "vision-extract",
      scope: "document",
      documentId: args.documentId,
      measurement: "allocated-capacity",
      reason: args.reason,
      inputs: args.inputs,
      outcome: args.outcome,
      billable: false,
    },
  });
}

export interface VmExtractorDeps {
  runner: Pick<CommandRunner, "run">;
  storage: Pick<ArtifactStore, "bucket" | "getJson" | "downloadToTempFile">;
  log?: (message: string) => void;
}

/**
 * Why the source goes to the guest, or null when no free signal says it can hold a chart (no VM run).
 */
export function sourceRunReason(kind: DeterministicInputKind, signals: DeterministicVisualInput["signals"]): string | null {
  // A standalone SVG or JSON document is no longer a chart signal by its type alone (council M1: any caller could boot
  // an unbilled VM per tiny file). It needs a signal the host already holds without parsing the bytes: a candidate from
  // the router plan or media map, or an embed hint the parser VM recorded. Detecting a chart spec inside the guest that
  // converts the document belongs with the inline-VM work (folding extraction into a VM the document already boots).
  if (kind === "svg" || kind === "json") {
    if (signals?.htmlEmbedHints) return "embed-hints";
    return (signals?.candidates ?? 0) > 0 ? "candidates" : null;
  }
  if (kind === "office") return (signals?.officeChartParts ?? 0) > 0 ? "office-chart-parts" : null;
  if (signals?.htmlEmbedHints) return "embed-hints";
  return (signals?.candidates ?? 0) > 0 ? "candidates" : null;
}

async function svgFigures(deps: VmExtractorDeps, indexUri: string | null, pageCount: number, preloaded: unknown): Promise<DopplerFigureRecord[]> {
  let index = preloaded as { figures?: unknown } | null | undefined;
  if (index === undefined) {
    const key = indexUri ? keyFromStorageUri(indexUri, deps.storage.bucket) : null;
    if (!key) return [];
    index = await deps.storage.getJson<{ figures?: unknown }>(key).catch(() => null);
  }
  const figures = Array.isArray(index?.figures) ? index.figures : [];
  const out: DopplerFigureRecord[] = [];
  for (const raw of figures) {
    const parsed = dopplerFigureRecordSchema.safeParse(raw);
    if (!parsed.success) continue;
    const figure = parsed.data;
    // Own SVG file only (repeats point at a figure already listed), within the document and the figure size limit.
    if (figure.format !== "svg" || figure.fileOf !== figure.id || !ownFigureSlot(figure) || figure.page > pageCount) continue;
    if (figure.bytes > DOPPLER_FIGURE_LIMITS.maxFileBytes) continue;
    out.push(figure);
  }
  return out;
}

export function createVmDeterministicVisualExtractor(deps: VmExtractorDeps): DeterministicVisualExtractor {
  const log = deps.log ?? ((message: string) => console.warn(message));
  return async (input) => {
    const { document } = input;
    const partials: DeterministicVisualPartial[] = [];
    const deferred: NonNullable<DeterministicVisualResult["deferred"]> = [];
    const results: GuestResult[] = [];
    const options = { diagrams: input.diagrams !== false };
    const context = `document=${document.id}`;
    let guestDown = false;
    // One admission per document (the per-org free VM cap), asked before the first VM run and reused after.
    let admitted: Promise<boolean> | null = null;
    const admit = (): Promise<boolean> => (admitted ??= (input.admitVmRun ? input.admitVmRun() : Promise.resolve(true)));
    let capLogged = false;

    /** Asked before any bytes are staged for the guest: a refused document downloads nothing and boots no VM. */
    const admittedToVm = async (): Promise<boolean> => {
      if (await admit()) return true;
      if (!capLogged) log(`[chart-export] parser VM skipped ${context} reason=org-free-vm-cap`);
      capLogged = true;
      return false;
    };

    const guard = async (reason: string, inputs: number, run: () => Promise<void>): Promise<void> => {
      if (guestDown) return;
      const started = Date.now();
      let outcome: "ok" | "refused" | "failed" = "ok";
      try {
        await run();
      } catch (error) {
        outcome = error instanceof ChartExtractRefusedError ? "refused" : "failed";
        input.signal?.throwIfAborted();
        if (!(error instanceof ChartExtractRefusedError)) throw error;
        // Already logged by the host entry (with the document id and reason); a VM that is down stays down here.
        if (error.reason.startsWith("guest-")) guestDown = true;
      } finally {
        // Every guest run is recorded, refused or failed ones too: the VM time was spent either way.
        input.recordUsage?.(chartExportVmUsageEvent({ documentId: document.id, wallTimeMs: Date.now() - started, reason, inputs, outcome }));
      }
    };

    const sourceKind = deterministicSourceKind(document.mimeType);
    // Inline answer from the quarantine guest for this very kind (DOCSLURP_CHART_EXPORT_INLINE): the source was already
    // read in the VM it booted for quarantine, so it is used as is and no parser VM runs for the source. Only an answer
    // too big to carry inline goes to the standalone guest, which has the larger result allowance.
    const inline = sourceKind && input.inline && input.inline.kind === sourceKind ? input.inline : null;
    const useInline = inline !== null && !inlineNeedsStandalone(inline);
    if (useInline) {
      if (inline.status === "ok") {
        results.push(inline.result);
        for (const visual of inline.result.visuals) partials.push(toPartial(visual, null));
        // SVGs past the scene budget are recorded for the later deferred pass, exactly as from the standalone guest.
        for (const d of inline.result.deferred ?? []) deferred.push({ input: "source", locator: d.locator, reason: d.reason, pageNumber: null, figureId: null });
      }
      log(`[chart-export] parser VM skipped ${context} kind=${sourceKind} reason=inline-${inline.status}${inline.status === "ok" ? ` visuals=${inline.result.visuals.length}` : ` detail=${inline.reason}`}`);
    }
    const reason = sourceKind && !useInline ? (inline ? "inline-result-too-large" : sourceRunReason(sourceKind, input.signals)) : null;
    if (sourceKind && document.sourceKey && reason && await admittedToVm()) {
      const path = await stageSourceFile(
        deps.storage,
        {
          id: document.id, sourceKey: document.sourceKey, sourceSha256: document.sourceSha256 ?? null,
          originalSourceSha256: document.originalSourceSha256 ?? null,
          ...(document.parseSourceDecision ? { parseSourceDecision: document.parseSourceDecision } : {}),
        },
        trustedTempDownloadPattern("docslurp-chart-source-", document),
      );
      try {
        await guard(reason, 1, async () => {
          const result = await extractDeterministicVisualsFile({ inputPath: path, kind: sourceKind, options: { ...options, pages: Math.max(1, document.pageCount) }, runner: deps.runner, log, context: `${context} reason=${reason}`, ...(input.signal ? { signal: input.signal } : {}) });
          results.push(result);
          for (const visual of result.visuals) partials.push(toPartial(visual, null));
          for (const d of result.deferred ?? []) deferred.push({ input: "source", locator: d.locator, reason: d.reason, pageNumber: null, figureId: null });
        });
      } finally {
        await cleanupTempFile(path).catch(() => undefined);
      }
    } else if (sourceKind && !useInline) {
      log(`[chart-export] parser VM skipped ${context} kind=${sourceKind} reason=no-chart-signal`);
    }

    // Inline mode: figure SVGs never go to a standalone VM run (they carry no text, so it would export nothing). Their charts
    // come from the Doppler VM's own figure pass (protocol 15, words beside each figure), stored by extract-markdown under
    // FIGURE_CHARTS_SLOT and validated again here; page and box come from the host's figure index.
    if (chartExportInlineEnabled()) {
      const listed = input.artifacts.dopplerFiguresIndexUri || input.dopplerFiguresIndex !== undefined
        ? (await svgFigures(deps, input.artifacts.dopplerFiguresIndexUri, Math.max(1, document.pageCount), input.dopplerFiguresIndex)).length
        : 0;
      const chartsUri = input.artifacts.artifactUri?.(FIGURE_CHARTS_SLOT) ?? null;
      const chartsKey = chartsUri ? keyFromStorageUri(chartsUri, deps.storage.bucket) : null;
      const charts = chartsKey ? readStoredFigureCharts(await deps.storage.getJson(chartsKey).catch(() => null)) : null;
      if (charts?.status === "ok") {
        for (const figure of charts.figures) {
          if (figure.page > Math.max(1, document.pageCount)) continue;
          results.push(figure.result);
          const box = figureBox(figure.bbox);
          for (const visual of figure.result.visuals) partials.push(toPartial(visual, figure.page, figure.result.visuals.length === 1 ? box : null));
          for (const d of figure.result.deferred ?? []) deferred.push({ input: "doppler-figure", locator: d.locator, reason: d.reason, pageNumber: figure.page, figureId: figure.id });
        }
        if (charts.ms !== null) input.recordUsage?.(chartExportVmUsageEvent({ documentId: document.id, wallTimeMs: charts.ms, reason: "doppler-figure-charts", inputs: charts.figures.length, outcome: "ok" }));
        log(`[chart-export] doppler figure charts ${context} figures=${charts.figures.length} visuals=${charts.figures.reduce((n, f) => n + f.result.visuals.length, 0)}`);
      } else if (listed > 0) log(`[chart-export] svg figures not sent ${context} figures=${listed} reason=inline-mode${charts ? ` charts=${charts.reason}` : ""}`);
      if (deferred.length) log(`[chart-export] visuals deferred ${context} count=${deferred.length}`);
      return { partials, presence: presenceOf(results, listed), ...(deferred.length ? { deferred: deferred.slice(0, 1000) } : {}) };
    }

    const figures = await svgFigures(deps, input.artifacts.dopplerFiguresIndexUri, Math.max(1, document.pageCount), input.dopplerFiguresIndex);
    const sent = figures.length > 0 && await admittedToVm() ? figures.slice(0, MAX_SVG_FIGURES_PER_DOCUMENT) : [];
    const staged: Array<{ path: string; page: number; bbox: BBox | null; id: string }> = [];
    try {
      for (const figure of sent) {
        if (guestDown) break;
        input.signal?.throwIfAborted();
        const slot = ownFigureSlot(figure);
        const uri = slot ? input.artifacts.artifactUri?.(slot) ?? null : null;
        const key = uri ? keyFromStorageUri(uri, deps.storage.bucket) : null;
        if (!key) continue;
        staged.push({ path: await deps.storage.downloadToTempFile(key, "docslurp-chart-figure-*.svg"), page: figure.page, bbox: figureBox(figure.bbox), id: figure.id });
      }
      if (staged.length > 0) {
        // Every figure in one guest run: one VM boot per document, not one per figure.
        await guard("doppler-svg-figures", staged.length, async () => {
          // The document's page count scales the batch's SVG geometry budget (a few figures' worth per page).
          const batch = await extractDeterministicVisualsBatch({ inputPaths: staged.map((s) => s.path), options: { ...options, pages: Math.max(1, document.pageCount) }, runner: deps.runner, log, context: `${context} reason=doppler-svg-figures`, ...(input.signal ? { signal: input.signal } : {}) });
          batch.forEach((result, i) => {
            results.push(result);
            // One figure file holds one visual; when the guest reports several, none can claim the figure's placement.
            for (const visual of result.visuals) partials.push(toPartial(visual, staged[i]!.page, result.visuals.length === 1 ? staged[i]!.bbox : null));
            for (const d of result.deferred ?? []) deferred.push({ input: "doppler-figure", locator: d.locator, reason: d.reason, pageNumber: staged[i]!.page, figureId: staged[i]!.id });
          });
        });
      }
    } finally {
      await Promise.all(staged.map((s) => cleanupTempFile(s.path).catch(() => undefined)));
    }
    if (figures.length > sent.length && !guestDown && !capLogged) log(`[chart-export] svg figures capped ${context} figures=${figures.length} sent=${sent.length}`);

    if (deferred.length) log(`[chart-export] visuals deferred ${context} count=${deferred.length}`);
    return { partials, presence: presenceOf(results, figures.length), ...(deferred.length ? { deferred: deferred.slice(0, 1000) } : {}) };
  };
}
