/*
 * Extractor plugins: optional providers a deployment loads by configuration, never by import.
 *
 * DocSlurp ships an open default for everything here. A deployment may add one sandboxed PDF extractor (served as the
 * `vm-pdf` extractor id), one image orientation provider and one sandboxed OCR provider (`DOCSLURP_OCR_MODE=vm`) by naming
 * plugin modules in DOCSLURP_EXTRACTOR_PLUGINS (comma-separated absolute paths or file: URLs). Each module exports
 * `register(host)`, which returns the plugin.
 *
 * Rules the host enforces:
 * - Fail closed. A named plugin that cannot load is a startup error, and a deployment that asks for the VM extractor
 *   (DOCSLURP_PDF_EXTRACTOR=vm-pdf, DOCSLURP_VM_PDF_INSTALLED=1 or DOCSLURP_SERVICE_PROFILE=service) without a provider is a startup error. The VM route
 *   never falls back to parsing on the worker host.
 * - A sandboxed PDF provider must isolate every job in a fresh VM or microVM. The worker holds secrets; providers
 *   receive file paths, not credentials, and return only bounded, validated output.
 * - Plugins get host classes through `host`, so errors and usage they raise are the worker's own types.
 *
 * Contract details: docs/extraction/extractor-plugins.md.
 */
import { accessSync, constants as fsConstants } from "node:fs";
import { pathToFileURL } from "node:url";
import { dopplerBinDir, dopplerConverterPath } from "../tools/doppler.js";
import path from "node:path";
import { dopplerImageExtractEnabled } from "./doppler-figures.js";
import {
  DOPPLER_BUILD, DOPPLER_FIGURE_GAP_REASONS, DOPPLER_FIGURE_GAPS_MAX, DOPPLER_IMAGE_EXTRACT_ENV, type DopplerFigureGap, type DopplerImageLimits, localPdfModeRequested, PDF_EXTRACTION_UNCONFIGURED, resolvePdfMode, sandboxedPdfConfigured, type EmbeddedImageFacts, type EmbeddedImageMediaType, type MediaMap, type OrientationResultRecord,
} from "@docslurp/shared";

import { SandboxRunError, type SandboxResult } from "../sandbox/types.js";
import type { UsageEvent } from "../models.js";
import { currentPerfContext } from "../lib/perf-context.js";
import { parsePageLayoutFacts, type PageLayoutFacts } from "../lib/page-layout-facts.js";
import { planPageShards, type ShardCostProfile } from "../temporal/page-shards.js";
import { registerShardProfile } from "../temporal/page-shard-profiles.js";
import { resolveModalImage, type ModalSdk } from "../sandbox/providers/modal/index.js";
import { validBatchProvider, type SandboxedPdfBatchProvider } from "./sandboxed-pdf-batch.js";

export const EXTRACTOR_PLUGIN_API_VERSION = 1;
/** The extractor id a registered sandboxed PDF provider serves. */
export const VM_PDF_EXTRACTOR_ID = "vm-pdf";

/** One Markdown extraction in an isolated VM. Paths are absolute and distinct. */
export interface SandboxedPdfJob {
  input: string;
  output: string;
  /** Return embedded images beside the Markdown, from the same VM job. Bounds in pixels, 1..4096. */
  embeddedImages?: { minWidth: number; minHeight: number };
  /**
   * Return Doppler's images (`pdftomarkdown --images-dir`) from the same VM job: the provider writes the folder
   * (`manifest.json` plus `page-NNNN/(image|figure)-NNN.<format>` files, docs/extraction/doppler-figures.md) into `dir`,
   * which the host created empty, and reports `figures` on its result. Only when the provider declares `figures` and
   * DOCSLURP_DOPPLER_IMAGE_EXTRACT is on. `limits` are the host's caps for this document as Doppler flags
   * (`--images-max`, `--images-max-bytes`, `--images-max-file-bytes`, `--scan-max`, `--scan-max-bytes`,
   * `--images-doc-max-bytes`, `--images-batch-pages`, `--images-link-prefix`): a provider passes them so that Doppler's own
   * budgets stop it (a resumable `budget`/`doc_budget`) before the host would refuse the folder.
   */
  figures?: { dir: string; limits?: DopplerImageLimits };
}

/**
 * One figure resume (provider `figures.resume`), always for one range: a shard's pages, a gap's pages, or (for an unsharded
 * document) the whole document. Paths are host paths the provider stages into a fresh VM; the host reads nothing of the
 * source. The answer is a figure outcome like SandboxedPdfResult.figures (`extracted`, `partial` with optional `gaps`
 * inside the range, or `failed` with a telemetry-only reason), and the host validates `dir` exactly like a first pass's
 * folder (no figure file it already stores may come back different: `resume-rewrite`).
 *
 * Folder the provider writes into `dir` (created empty):
 * - a range (`pages` set): `shards/<first>-<last>/manifest.jsonl` (4-digit zero padding, the converter's own manifest for
 *   `--images-pages first-last`) and only the new files under `page-NNNN/`;
 * - a whole document (`pages` null): `manifest.jsonl` and only the new files under `page-NNNN/`.
 */
