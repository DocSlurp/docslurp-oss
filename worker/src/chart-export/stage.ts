/**
 * The document-level chart export pass in `vision-extract`, in two halves around the stage body:
 *
 * 1. `prepareChartExport` (before the body): gathers candidates from free signals (router plan labels, image routing's
 *    `chart-diagram` media-map images, legacy `chart-or-figure` pages confirmed by a non-keyword signal) and, when
 *    export is on, asks the deterministic extractor (parser VM) for partials. Routed crops exported during the body
 *    then see those partials, so a confident free spec is used instead of a model call and no visual is exported twice.
 * 2. `finishChartExport` (after the body): exports every candidate the body did not try (image-routing images, chart
 *    roles the router sent to a non-VLM target, confirmed legacy pages; crops when a placement is known, the page
 *    raster otherwise), then deterministic partials no candidate claimed. It replaces this document's marked visual
 *    groups in the page Markdown (a reprocess seeds the previous run's canonical document, blocks included), sets
 *    `charts[]`, stores the visuals artifact and returns `VisualCandidateStats`.
 *
 * `clearChartExport` removes a previous run's groups and `charts[]` when export is off on a reprocess.
 */
import {
  canonicalDocumentSchema,
  DOPPLER_FIGURES_INDEX_SLOT,
  dopplerFigureRecordSchema,
  extractionContractSchema,
  VISUAL_CANDIDATE_STATS_KEY,
  type BBox,
  type CanonicalBlock,
  type ExportedVisual,
  type RoutePlan,
  type VisualCandidateStats,
} from "@docslurp/shared";

import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { canonicalDocumentToMarkdown, reconcileCanonicalArtifacts } from "../lib/canonical-reconciliation.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import type { Document, UsageEvent } from "../models.js";
import type { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import { refreshSummaryEvidence } from "../stages/summary-evidence-refresh.js";
import { keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";
import { formatsFor } from "./config.js";
import { toExtractionCharts } from "./contract.js";
import { stripVisualGroups, visualBlock, wrapVisualGroup, type VisualGroupRef } from "./markdown.js";
import { candidatesFromLegacyRoutes, candidatesFromMediaMap, candidatesFromPlan, guardedScopesFromPlan, type ChartExportSession } from "./session.js";
import { deterministicVisualExtractor, type DeterministicVisualResult, type VisualCandidate, type VisualImage } from "./types.js";

export const CHART_EXPORT_ARTIFACT_SLOT = "chart-export";
/** Suffix of the artifact a cleared document records (export turned off): nothing left to remove, no read needed. */
const CLEARED_SUFFIX = ".cleared.json";

type PassStorage = Pick<ArtifactStore, "bucket" | "getJson" | "putJson" | "putBytes" | "uri" | "deleteKeys">;
type PassDocument = Pick<Document, "id" | "userId" | "mimeType" | "pageCount"> & Partial<Pick<Document, "sourceKey" | "sourceSha256" | "originalSourceSha256" | "parseSourceDecision">>;

export type PageImage = VisualImage & { release: () => Promise<void>; dpi?: number | null };

export interface ChartExportPassInput {
  session: ChartExportSession;
  document: PassDocument;
  run: { id: string; storagePrefix?: string | null };
  storage: PassStorage;
  ledger: DocumentArtifactLedger;
  routedPlan: RoutePlan | null;
  legacyPages: ReadonlyArray<{ pageNumber: number; route?: string | null }>;
  /** Quarantine's free presence counts (Office chart parts): stats with export off, the VM signal with export on. */
  presence?: DeterministicVisualResult["presence"];
  /** Page raster (the caller cleans it up through `release`). */
  pageImage: (pageNumber: number) => Promise<PageImage | null>;
  /** Crops a page raster to a placement in page points; null when cropping is unavailable (the page is used). */
  cropImage?: (image: PageImage, bbox: BBox) => Promise<PageImage | null>;
  /** The stage's usage ledger for cost-only events (parser-VM time of the deterministic extractor). */
  recordUsage?: (event: UsageEvent) => void;
  signal?: AbortSignal;
}

export interface PreparedChartExport {
  mediaMapUri: string | null;
  /** The visuals artifact a previous run left in this document's slot (seeded on a partial reprocess). */
  priorArtifactUri: string | null;
  /** The marked groups that artifact records (id and nonce): the only groups this export removes from the pages. */
  priorGroups?: VisualGroupRef[];
}

export interface ChartExportPassResult {
  stats: VisualCandidateStats;
  /** Legacy keyword pages no other signal confirmed (counted apart; never exported or priced). */
  lowConfidence: number;
  changedPages: number[];
  artifactUri: string | null;
}

async function readJsonAt(storage: Pick<ArtifactStore, "bucket" | "getJson">, uri: string | undefined | null): Promise<unknown | null> {
  const key = uri ? keyFromStorageUri(uri, storage.bucket) : null;
  if (!key) return null;
  try {
    return await storage.getJson(key);
  } catch {
    return null;
  }
}

/**
 * The visual groups a previous export recorded in its chart-export artifact (`markers: { nonce, ids }`). Unreadable or
 * absent: none, so nothing in the pages is removed (marker-like text that export did not record is never stripped).
 */
export async function priorVisualGroups(storage: Pick<ArtifactStore, "bucket" | "getJson">, uri: string | null | undefined): Promise<VisualGroupRef[]> {
  if (!uri || uri.endsWith(CLEARED_SUFFIX)) return [];
  const artifact = await readJsonAt(storage, uri);
  const markers = (artifact as { markers?: { nonce?: unknown; ids?: unknown } } | null)?.markers;
  if (!markers || typeof markers.nonce !== "string" || !/^[0-9a-f]{16}$/.test(markers.nonce) || !Array.isArray(markers.ids)) return [];
  const nonce = markers.nonce;
  return markers.ids
    .slice(0, 10_000)
    .filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id))
    .map((id) => ({ id, nonce }));
}

