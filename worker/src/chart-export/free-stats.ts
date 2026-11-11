/**
 * Free `VisualCandidateStats` for a document: no model, no extractor, no host parsing. Signals are stored worker
 * outputs only: the page router plan (any mode: shadow plans carry the same labels), the legacy classifier's
 * `chart-or-figure` pages, image routing's `chart-diagram` media-map images, and the Office chart part count the
 * quarantine inspection took from zip entry names inside the parser VM.
 *
 * `render-images` (which runs for every document and already holds the classification) records these whenever chart
 * export is not active, so chat suggestions and the ingest report see charts in projects that never turned on vision
 * or chart export, and `vision-extract` stays inert with export off. With export on, `vision-extract` records the
 * stats of what it exported instead. Reads are gated on the ledger: a slot the document lacks is never fetched.
 */
import { adaptiveRoutingDecisionSurfaceSchema, defaultChartExportConfig, type RoutePlan, type VisualCandidateStats } from "@docslurp/shared";

import type { Document } from "../models.js";
import type { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import { PAGE_ROUTE_PLAN_SLOT, parseRoutePlan } from "../routing/runtime.js";
import { keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";
import { ChartExportSession } from "./session.js";
import { runChartExportPass, type ChartExportPassInput } from "./stage.js";
import type { DeterministicVisualResult } from "./types.js";
import { deterministicSourceKind } from "./vm-extractor.js";

type Storage = Pick<ArtifactStore, "bucket" | "getJson">;

async function readJson(storage: Storage, uri: string | undefined): Promise<unknown | null> {
  const key = uri ? keyFromStorageUri(uri, storage.bucket) : null;
  if (!key) return null;
  try {
    return await storage.getJson(key);
  } catch {
    return null;
  }
}

/** Office chart parts counted by the quarantine inspection (zip entry names, parser VM). */
export async function quarantineChartPresence(storage: Storage, ledger: DocumentArtifactLedger, documentId: string): Promise<DeterministicVisualResult["presence"]> {
  const artifact = await readJson(storage, ledger.readDocument(documentId, "quarantine"));
  const parts = (artifact as { archive?: { chartParts?: unknown } } | null)?.archive?.chartParts;
  return Number.isSafeInteger(parts) && (parts as number) > 0 ? { officeChartParts: parts as number } : {};
}

/** The stored route plan in any router mode (labels only; nothing executes it here). */
export async function storedRoutePlan(storage: Storage, ledger: DocumentArtifactLedger, documentId: string): Promise<RoutePlan | null> {
  return parseRoutePlan(await readJson(storage, ledger.readDocument(documentId, PAGE_ROUTE_PLAN_SLOT)));
}

/** Legacy classifier pages (their `route`), when the classification surface is ready. */
export async function legacyRoutedPages(storage: Storage, ledger: DocumentArtifactLedger, documentId: string): Promise<Array<{ pageNumber: number; route?: string | null }>> {
  const parsed = adaptiveRoutingDecisionSurfaceSchema.safeParse(await readJson(storage, ledger.readDocument(documentId, "classification")));
  return parsed.success && parsed.data.status === "ready" ? parsed.data.pages : [];
}

export async function freeVisualCandidateStats(args: {
  storage: ChartExportPassInput["storage"];
  ledger: DocumentArtifactLedger;
  document: Pick<Document, "id" | "userId" | "mimeType" | "pageCount">;
  run: ChartExportPassInput["run"];
  /** The classification surface when the caller already read it (render-images does). */
  classification?: unknown;
}): Promise<{ stats: VisualCandidateStats; lowConfidence: number }> {
  const { storage, ledger, document } = args;
  const legacy = args.classification !== undefined
    ? (() => {
      const parsed = adaptiveRoutingDecisionSurfaceSchema.safeParse(args.classification);
      return parsed.success && parsed.data.status === "ready" ? parsed.data.pages : [];
    })()
    : await legacyRoutedPages(storage, ledger, document.id);
  const [routedPlan, presence] = await Promise.all([
    storedRoutePlan(storage, ledger, document.id),
    deterministicSourceKind(document.mimeType) === "office" ? quarantineChartPresence(storage, ledger, document.id) : Promise.resolve({}),
  ]);
  const session = new ChartExportSession({
    documentId: document.id, config: defaultChartExportConfig, catalog: () => [], client: null, recordUsage: () => undefined,
  });
  const pass = await runChartExportPass({
    session, document, run: args.run, storage, ledger, routedPlan, legacyPages: legacy, ...(presence ? { presence } : {}), pageImage: async () => null,
  });
  return { stats: pass.stats, lowConfidence: pass.lowConfidence };
}