export interface FigureResumeJob {
  /** The document's PDF (the converter checks it against `sourceSha256` and refuses another). */
  input: string;
  sourceSha256: string;
  /**
   * The range's stored manifest (the resume folder holds only it: `--images-resume` with a manifest-only folder), or null
   * for a gap (no manifest ever came back): a fresh figure pass over `pages` (`--images-pages first-last`).
   */
  manifest: string | null;
  /** The range (bound into the manifest's settings digest by `--images-pages`), or null for an unsharded document. */
  pages: [number, number] | null;
  /**
   * Narrow a resume inside the range (Doppler `--images-resume-pages A-B`, not part of the settings digest); null resumes
   * all of it. Always within `pages`; never set for a gap.
   */
  resumePages: [number, number] | null;
  /** Empty folder for the resumed images (layout above). */
  dir: string;
  /** The document's caps as Doppler flags (as for a first pass): a resume never exceeds them. */
  limits: DopplerImageLimits;
  /** Wall-time budget for the VM run; the guest should set `--images-deadline` a margin below it. */
  timeoutMs: number;
}

export interface SandboxedPdfRunContext {
  /** The host's page count for the document, or 0 when unknown. */
  pages: number;
  /** The calibrated shard profile for `shardProfile.key`, when the provider declared one. */
  profile?: () => Promise<ShardCostProfile>;
  /** Record one finished shard's timing in the caller's performance scope. */
  recordTiming(timing: { stage: string; executor: string; pages: number; ms: number; maxRssMiB?: number; shardIndex: number; shardCount: number }): void;
  /** Note progress for the stall watchdog. */
  onProgress(): void;
}

/** A content-addressed image asset; one asset may be drawn by several placements. */
export interface EmbeddedImageAsset {
  sha256: string;
  width: number;
  height: number;
  mediaType: EmbeddedImageMediaType;
  bytes: Buffer;
}

/** Validated images a producer returned for one document: assets plus one fact record per drawn occurrence. */
export interface EmbeddedImageSet {
  pageCount: number;
  first: number;
  last: number;
  minWidth: number;
  minHeight: number;
  encoding: MediaMap["encoding"];
  placementSource: MediaMap["placementSource"];
  assets: EmbeddedImageAsset[];
  placements: EmbeddedImageFacts[];
}

/** What a sandboxed PDF run returns: the command result, plus the pages the provider OCR'd, when it knows. */
export interface SandboxedPdfResult extends SandboxResult {
  /**
   * 1-based pages whose text the provider read with OCR (each is billed as a Rich read). Omit when unknown: an unknown
   * fact never raises a charge. Validated by the host: unique integers within the document's page count.
   */
  ocrPages?: number[];
  /**
   * Structural page layout from the same VM job (pdf-layout-facts@1, the open walker worker/scripts/pdf_layout_facts.py,
   * page numbers of the whole document). Untrusted: the host parses it with its bounded reader and drops pages outside the
   * document. Omit when unknown; missing or malformed facts never authorize a read.
   */
  layoutFacts?: unknown;
  /**
   * Required when the job asked for `figures`: `extracted` when the provider wrote the folder (the host still validates
   * all of it), `failed` when Doppler kept the Markdown but could not extract images (its exit status 5). `reason` is raw
   * diagnostic text for telemetry only; it never reaches a user or an API response.
   */
  figures?: ({ status: "extracted" } | { status: "partial" } | { status: "failed"; reason: string }) & {
    /** Doppler's report `images_confined`: whether its renderer confined itself in the VM. Omit when unknown. */
    confined?: boolean;
    /** Doppler's exit status and build (a version or commit), recorded on the document's extraction level. */
    exitCode?: number;
    build?: string;
    /**
     * Page ranges without images and why: at most 128, whole pages within the document, sorted, not overlapping; a reason
     * outside DOPPLER_FIGURE_GAP_REASONS is recorded as `other`. Malformed gaps make the whole answer a failure.
     */
    gaps?: Array<{ first: number; last: number; reason: string }>;
  };
}

/** Upper bound on a provider's Markdown output, checked before the host reads it. */
export const SANDBOXED_PDF_MAX_MARKDOWN_BYTES = 256 * 1024 * 1024;
/** Page bound for `ocrPages` when the host's page count is unknown. */
const MAX_REPORTED_PAGES = 100_000;