/** The media map, found through the artifact graph manifest (PDF sources with embedded images). No slot, no read. */
export async function loadMediaMap(storage: Pick<ArtifactStore, "bucket" | "getJson">, ledger: DocumentArtifactLedger, documentId: string): Promise<{ uri: string | null; map: unknown | null }> {
  const manifestUri = ledger.readDocument(documentId, "artifact-graph");
  if (!manifestUri) return { uri: null, map: null };
  const manifest = await readJsonAt(storage, manifestUri);
  const artifacts = (manifest as { artifacts?: Array<{ kind?: unknown; uri?: unknown }> } | null)?.artifacts;
  const entry = Array.isArray(artifacts) ? artifacts.find((a) => a?.kind === "document/media-map" && typeof a.uri === "string") : undefined;
  const uri = typeof entry?.uri === "string" ? entry.uri : null;
  return { uri, map: uri ? await readJsonAt(storage, uri) : null };
}

/** Pages holding a Doppler figure (any format), and the raw index for the extractor. No slot, no read. */
export async function loadDopplerFigurePages(storage: Pick<ArtifactStore, "bucket" | "getJson">, ledger: DocumentArtifactLedger, documentId: string): Promise<{ pages: Set<number>; index: unknown | null }> {
  const index = await readJsonAt(storage, ledger.readDocument(documentId, DOPPLER_FIGURES_INDEX_SLOT));
  const figures = (index as { figures?: unknown } | null)?.figures;
  const pages = new Set<number>();
  for (const raw of Array.isArray(figures) ? figures.slice(0, 10_000) : []) {
    const parsed = dopplerFigureRecordSchema.safeParse(raw);
    if (parsed.success) pages.add(parsed.data.page);
  }
  return { pages, index };
}

