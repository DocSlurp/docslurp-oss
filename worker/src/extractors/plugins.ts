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
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  dopplerHostPdfEnabled, sandboxedPdfConfigured, type EmbeddedImageFacts, type EmbeddedImageMediaType, type MediaMap, type OrientationResultRecord,
} from "@docslurp/shared";

import { SandboxRunError, type SandboxResult } from "../sandbox/types.js";
import type { UsageEvent } from "../models.js";
import { currentPerfContext } from "../lib/perf-context.js";
import { planPageShards, type ShardCostProfile } from "../temporal/page-shards.js";
import { registerShardProfile } from "../temporal/page-shard-profiles.js";
import { resolveModalImage, type ModalSdk } from "../sandbox/providers/modal/index.js";

export const EXTRACTOR_PLUGIN_API_VERSION = 1;
/** The extractor id a registered sandboxed PDF provider serves. */
export const VM_PDF_EXTRACTOR_ID = "vm-pdf";

/** One Markdown extraction in an isolated VM. Paths are absolute and distinct. */
export interface SandboxedPdfJob {
  input: string;
  output: string;
  /** Return embedded images beside the Markdown, from the same VM job. Bounds in pixels, 1..4096. */
  embeddedImages?: { minWidth: number; minHeight: number };
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
  /** Page-shard cost profile: calibration refines the prior from observed shard timings under `key`. */
  shardProfile?: { key: string; prior: ShardCostProfile };
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
}

/** What a sandboxed OCR run returns: the command result. The host reads and validates `job.output` itself. */
export type SandboxedOcrResult = SandboxResult;

export interface SandboxedOcrProvider {
  /** Stable id for telemetry and ledger metadata, chosen by the plugin. */
  id: string;
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

/**
 * Validate a provider run's `ocrPages` against the page count and keep them for the job. A malformed list refuses the
 * run: provider output is untrusted, and billing evidence must not be guessed from it.
 */
export function acceptSandboxedPdfResult(job: SandboxedPdfJob, result: SandboxedPdfResult, pages: number): SandboxedPdfResult {
  reportedOcrPages.delete(job);
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
 * Refuse to start on a misconfigured deployment: an unknown DOCSLURP_PDF_EXTRACTOR or DOCSLURP_DOPPLER_HOST_PDF (which
 * would otherwise fall through to host parsing), a VM selection without a provider (the service profile always selects
 * it), or Doppler host parsing asked for where PDFs run only in the VM.
 */
export function assertExtractorPluginConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const sandboxed = sandboxedPdfConfigured(env);
  const doppler = dopplerHostPdfEnabled(env);
  if (sandboxed && !sandboxedPdfProvider()) {
    throw new Error(`DOCSLURP_PDF_EXTRACTOR=${VM_PDF_EXTRACTOR_ID}, DOCSLURP_VM_PDF_INSTALLED=1 or DOCSLURP_SERVICE_PROFILE=service needs a sandboxed PDF provider in DOCSLURP_EXTRACTOR_PLUGINS; refusing to start rather than parse PDFs on the worker host`);
  }
  if (sandboxed && doppler) {
    throw new Error(`DOCSLURP_DOPPLER_HOST_PDF=1 parses PDFs on the worker host, and this deployment runs PDFs only in ${VM_PDF_EXTRACTOR_ID}; unset it`);
  }
  if (doppler) console.warn("[extractors] DOCSLURP_DOPPLER_HOST_PDF=1: doppler-md parses customer PDFs on the worker host (parser sandbox, no VM boundary)");
}

/** Test hook. */
export function resetExtractorPluginsForTest(): void {
  plugins.length = 0;
  loadedFrom = undefined;
}