export interface SandboxedPdfExtractorProvider {
  /** Stable id for telemetry and command metrics, chosen by the plugin. */
  id: string;
  /** Largest source the provider accepts; larger files are refused before any VM work. */
  maxSourceBytes: number;
  /** Throw when the deployment is not ready (unpinned image, missing control credentials). Never fall back. */
  assertConfigured(): void;
  /** Write Markdown (pages joined by form feeds, one slot per page) to `job.output`. */
  run(job: SandboxedPdfJob, context: SandboxedPdfRunContext, signal?: AbortSignal): Promise<SandboxedPdfResult>;
  /** Upper bound on one run's wall time for this many pages: the remote command budget. */
  timeoutMs(pages: number): number;
  /** Present when the provider can return embedded images beside the Markdown. */
  embeddedImages?: {
    /** Artifact producer id and options digest recorded on every image artifact. */
    producerId: string;
    optionsDigest: string;
    /** Read and fully validate the images a run wrote for `output`. Throws on anything malformed. */
    read(output: string, signal?: AbortSignal): Promise<EmbeddedImageSet>;
  };
  /** Present when the provider can return Doppler figure crops beside the Markdown (SandboxedPdfJob.figures). */
  figures?: {
    producerId: string;
    /**
     * Finish the images a figure pass left resumable, in a fresh VM (`pdftomarkdown --images-resume` with the stored
     * manifest only: no figure file goes back into the VM). Optional: without it, resumable documents stay resumable.
     */
    resume?(job: FigureResumeJob, signal?: AbortSignal): Promise<unknown>;
  };
  /** Page-shard cost profile: calibration refines the prior from observed shard timings under `key`. */
  shardProfile?: { key: string; prior: ShardCostProfile };
  /**
   * Count a PDF's pages in a fresh VM (the guest's own pdfinfo), for documents whose count intake only estimated (the API never
   * parses PDFs). The worker records it before any stage uses the count or anything bills; without it a VM deployment refuses
   * such PDFs. `usage` is the VM's provider cost. A count the VM could not make throws an error carrying `pageCountOutcome`
   * (lib/pdf-page-count.ts PdfPageCountOutcome: open-failed, encrypted, limit, malformed, killed, unavailable), so a refused
   * document fails the same way in both modes.
   */
  pageCount?(job: { input: string }, signal?: AbortSignal): Promise<{ pages: number; usage?: UsageEvent }>;
  /**
   * Present when the provider can convert many PDFs of one run in one VM job, streaming each file's result as it is ready
   * (the first pass; extractors/sandboxed-pdf-batch.ts). The same isolation rules apply to every file of the batch.
   */
  batch?: SandboxedPdfBatchProvider;
}

/**
 * What orientation decided for one image. The provider decodes pixels; the host only reads this record, after
 * validating it against `orientationResultSchema` and checking `model` equals the provider's id.
 */
export type OrientationResult = OrientationResultRecord;

export interface ImageOrientationProvider {
  id: string;
  /** Conservative cost of one call in cents, admitted before it runs. */
  maxCostCents: number;
  /** Turn one image upright in isolation and write the PNG to `output`. Errors carry usage when compute was spent. */
  orient(input: string, output: string, signal?: AbortSignal): Promise<{ result: OrientationResult; usage?: UsageEvent }>;
}

/**
 * One OCR job in an isolated VM. The provider stages `input` (the stored customer file, never decoded on the host) into a
 * fresh VM, runs the fixed `docslurp_ocr.py` CLI there with exactly these settings, and copies back `output` (the CLI's
 * JSON result) and the PNGs it wrote into `imageDir`. Paths are absolute and distinct; `imageDir` exists and is empty.
 */
export interface SandboxedOcrJob {
  input: string;
  kind: "image" | "pdf";
  /** 1-based pages (PDF) or frames (multi-frame image) to read; absent reads every frame up to `maxFrames`. */
  pages?: number[];
  output: string;
  imageDir: string;
  /** Recogniser families to try, in order, while a frame's confidence stays below `retryBelow`. */
  recognisers: string[];
  maxAttempts: number;
  retryBelow: number;
  maxFrames: number;
  maxLongEdge: number;
  /** Frames to keep as PNG for an escalation read: below this confidence, or read by one of these recognisers. */
  escalation: { belowConfidence: number; recognisers: string[] } | null;
  /**
   * Write a bounded, normalized PNG rendition of every frame (`rendition-NNNN.png` in imageDir): the only pixels of an
   * uploaded image the worker ever decodes (visual indexing). Absent or null: none.
   */
  rendition?: { maxLongEdge: number; maxBytes: number } | null;
}

/** What a sandboxed OCR run returns: the command result. The host reads and validates `job.output` itself. */
export type SandboxedOcrResult = SandboxResult;

