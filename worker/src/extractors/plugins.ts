/*
 * Extractor plugins: optional providers a deployment loads by configuration, never by import.
 *
 * DocSlurp ships an open default for everything here. A deployment may add one sandboxed PDF extractor (served as the
 * `vm-pdf` extractor id) and one image orientation provider by naming plugin modules in DOCSLURP_EXTRACTOR_PLUGINS
 * (comma-separated absolute paths or file: URLs). Each module exports `register(host)`, which returns the plugin.
 *
 * Rules the host enforces:
 * - Fail closed. A named plugin that cannot load is a startup error, and a deployment that asks for the VM extractor
 *   (DOCSLURP_PDF_EXTRACTOR=vm-pdf or DOCSLURP_VM_PDF_INSTALLED=1) without a provider is a startup error. The VM route
 *   never falls back to parsing on the worker host.
 * - A sandboxed PDF provider must isolate every job in a fresh VM or microVM. The worker holds secrets; providers
 *   receive file paths, not credentials, and return only bounded, validated output.
 * - Plugins get host classes through `host`, so errors and usage they raise are the worker's own types.
 *
 * Contract details: docs/extraction/extractor-plugins.md.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { sandboxedPdfConfigured, type EmbeddedImageFacts, type EmbeddedImageMediaType, type MediaMap } from "@docslurp/shared";

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

export interface SandboxedPdfExtractorProvider {
  /** Stable id for telemetry and command metrics, chosen by the plugin. */
  id: string;
  /** Largest source the provider accepts; larger files are refused before any VM work. */
  maxSourceBytes: number;
  /** Throw when the deployment is not ready (unpinned image, missing control credentials). Never fall back. */
  assertConfigured(): void;
  /** Write Markdown (pages joined by form feeds, one slot per page) to `job.output`. */
  run(job: SandboxedPdfJob, context: SandboxedPdfRunContext, signal?: AbortSignal): Promise<SandboxResult>;
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

/** What orientation decided for one image. The provider decodes pixels; the host only reads this record. */
export interface OrientationResult {
  model: string;
  modelSha256: string;
  status: "upright" | "uncertain" | "corrected";
  inputClockwiseDegrees: number;
  correctionClockwiseDegrees: number;
  confidence: number;
  margin: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  exifOrientation: number;
  exifApplied: boolean;
  mimeType: "image/png";
}

export interface ImageOrientationProvider {
  id: string;
  /** Conservative cost of one call in cents, admitted before it runs. */
  maxCostCents: number;
  /** Turn one image upright in isolation and write the PNG to `output`. Errors carry usage when compute was spent. */
  orient(input: string, output: string, signal?: AbortSignal): Promise<{ result: OrientationResult; usage?: UsageEvent }>;
}

export interface ExtractorPlugin {
  apiVersion: typeof EXTRACTOR_PLUGIN_API_VERSION;
  name: string;
  sandboxedPdf?: SandboxedPdfExtractorProvider;
  imageOrientation?: ImageOrientationProvider;
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
    if (typeof orientation.orient !== "function" || !(orientation.maxCostCents >= 0)) throw new Error("Image orientation provider needs orient() and maxCostCents");
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

export function imageOrientationProvider(): ImageOrientationProvider | null {
  return plugins.find((plugin) => plugin.imageOrientation)?.imageOrientation ?? null;
}

/** The generic ids of the capabilities registered plugins provide (`vm-pdf`, `image-orientation`). */
export function loadedPluginCapabilities(): string[] {
  return [
    ...(sandboxedPdfProvider() ? [VM_PDF_EXTRACTOR_ID] : []),
    ...(imageOrientationProvider() ? ["image-orientation"] : []),
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
 * Refuse to start on a misconfigured deployment: an unknown DOCSLURP_PDF_EXTRACTOR (which would otherwise fall through
 * to host parsing) or a VM selection without a provider.
 */
export function assertExtractorPluginConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (sandboxedPdfConfigured(env) && !sandboxedPdfProvider()) {
    throw new Error(`DOCSLURP_PDF_EXTRACTOR=${VM_PDF_EXTRACTOR_ID} or DOCSLURP_VM_PDF_INSTALLED=1 needs a sandboxed PDF provider in DOCSLURP_EXTRACTOR_PLUGINS`);
  }
}

/** Test hook. */
export function resetExtractorPluginsForTest(): void {
  plugins.length = 0;
  loadedFrom = undefined;
}
