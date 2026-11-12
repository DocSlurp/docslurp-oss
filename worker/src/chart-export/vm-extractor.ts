/**
 * The production `DeterministicVisualExtractor`: stages the inputs the deterministic rungs read and hands each one to
 * the parser-VM guest through `extractDeterministicVisualsFile` (S2). The host only downloads bytes, verifies the
 * source hash and reads our own Doppler figure index; it never parses a customer file. A refused or unavailable guest
 * is logged and skipped, so the stage continues with the model rungs (fail closed: no host fallback).
 *
 * Inputs, each only when a free signal says it can hold a chart (a parser-VM boot is not free):
 * - the document source when its type can carry exact chart data: DOCX/PPTX/XLSX (`office`) with chart parts counted by
 *   quarantine; EPUB (`epub`) or HTML (`html`) with an embed hint or a detected candidate; a standalone SVG (`svg`) or
 *   JSON (`json`) document, which is itself the candidate;
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
export function chartExportVmUsageEvent(args: { documentId: string; wallTimeMs: number; reason: string; inputs: number; outcome: "ok" | "refused" | "failed" }): UsageEvent {
  const profile = resolveWorkerDeploymentProfile();
  return buildLocalComputeUsageEvent({
    metric: CHART_EXPORT_VM_USAGE_METRIC,
    profile,
    observation: buildAllocatedResourceObservation({ profile, wallTimeMs: Math.max(0, args.wallTimeMs) }),
    costRollup: "included",
    metadata: {
      stage: "vision-extract",
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
  if (kind === "svg" || kind === "json") return "standalone-document";
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
    const results: GuestResult[] = [];
    const options = { diagrams: input.diagrams !== false };
    const context = `document=${document.id}`;
    let guestDown = false;

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
    const reason = sourceKind ? sourceRunReason(sourceKind, input.signals) : null;
    if (sourceKind && document.sourceKey && reason) {
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
          const result = await extractDeterministicVisualsFile({ inputPath: path, kind: sourceKind, options, runner: deps.runner, log, context: `${context} reason=${reason}`, ...(input.signal ? { signal: input.signal } : {}) });
          results.push(result);
          for (const visual of result.visuals) partials.push(toPartial(visual, null));
        });
      } finally {
        await cleanupTempFile(path).catch(() => undefined);
      }
    } else if (sourceKind) {
      log(`[chart-export] parser VM skipped ${context} kind=${sourceKind} reason=no-chart-signal`);
    }

    const figures = await svgFigures(deps, input.artifacts.dopplerFiguresIndexUri, Math.max(1, document.pageCount), input.dopplerFiguresIndex);
    const sent = figures.slice(0, MAX_SVG_FIGURES_PER_DOCUMENT);
    const staged: Array<{ path: string; page: number; bbox: BBox | null }> = [];
    try {
      for (const figure of sent) {
        if (guestDown) break;
        input.signal?.throwIfAborted();
        const slot = ownFigureSlot(figure);
        const uri = slot ? input.artifacts.artifactUri?.(slot) ?? null : null;
        const key = uri ? keyFromStorageUri(uri, deps.storage.bucket) : null;
        if (!key) continue;
        staged.push({ path: await deps.storage.downloadToTempFile(key, "docslurp-chart-figure-*.svg"), page: figure.page, bbox: figureBox(figure.bbox) });
      }
      if (staged.length > 0) {
        // Every figure in one guest run: one VM boot per document, not one per figure.
        await guard("doppler-svg-figures", staged.length, async () => {
          const batch = await extractDeterministicVisualsBatch({ inputPaths: staged.map((s) => s.path), options, runner: deps.runner, log, context: `${context} reason=doppler-svg-figures`, ...(input.signal ? { signal: input.signal } : {}) });
          batch.forEach((result, i) => {
            results.push(result);
            // One figure file holds one visual; when the guest reports several, none can claim the figure's placement.
            for (const visual of result.visuals) partials.push(toPartial(visual, staged[i]!.page, result.visuals.length === 1 ? staged[i]!.bbox : null));
          });
        });
      }
    } finally {
      await Promise.all(staged.map((s) => cleanupTempFile(s.path).catch(() => undefined)));
    }
    if (figures.length > sent.length && !guestDown) log(`[chart-export] svg figures capped ${context} figures=${figures.length} sent=${sent.length}`);

    return { partials, presence: presenceOf(results, figures.length) };
  };
}