export interface SandboxedOcrProvider {
  /** Stable id for telemetry and ledger metadata, chosen by the plugin. */
  id: string;
  /** The provider's guest returns frame renditions (SandboxedOcrJob.rendition). Without it image uploads get no visual index. */
  renditions?: boolean;
  /** Largest source the provider accepts; larger files are refused before any VM work. */
  maxSourceBytes: number;
  /** Throw when the deployment is not ready (unpinned image, missing models or credentials). Never fall back. */
  assertConfigured(): void;
  /**
   * Run the job. When the CLI refused the job or its input (a usage, model or input refusal, an internal error, or the CLI
   * killed by its own resource limits), throw an error carrying `ocrRefused: true`: the page fails without a retry. Any
   * other throw (VM creation, capacity, a deadline, a dropped transfer) is treated as infrastructure and retried later.
   */
  run(job: SandboxedOcrJob, signal?: AbortSignal): Promise<SandboxedOcrResult>;
  /** Upper bound on one run's wall time for this many frames: the remote command budget. */
  timeoutMs(frames: number): number;
}

export interface ExtractorPlugin {
  apiVersion: typeof EXTRACTOR_PLUGIN_API_VERSION;
  name: string;
  sandboxedPdf?: SandboxedPdfExtractorProvider;
  imageOrientation?: ImageOrientationProvider;
  sandboxedOcr?: SandboxedOcrProvider;
}

/** Host values a plugin uses at runtime. Plugins import only types from the worker. */
export interface ExtractorPluginHost {
  apiVersion: typeof EXTRACTOR_PLUGIN_API_VERSION;
  SandboxRunError: typeof SandboxRunError;
  loadModalSdk(): Promise<ModalSdk>;
  resolveModalImage(ref: string): string;
  planPageShards: typeof planPageShards;
  currentPerfContext: typeof currentPerfContext;
  /**
   * What the worker's database says owns each document id (organization and run). Providers use it to refuse a batch
   * that names a document outside the job's scope, independently of core's own check. Rejects when the worker has no
   * database bound (setExtractorDocumentOwners): a provider must then refuse the batch, never skip the check.
   */
  documentOwners(documentIds: readonly string[]): Promise<ReadonlyMap<string, { orgId: string | null; runId: string }>>;
  /** The figure outcomes this core accepts: a provider reports `partial` (exit 5, folder kept) only when it is listed. */
  figureOutcomes: readonly ("extracted" | "partial" | "failed")[];
}

type DocumentOwnersLookup = ExtractorPluginHost["documentOwners"];
let documentOwnersLookup: DocumentOwnersLookup | undefined;

/** Bind the database lookup behind ExtractorPluginHost.documentOwners (worker startup; tests). */
export function setExtractorDocumentOwners(lookup: DocumentOwnersLookup | undefined): void {
  documentOwnersLookup = lookup;
}

export interface ExtractorPluginModule {
  register(host: ExtractorPluginHost): ExtractorPlugin | Promise<ExtractorPlugin>;
}

export function createExtractorPluginHost(): ExtractorPluginHost {
  return {
    apiVersion: EXTRACTOR_PLUGIN_API_VERSION,
    SandboxRunError,
    loadModalSdk: () => import("modal"),
    resolveModalImage: (ref) => resolveModalImage(ref, undefined),
    planPageShards,
    currentPerfContext,
    documentOwners: async (documentIds) => {
      if (!documentOwnersLookup) throw new SandboxRunError("Document ownership lookup is not bound in this worker");
      return await documentOwnersLookup(documentIds);
    },
    figureOutcomes: SANDBOXED_PDF_FIGURE_OUTCOMES,
  };
}

const plugins: ExtractorPlugin[] = [];
let loadedFrom: string | undefined;

const PROVIDER_ID = /^[a-z][a-z0-9-]{1,63}$/;