/** Candidates (and, with export on, deterministic partials) for the document, before the stage body runs. */
export async function prepareChartExport(input: ChartExportPassInput): Promise<PreparedChartExport> {
  const { session, document } = input;
  const priorArtifactUri = input.ledger.readDocument(document.id, CHART_EXPORT_ARTIFACT_SLOT) ?? null;
  session.addGuardedScopes(guardedScopesFromPlan(input.routedPlan));
  session.addCandidates(candidatesFromPlan(input.routedPlan));
  const media = await loadMediaMap(input.storage, input.ledger, document.id);
  session.addCandidates(candidatesFromMediaMap(media.map));
  const legacy = input.routedPlan ? [] : candidatesFromLegacyRoutes(input.legacyPages);
  session.addCandidates(legacy);
  // A Doppler figure confirms a keyword page; read only when the document has a figure index and a keyword page.
  const figures = legacy.length > 0 || session.enabled
    ? await loadDopplerFigurePages(input.storage, input.ledger, document.id)
    : { pages: new Set<number>(), index: null };

  if (!session.enabled) {
    if (input.presence) session.setDeterministic({ partials: [], presence: input.presence });
  } else {
    try {
      session.setDeterministic(await deterministicVisualExtractor()({
        document: {
          id: document.id, mimeType: document.mimeType, pageCount: Math.max(1, document.pageCount),
          sourceKey: document.sourceKey ?? null, sourceSha256: document.sourceSha256 ?? null,
          originalSourceSha256: document.originalSourceSha256 ?? null,
          ...(document.parseSourceDecision ? { parseSourceDecision: document.parseSourceDecision } : {}),
        },
        candidates: session.candidates,
        artifacts: {
          dopplerFiguresIndexUri: input.ledger.readDocument(document.id, DOPPLER_FIGURES_INDEX_SLOT) ?? null,
          mediaMapUri: media.uri,
          artifactUri: (slot) => input.ledger.readDocument(document.id, slot) ?? null,
        },
        signals: {
          officeChartParts: input.presence?.officeChartParts ?? 0,
          htmlEmbedHints: Boolean(input.ledger.readDocument(document.id, "html-embeds")),
          candidates: session.candidates.length,
        },
        ...(figures.index ? { dopplerFiguresIndex: figures.index } : {}),
        ...(input.recordUsage ? { recordUsage: input.recordUsage } : {}),
        diagrams: session.config.diagrams,
        ...(input.signal ? { signal: input.signal } : {}),
      }));
    } catch (error) {
      if (input.signal?.aborted) throw error;
      // The extractor runs in the parser VM; when it is unavailable nothing parses on the host instead.
      console.error(`[chart-export] deterministic extractor failed document=${document.id} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  session.resolveLegacyPages(figures.pages);
  const priorGroups = await priorVisualGroups(input.storage, priorArtifactUri);
  return { mediaMapUri: media.uri, priorArtifactUri, priorGroups };
}

/** Exports what the body did not, replaces this document's visual groups, and stores the visuals artifact. */
export async function finishChartExport(input: ChartExportPassInput, prepared: PreparedChartExport): Promise<ChartExportPassResult> {
  const { session, document } = input;
  if (session.enabled) {
    await exportPending(input);
    await session.exportUnmatchedDeterministic(input.signal);
  }
  const stats = session.stats();
  const lowConfidence = session.lowConfidence.length;
  const prior = prepared.priorArtifactUri && !prepared.priorArtifactUri.endsWith(CLEARED_SUFFIX) ? prepared.priorArtifactUri : null;
  if (!session.enabled || (session.visuals.length === 0 && !prior)) return { stats, lowConfidence, changedPages: [], artifactUri: null };
  const applied = await applyVisualGroups(input, {
    visuals: session.visuals,
    keep: session.routedIds,
    nonce: session.markerNonce,
    blockFor: (v) => visualBlock(v, formatsFor(session.config, v.kind)),
    strip: prepared.priorGroups ?? [],
  });
  // Visuals placed on no page (the document's pages are unknown) are recorded without one.
  const visuals = session.visuals.map((v) => (applied.unpaged.has(v.id) ? { ...v, pageNumber: null } : v));
  const root = runArtifactRoot(input.run, document.userId);
  const visualsKey = `${root}/chart-export/${document.id}.json`;
  await input.storage.putJson(visualsKey, {
    documentId: document.id, [VISUAL_CANDIDATE_STATS_KEY]: stats, lowConfidence, visuals, calls: session.calls,
    // Every group this export placed (routed inserts and appended blocks): the next reprocess removes exactly these.
    markers: { nonce: session.markerNonce, ids: session.visuals.map((v) => v.id) },
  });
  input.ledger.recordDocument(document.id, CHART_EXPORT_ARTIFACT_SLOT, input.storage.uri(visualsKey));
  return { stats, lowConfidence, changedPages: applied.changedPages, artifactUri: input.storage.uri(visualsKey) };
}

export async function runChartExportPass(input: ChartExportPassInput): Promise<ChartExportPassResult> {
  return await finishChartExport(input, await prepareChartExport(input));
}

/**
 * Export off on a document whose earlier run exported visuals (a partial reprocess seeded its slot): removes the
 * marked groups from the pages and empties `charts[]`. Without such a slot it reads nothing and returns false.
 */
export async function clearChartExport(input: Pick<ChartExportPassInput, "document" | "run" | "storage" | "ledger">): Promise<boolean> {
  const { document, ledger, storage } = input;
  const prior = ledger.readDocument(document.id, CHART_EXPORT_ARTIFACT_SLOT);
  if (!prior || prior.endsWith(CLEARED_SUFFIX)) return false;
  const strip = await priorVisualGroups(storage, prior);
  await applyVisualGroups(input, { visuals: [], keep: new Set(), nonce: null, blockFor: () => "", strip });
  const key = `${runArtifactRoot(input.run, document.userId)}/chart-export/${document.id}${CLEARED_SUFFIX}`;
  await storage.putJson(key, { documentId: document.id, cleared: true, visuals: [] });
  ledger.recordDocument(document.id, CHART_EXPORT_ARTIFACT_SLOT, storage.uri(key));
  return true;
}

/**
 * Every candidate the body did not try: one page raster per page, a crop per candidate with a placement, the whole
 * page otherwise (capped per document). With no model call left, nothing is rendered and only free specs can export.
 */
async function exportPending(input: ChartExportPassInput): Promise<void> {
  const { session, document } = input;
  const pending = session.pendingCandidates().sort((a, b) => a.pageNumber - b.pageNumber || a.id.localeCompare(b.id));
  const byPage = new Map<number, VisualCandidate[]>();
  for (const candidate of pending) byPage.set(candidate.pageNumber, [...(byPage.get(candidate.pageNumber) ?? []), candidate]);
  for (const [pageNumber, candidates] of byPage) {
    input.signal?.throwIfAborted();
    let page: PageImage | null = null;
    let pageLoaded = false;
    try {
      for (const candidate of candidates) {
        input.signal?.throwIfAborted();
        // A whole-page candidate with a placed, middling figure reads that figure's crop, not the page.
        const focused = input.cropImage ? session.focusPageCandidate(candidate) : false;
        const crop = Boolean(candidate.bbox && input.cropImage);
        const wantsImage = session.modelAvailable() && (crop || session.pageExportsLeft());
        if (wantsImage && !pageLoaded) {
          pageLoaded = true;
          page = await input.pageImage(pageNumber).catch((error: unknown) => {
            if (input.signal?.aborted) throw error;
            console.warn(`[chart-export] page raster failed document=${document.id} page=${pageNumber} error=${error instanceof Error ? error.message : String(error)}`);
            return null;
          });
        }
        let image: PageImage | null = wantsImage ? page : null;
        let cropped: PageImage | null = null;
        if (image && crop) {
          cropped = await input.cropImage!(image, candidate.bbox!).catch(() => null);
          // No crop of the figure: the whole page is read, so the candidate is the page again (no digest, no pairing).
          if (!cropped && focused) candidate.bbox = null;
          // A placement that cannot be cropped falls back to the page, under the page cap.
          image = cropped ?? (session.pageExportsLeft() ? image : null);
        }
        try {
          await session.exportWithImage(candidate, image, input.signal, { wholePage: Boolean(image) && !cropped });
        } catch (error) {
          if (input.signal?.aborted) throw error;
          console.warn(`[chart-export] export failed document=${document.id} visual=${candidate.id} error=${error instanceof Error ? error.message : String(error)}`);
        } finally {
          await cropped?.release().catch(() => undefined);
        }
      }
    } finally {
      await page?.release().catch(() => undefined);
    }
  }
}

/** Canonical block metadata naming the visual group an unpaged block belongs to (set only by this export). */
const UNPAGED_GROUP_KEY = "chartExportGroup";

function unpagedGroupOf(block: CanonicalBlock): VisualGroupRef | null {
  const group = block.metadata[UNPAGED_GROUP_KEY] as { id?: unknown; nonce?: unknown } | undefined;
  return group && typeof group.id === "string" && typeof group.nonce === "string" ? { id: group.id, nonce: group.nonce } : null;
}

/**
 * Rewrites the document's Markdown: removes the previous export's recorded groups (`strip`), appends each new visual's
 * group (not those in `keep`, which the routed merge already placed), and sets `charts[]` from `visuals` (routed ones
 * included). Returns the pages changed and the visuals placed on no page.
 *
 * A visual goes on its page through a page replacement when the document's pages are known. When they are not (no
 * canonical block has a page: DOCX, XLSX, slides that do not map to pages) or the visual has no page, its group is
 * appended as unpaged blocks instead and the visual's page is null: the other blocks keep their pages, ids and
 * provenance. Those blocks carry their group in metadata, so the next export removes exactly them.
 */
async function applyVisualGroups(
  input: Pick<ChartExportPassInput, "document" | "run" | "storage" | "ledger">,
  args: { visuals: readonly ExportedVisual[]; keep: ReadonlySet<string>; nonce: string | null; blockFor: (visual: ExportedVisual) => string; strip: readonly VisualGroupRef[] },
): Promise<{ changedPages: number[]; unpaged: Set<string> }> {
  const { document, storage, ledger } = input;
  const unpaged = new Set<string>();
  const contractJson = await readJsonAt(storage, ledger.readDocument(document.id, "extraction-contract"));
  const canonicalJson = await readJsonAt(storage, ledger.readDocument(document.id, "canonical-document"));
  if (!contractJson || !canonicalJson) {
    console.warn(`[chart-export] artifacts missing document=${document.id} contract=${contractJson ? "present" : "missing"} canonical=${canonicalJson ? "present" : "missing"}`);
    return { changedPages: [], unpaged };
  }
  const contract = extractionContractSchema.parse(contractJson);
  const canonical = canonicalDocumentSchema.parse(canonicalJson);
  const pageCount = Math.max(1, canonical.stats.pageCount);
  const pagesKnown = canonical.blocks.some((block) => block.pageNumber !== null);

  // The previous export's unpaged groups, by the group recorded on their blocks.
  const stripKeys = new Set(args.strip.map((g) => `${g.id} ${g.nonce}`));
  const priorUnpaged = (block: CanonicalBlock) => {
    const group = unpagedGroupOf(block);
    return group !== null && stripKeys.has(`${group.id} ${group.nonce}`);
  };
  const kept = canonical.blocks.filter((block) => !priorUnpaged(block));
  const removedUnpaged = kept.length !== canonical.blocks.length;

  const byPage = new Map<number, ExportedVisual[]>();
  const appended: ExportedVisual[] = [];
  for (const visual of args.visuals) {
    if (args.keep.has(visual.id)) continue;
    if (!pagesKnown || visual.pageNumber === null || visual.pageNumber > pageCount) {
      appended.push(visual);
      unpaged.add(visual.id);
    } else {
      byPage.set(visual.pageNumber, [...(byPage.get(visual.pageNumber) ?? []), visual]);
    }
  }
  const model = (visuals: readonly ExportedVisual[]) => [...new Set(visuals.map((v) => v.model ?? v.source))].join("+") || "chart-export";

  // Paged: page replacements over the paged blocks only (unpaged blocks never ride along into a page).
  let base = { ...canonical, blocks: kept.filter((block) => block.pageNumber !== null) };
  let baseContract = contract;
  let changedPages: number[] = [];
  if (pagesKnown) {
    const pagesText = canonicalDocumentToMarkdown(base).split("\f");
    const pages = args.strip.length > 0 ? pagesText.map((_, i) => i + 1) : [...byPage.keys()];
    const replacements = pages.flatMap((pageNumber) => {
      const visuals = byPage.get(pageNumber) ?? [];
      const { text, removed } = stripVisualGroups(pagesText[pageNumber - 1] ?? "", args.strip);
      const blocks = args.nonce ? visuals.map((v) => wrapVisualGroup(v.id, args.nonce!, args.blockFor(v))).filter(Boolean) : [];
      if (removed.length === 0 && blocks.length === 0) return [];
      const markdown = [text, ...blocks].filter((part) => part.trim()).join("\n\n");
      if (!markdown.trim()) return [];
      return [{
        pageNumber,
        markdown,
        source: {
          adapter: "chart-export",
          model: model(visuals),
          confidence: 1,
          confidenceBasis: "specialist" as const,
          reason: blocks.length > 0 ? "chart-export-append" : "chart-export-remove",
          artifactUri: null,
        },
      }];
    });
    const paged = reconcileCanonicalArtifacts({ canonicalDocument: base, extractionContract: contract, replacements, minimumConfidence: 0 });
    base = paged.canonicalDocument;
    baseContract = paged.extractionContract;
    changedPages = paged.changedPages;
  }

  // Unpaged: the document's other unpaged blocks as they were, then the new groups appended at the end.
  const blocks = [...base.blocks, ...kept.filter((block) => block.pageNumber === null)];
  let order = blocks.reduce((max, block) => Math.max(max, block.order), -1) + 1;
  for (const visual of args.nonce ? appended : []) {
    const markdown = wrapVisualGroup(visual.id, args.nonce!, args.blockFor(visual));
    if (!markdown) continue;
    const parsed = buildCanonicalDocumentFromMarkdown({ documentId: document.id, text: markdown, pageCount: 1, extractor: "chart-export" });
    const provenance = { kind: "specialist-append", adapter: "chart-export", model: model([visual]), confidence: 1, confidenceBasis: "specialist", reason: "chart-export-append-unpaged", artifactUri: null };
    parsed.blocks.forEach((block, index) => {
      blocks.push({
        ...block,
        id: `${document.id}:chart-export:${visual.id}:${index.toString().padStart(4, "0")}`,
        order: order++,
        pageNumber: null,
        bbox: null,
        metadata: { ...block.metadata, extractor: "chart-export", provenance, [UNPAGED_GROUP_KEY]: { id: visual.id, nonce: args.nonce } },
      });
    });
  }
  const unpagedChanged = removedUnpaged || blocks.length !== base.blocks.length + kept.filter((block) => block.pageNumber === null).length;
  // Rebuild Markdown and the contract from the final blocks (no replacement: nothing else is re-parsed).
  const reconciled = reconcileCanonicalArtifacts({ canonicalDocument: { ...base, blocks }, extractionContract: baseContract, replacements: [] });
  const charts = toExtractionCharts(args.visuals.map((v) => (unpaged.has(v.id) ? { ...v, pageNumber: null } : v)), document.id);
  const nextContract = { ...reconciled.extractionContract, charts };
  const root = runArtifactRoot(input.run, document.userId);
  const contractKey = `${root}/extraction-chart-export/${document.id}.contract.json`;
  await storage.putJson(contractKey, nextContract);
  ledger.recordDocument(document.id, "extraction-contract", storage.uri(contractKey));
  if (changedPages.length === 0 && !unpagedChanged) return { changedPages, unpaged };

  const canonicalKey = `${root}/canonical-chart-export/${document.id}.json`;
  const markdownKey = `${root}/markdown-chart-export/${document.id}.md`;
  await Promise.all([
    storage.putJson(canonicalKey, reconciled.canonicalDocument),
    storage.putBytes(markdownKey, Buffer.from(reconciled.markdown, "utf8"), "text/markdown; charset=utf-8"),
  ]);
  ledger.recordDocument(document.id, "canonical-document", storage.uri(canonicalKey));
  ledger.recordDocument(document.id, "markdown", storage.uri(markdownKey));
  await refreshSummaryEvidence({ storage, ledger, document, text: reconciled.markdown, sourceUri: storage.uri(markdownKey) });
  return { changedPages, unpaged };
}