/** Register a plugin. Exactly one provider per capability; a second one is a configuration error. */
export function registerExtractorPlugin(plugin: ExtractorPlugin): void {
  if (!plugin || plugin.apiVersion !== EXTRACTOR_PLUGIN_API_VERSION) {
    throw new Error(`Extractor plugin API version mismatch: host ${EXTRACTOR_PLUGIN_API_VERSION}`);
  }
  if (!PROVIDER_ID.test(plugin.name ?? "")) throw new Error("Extractor plugin needs a lowercase name");
  const pdf = plugin.sandboxedPdf;
  if (pdf) {
    if (sandboxedPdfProvider()) throw new Error("Only one sandboxed PDF extractor provider may be registered");
    if (!PROVIDER_ID.test(pdf.id ?? "")) throw new Error("Sandboxed PDF provider needs a lowercase id");
    if (!Number.isSafeInteger(pdf.maxSourceBytes) || pdf.maxSourceBytes < 1) throw new Error("Sandboxed PDF provider needs maxSourceBytes");
    for (const name of ["assertConfigured", "run", "timeoutMs"] as const) {
      if (typeof pdf[name] !== "function") throw new Error(`Sandboxed PDF provider lacks ${name}()`);
    }
    if (pdf.embeddedImages && (typeof pdf.embeddedImages.read !== "function" || !PROVIDER_ID.test(pdf.embeddedImages.producerId ?? ""))) {
      throw new Error("Sandboxed PDF provider embeddedImages needs read() and a producerId");
    }
    if (pdf.figures && !PROVIDER_ID.test(pdf.figures.producerId ?? "")) throw new Error("Sandboxed PDF provider figures needs a producerId");
    if (pdf.batch !== undefined && !validBatchProvider(pdf.batch)) throw new Error("Sandboxed PDF provider batch needs run() and positive limits");
  }
  const orientation = plugin.imageOrientation;
  if (orientation) {
    if (imageOrientationProvider()) throw new Error("Only one image orientation provider may be registered");
    if (!PROVIDER_ID.test(orientation.id ?? "")) throw new Error("Image orientation provider needs a lowercase id");
    if (typeof orientation.orient !== "function" || !(orientation.maxCostCents >= 0)) throw new Error("Image orientation provider needs orient() and maxCostCents");
  }
  const ocr = plugin.sandboxedOcr;
  if (ocr) {
    if (sandboxedOcrProvider()) throw new Error("Only one sandboxed OCR provider may be registered");
    if (!PROVIDER_ID.test(ocr.id ?? "")) throw new Error("Sandboxed OCR provider needs a lowercase id");
    if (!Number.isSafeInteger(ocr.maxSourceBytes) || ocr.maxSourceBytes < 1) throw new Error("Sandboxed OCR provider needs maxSourceBytes");
    for (const name of ["assertConfigured", "run", "timeoutMs"] as const) {
      if (typeof ocr[name] !== "function") throw new Error(`Sandboxed OCR provider lacks ${name}()`);
    }
  }
  plugins.push(plugin);
  if (pdf?.shardProfile) registerShardProfile(pdf.shardProfile.key, pdf.shardProfile.prior);
}

export function sandboxedPdfProvider(): SandboxedPdfExtractorProvider | null {
  return plugins.find((plugin) => plugin.sandboxedPdf)?.sandboxedPdf ?? null;
}

/** The provider, or a refusal: the VM route never falls back to host parsing. */
export function requireSandboxedPdfProvider(): SandboxedPdfExtractorProvider {
  const provider = sandboxedPdfProvider();
  if (!provider) throw new Error(`The ${VM_PDF_EXTRACTOR_ID} extractor needs a sandboxed PDF provider plugin (DOCSLURP_EXTRACTOR_PLUGINS); refusing local fallback`);
  return provider;
}

const reportedOcrPages = new WeakMap<SandboxedPdfJob, number[]>();
const reportedLayoutFacts = new WeakMap<SandboxedPdfJob, Map<number, PageLayoutFacts>>();
const reportedFigures = new WeakMap<SandboxedPdfJob, SandboxedPdfFigureOutcome>();

/**
 * What a figure request came back as. `extracted`: every image the run linked was written (Doppler exit 0). `partial`:
 * Doppler wrote the Markdown and some images, kept the folder and says per image why the rest are missing (exit 5 with
 * manifest version 2). `failed`: no folder to trust (exit 6, or version 1's exit 5). `reason` is telemetry only (bounded,
 * control characters removed); `exitCode` and `build` (the Doppler version or commit) are recorded when the provider says.
 */
export type SandboxedPdfFigureOutcome = ({ status: "extracted" } | { status: "partial" } | { status: "failed"; reason: string }) & {
  confined?: boolean;
  exitCode?: number;
  build?: string;
  /** Page ranges the provider did not extract images for, and why (DopplerFigureGap). */
  gaps?: DopplerFigureGap[];
};
const MAX_FIGURE_REASON_CHARS = 500;

/** The figure outcomes this core accepts (ExtractorPluginHost.figureOutcomes): a plugin may report `partial` only when listed. */
export const SANDBOXED_PDF_FIGURE_OUTCOMES = ["extracted", "partial", "failed"] as const;

/**
 * Parse a provider's `gaps`: at most DOPPLER_FIGURE_GAPS_MAX ranges of whole pages within the document, first <= last,
 * sorted and not overlapping; a reason outside the closed set becomes `other`. Anything else is null (the outcome is refused).
 */
export function parseDopplerFigureGaps(raw: unknown, pageCount: number): DopplerFigureGap[] | null {
  if (!Array.isArray(raw) || raw.length > DOPPLER_FIGURE_GAPS_MAX) return null;
  const maxPage = Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : 1_000_000_000;
  const gaps: DopplerFigureGap[] = [];
  let previous = 0;
  for (const item of raw) {
    const gap = item as { first?: unknown; last?: unknown; reason?: unknown } | null;
    if (!gap || typeof gap !== "object") return null;
    const { first, last } = gap;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
    if ((first as number) < 1 || (first as number) > (last as number) || (last as number) > maxPage || (first as number) <= previous) return null;
    previous = last as number;
    const reason = typeof gap.reason === "string" && (DOPPLER_FIGURE_GAP_REASONS as readonly string[]).includes(gap.reason)
      ? gap.reason as DopplerFigureGap["reason"] : "other";
    gaps.push({ first: first as number, last: last as number, reason });
  }
  return gaps;
}

/** Parse a provider's figure outcome (untrusted). Anything that is not a recognised answer is a failure. */
export function parseSandboxedPdfFigureOutcome(raw: unknown, maxReasonChars = MAX_FIGURE_REASON_CHARS, pageCount = 0): SandboxedPdfFigureOutcome {
  const value = raw as { status?: unknown; reason?: unknown; confined?: unknown; exitCode?: unknown; build?: unknown; gaps?: unknown } | undefined;
  let gaps: DopplerFigureGap[] | null = null;
  if (value?.gaps !== undefined) {
    gaps = parseDopplerFigureGaps(value.gaps, pageCount);
    // Malformed gaps (too many, outside the document, out of order, overlapping): nothing of the answer is trusted.
    if (!gaps) return { status: "failed", reason: "provider-reported-invalid-gaps" };
  }
  const extra = {
    ...(gaps && gaps.length > 0 ? { gaps } : {}),
    ...(typeof value?.confined === "boolean" ? { confined: value.confined } : {}),
    ...(Number.isSafeInteger(value?.exitCode) && (value!.exitCode as number) >= 0 && (value!.exitCode as number) <= 255 ? { exitCode: value!.exitCode as number } : {}),
    ...(typeof value?.build === "string" && DOPPLER_BUILD.test(value.build) ? { build: value.build } : {}),
  };
  if (value?.status === "extracted") return { status: "extracted", ...extra };
  if (value?.status === "partial") return { status: "partial", ...extra };
  if (value?.status === "failed") {
    // eslint-disable-next-line no-control-regex
    const reason = typeof value.reason === "string" ? value.reason.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, maxReasonChars) : "";
    return { status: "failed", reason: reason || "unspecified", ...extra };
  }
  // A provider that was asked and did not answer extracted nothing the host may trust.
  return { status: "failed", reason: "provider-reported-no-figure-outcome" };
}

/**
 * Jobs whose figure answer is the first pass's placeholder (pipeline/first-pass.ts serveFirstPassResult): the first pass
 * stores that document's figures and ledger itself. A host-only mark on the job object, never anything the provider sends.
 */
const firstPassServedJobs = new WeakSet<SandboxedPdfJob>();
export function markFirstPassServedFigures(job: SandboxedPdfJob): void {
  firstPassServedJobs.add(job);
}
export function firstPassServedFigures(job: SandboxedPdfJob | undefined): boolean {
  return !!job && firstPassServedJobs.has(job);
}

function figureOutcome(job: SandboxedPdfJob, raw: unknown, pages: number): SandboxedPdfFigureOutcome | undefined {
  if (!job.figures) {
    if (raw !== undefined) throw new SandboxRunError("Sandboxed PDF provider returned unrequested figures");
    return undefined;
  }
  return parseSandboxedPdfFigureOutcome(raw, MAX_FIGURE_REASON_CHARS, pages);
}

/**
 * Validate a provider run's `ocrPages` against the page count and keep them for the job. A malformed list refuses the
 * run: provider output is untrusted, and billing evidence must not be guessed from it.
 */
export function acceptSandboxedPdfResult(job: SandboxedPdfJob, result: SandboxedPdfResult, pages: number): SandboxedPdfResult {
  reportedOcrPages.delete(job);
  reportedLayoutFacts.delete(job);
  reportedFigures.delete(job);
  const figures = figureOutcome(job, result.figures, pages);
  if (figures) reportedFigures.set(job, figures);
  if (result.figures !== undefined) result = { ...result, figures: undefined };
  if (result.layoutFacts !== undefined) {
    // Routing evidence, not billing evidence: a malformed payload is dropped (routing then has no layout facts), never repaired.
    const layout = parsePageLayoutFacts(result.layoutFacts, Number.isSafeInteger(pages) && pages > 0 ? pages : MAX_REPORTED_PAGES);
    if (layout.size > 0) reportedLayoutFacts.set(job, layout);
    else console.warn("[vm-pdf] layout facts unusable; routing continues without them");
    result = { ...result, layoutFacts: undefined };
  }
  const raw: unknown = result.ocrPages;
  if (raw === undefined) return result;
  const bound = Number.isSafeInteger(pages) && pages > 0 ? pages : MAX_REPORTED_PAGES;
  if (!Array.isArray(raw) || raw.length > bound ||
      raw.some((page) => !Number.isSafeInteger(page) || page < 1 || page > bound) || new Set(raw).size !== raw.length) {
    throw new SandboxRunError(`Sandboxed PDF provider returned invalid ocrPages (expected unique pages 1..${bound})`, result.usage);
  }
  const ocrPages = [...(raw as number[])].sort((a, b) => a - b);
  reportedOcrPages.set(job, ocrPages);
  return { ...result, ocrPages };
}

/** The validated layout facts a finished job returned, or undefined when it returned none usable. */
export function sandboxedPdfLayoutFacts(job: SandboxedPdfJob): Map<number, PageLayoutFacts> | undefined {
  return reportedLayoutFacts.get(job);
}

/** The figure outcome of a finished job that asked for figures, or undefined when it did not ask. */
export function sandboxedPdfFigures(job: SandboxedPdfJob): SandboxedPdfFigureOutcome | undefined {
  return reportedFigures.get(job);
}

/** The validated pages a finished job reported it OCR'd, or undefined when the provider did not say. */
export function sandboxedPdfOcrPages(job: SandboxedPdfJob): number[] | undefined {
  return reportedOcrPages.get(job);
}

export function imageOrientationProvider(): ImageOrientationProvider | null {
  return plugins.find((plugin) => plugin.imageOrientation)?.imageOrientation ?? null;
}

export function sandboxedOcrProvider(): SandboxedOcrProvider | null {
  return plugins.find((plugin) => plugin.sandboxedOcr)?.sandboxedOcr ?? null;
}

/** The provider, or a refusal: VM OCR never falls back to the worker host or to another reader. */
export function requireSandboxedOcrProvider(): SandboxedOcrProvider {
  const provider = sandboxedOcrProvider();
  if (!provider) throw new Error("DOCSLURP_OCR_MODE=vm needs a sandboxed OCR provider plugin (DOCSLURP_EXTRACTOR_PLUGINS); refusing local fallback");
  return provider;
}

/** The generic ids of the capabilities registered plugins provide (`vm-pdf`, `image-orientation`, `vm-ocr`). */
export function loadedPluginCapabilities(): string[] {
  return [
    ...(sandboxedPdfProvider() ? [VM_PDF_EXTRACTOR_ID] : []),
    ...(imageOrientationProvider() ? ["image-orientation"] : []),
    ...(sandboxedOcrProvider() ? ["vm-ocr"] : []),
  ];
}

export function registeredExtractorPlugins(): readonly string[] {
  return plugins.map((plugin) => plugin.name);
}

/** The modules DOCSLURP_EXTRACTOR_PLUGINS names, as absolute file URLs. */
export function extractorPluginSpecifiers(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.DOCSLURP_EXTRACTOR_PLUGINS?.trim() ?? "";
  if (!raw) return [];
  return raw.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    if (item.startsWith("file:")) return new URL(item).href;
    if (!path.isAbsolute(item)) throw new Error(`DOCSLURP_EXTRACTOR_PLUGINS entries must be absolute paths: ${item}`);
    return pathToFileURL(item).href;
  });
}

/**
 * Load the configured plugins once per process, then check the configuration asks for nothing missing. Throws on any
 * failure: a worker that was told to use a plugin must not start without it.
 */
export async function loadExtractorPlugins(
  env: NodeJS.ProcessEnv = process.env,
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<readonly string[]> {
  const specifiers = extractorPluginSpecifiers(env);
  const key = specifiers.join(",");
  if (loadedFrom !== undefined) {
    if (loadedFrom !== key) throw new Error("Extractor plugins are already loaded from a different DOCSLURP_EXTRACTOR_PLUGINS");
    return registeredExtractorPlugins();
  }
  const host = createExtractorPluginHost();
  for (const specifier of specifiers) {
    let module: Partial<ExtractorPluginModule>;
    try {
      module = (await importModule(specifier)) as Partial<ExtractorPluginModule>;
    } catch (error) {
      throw new Error(`Extractor plugin failed to load: ${specifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof module.register !== "function") throw new Error(`Extractor plugin exports no register(host): ${specifier}`);
    registerExtractorPlugin(await module.register(host));
  }
  loadedFrom = key;
  assertExtractorPluginConfiguration(env);
  // Generic capability ids only: plugin names and details are the plugin's own to log.
  const capabilities = loadedPluginCapabilities();
  if (capabilities.length) console.log(`[extractor-plugins] loaded api=${EXTRACTOR_PLUGIN_API_VERSION} providers=${capabilities.join(",")}`);
  return registeredExtractorPlugins();
}

/**
 * Refuse to start on a misconfigured deployment. PDFs are Doppler's, in a VM or (customer-owned only) on this host:
 *  - an unknown DOCSLURP_PDF_EXTRACTOR, DOCSLURP_PDF_MODE or DOCSLURP_VM_PDF_INSTALLED;
 *  - a VM selection (or the service profile) without a sandboxed PDF provider;
 *  - a provider loaded without the VM selection (PDFs would otherwise not run in it);
 *  - DOCSLURP_PDF_MODE=local beside a VM selection or a loaded provider, or outside DOCSLURP_SERVICE_PROFILE=self-hosted, or
 *    without Doppler's pdftomarkdown installed;
 *  - DOCSLURP_DOPPLER_IMAGE_EXTRACT on without the VM route and a provider that returns figures.
 * With neither a VM nor local mode the worker starts (other formats still run) and says loudly that PDFs are refused.
 */
export function assertExtractorPluginConfiguration(env: NodeJS.ProcessEnv = process.env, deps: { dopplerInstalled?: () => boolean } = {}): void {
  const sandboxed = sandboxedPdfConfigured(env);
  const local = localPdfModeRequested(env);
  if (sandboxed && !sandboxedPdfProvider()) {
    throw new Error(`DOCSLURP_PDF_MODE=vm, DOCSLURP_PDF_EXTRACTOR=${VM_PDF_EXTRACTOR_ID}, DOCSLURP_VM_PDF_INSTALLED=1 or DOCSLURP_SERVICE_PROFILE=service needs a sandboxed PDF provider in DOCSLURP_EXTRACTOR_PLUGINS; refusing to start rather than parse PDFs on the worker host`);
  }
  // A loaded VM PDF provider means this deployment reads PDFs in VMs; the selection must be explicit.
  if (!sandboxed && sandboxedPdfProvider()) {
    throw new Error(`a sandboxed PDF provider is loaded but ${VM_PDF_EXTRACTOR_ID} is not selected; set DOCSLURP_PDF_MODE=vm (or DOCSLURP_PDF_EXTRACTOR=${VM_PDF_EXTRACTOR_ID}) rather than let PDFs fall back to the worker host; refusing to start`);
  }
  if (local) {
    if (sandboxed) throw new Error(`DOCSLURP_PDF_MODE=local parses PDFs on the worker host, and this deployment runs PDFs only in ${VM_PDF_EXTRACTOR_ID}; unset it`);
    if (env.DOCSLURP_SERVICE_PROFILE?.trim().toLowerCase() !== "self-hosted") {
      throw new Error("DOCSLURP_PDF_MODE=local parses customer PDFs on the worker host and is only for customer-owned execution: it needs DOCSLURP_SERVICE_PROFILE=self-hosted; refusing to start");
    }
    if (!(deps.dopplerInstalled ?? (() => dopplerConverterInstalled(env)))()) {
      throw new Error(`DOCSLURP_PDF_MODE=local needs Doppler's pdftomarkdown and pdfpagecount at ${dopplerBinDir(env)}, and prlimit on PATH (worker images ship them; DOCSLURP_DOPPLER_BIN_DIR points elsewhere); refusing to start`);
    }
    console.warn("[pdf] mode=local: Doppler (doppler-md) parses customer PDFs on the worker host, in the parser sandbox, not a VM (customer-owned execution)");
  }
  // Figure extraction is a VM feature: Doppler crops figures only inside the PDF VM, never on this host.
  if (dopplerImageExtractEnabled(env)) {
    if (!sandboxed || !sandboxedPdfProvider()?.figures) {
      throw new Error(`${DOPPLER_IMAGE_EXTRACT_ENV}=1 needs the ${VM_PDF_EXTRACTOR_ID} PDF route with a provider that returns Doppler figures; refusing to start`);
    }
    console.log(`[pdf] doppler figures on (${DOPPLER_IMAGE_EXTRACT_ENV}=1)`);
  }
  const mode = resolvePdfMode(env);
  if (mode === "off") console.error(`[pdf] mode=off: ${PDF_EXTRACTION_UNCONFIGURED}; PDFs will be refused`);
  else if (mode === "vm") console.log(`[pdf] mode=vm extractor=${VM_PDF_EXTRACTOR_ID}`);
}

/** Local mode's PDF tools: the converter, the structural page counter, and prlimit (the counter's external memory limit). */
function dopplerConverterInstalled(env: NodeJS.ProcessEnv): boolean {
  try {
    accessSync(dopplerConverterPath(env), fsConstants.X_OK);
    accessSync(path.join(dopplerBinDir(env), "pdfpagecount"), fsConstants.X_OK);
    if (!(env.PATH ?? "").split(path.delimiter).some((dir) => { try { accessSync(path.join(dir, "prlimit"), fsConstants.X_OK); return true; } catch { return false; } })) return false;
    return true;
  } catch {
    return false;
  }
}

/** Test hook. */
export function resetExtractorPluginsForTest(): void {
  plugins.length = 0;
  loadedFrom = undefined;
}
