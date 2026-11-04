/*
 * Embedded PDF images as artifacts: one content-addressed asset per distinct image, one media-map entry per drawn
 * occurrence, routed by the shared threshold table. Producer-neutral: a sandboxed PDF provider returns an
 * EmbeddedImageSet from its VM, and this module only validates and materialises it. Nothing here decodes pixels or
 * parses a PDF. The local `pdfimages` default builds the same media map in its graph (local-artifact-adapters.ts).
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DIGITAL_IMAGE_TARGETS, IMAGE_ROUTING, IMAGE_ROUTING_TABLE_VERSION, MEDIA_MAP_VERSION, embeddedImageFactsSchema, imageAnchorId,
  markdownBlocks, mediaMapSchema, parseImageAnchorLine, planImageRouting, routeCounts, vmPdfExtractorOptionsSchema,
  type ArtifactPlacement, type DocumentExtractionConfig, type EmbeddedImageFacts, type ExtractionArtifactRef, type MediaMap, type MediaMapImage,
} from "@docslurp/shared";

import { imageOrientationEnabled, normalizeImageOrientation } from "../lib/image-orientation.js";
import type { UsageEvent } from "../models.js";
import type { LocalPdfGraphOutput } from "./local-graph-runner.js";
import { VM_PDF_EXTRACTOR_ID, sandboxedPdfProvider, type EmbeddedImageSet } from "./plugins.js";

export const EMBEDDED_IMAGE_TARGETS = new Set<string>(DIGITAL_IMAGE_TARGETS);
export const MAX_EMBEDDED_IMAGES = 512;
export const MAX_EMBEDDED_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_EMBEDDED_IMAGE_TOTAL_BYTES = 24 * 1024 * 1024;

export function wantsEmbeddedImages(targets: readonly string[]): boolean {
  return targets.some((target) => EMBEDDED_IMAGE_TARGETS.has(target));
}

/**
 * Whether this run's images come from the sandboxed PDF provider, with its bounds. Resolved before any VM work.
 *
 * With no provider registered the local artifact graph serves image targets (null). With one registered, image
 * extraction requires the VM route alone: the deployment chose not to parse PDFs on the worker host, so a mixed route
 * or a provider without image support is refused rather than served locally.
 */
export function resolveEmbeddedImageRequest(
  config: DocumentExtractionConfig,
  format: string,
  order: readonly string[],
): { minWidth: number; minHeight: number } | null {
  const provider = sandboxedPdfProvider();
  if (!provider) return null;
  const raw = config.options?.[VM_PDF_EXTRACTOR_ID];
  const options = raw === undefined ? undefined : vmPdfExtractorOptionsSchema.parse(raw);
  const enabled = wantsEmbeddedImages(config.enrich) || options?.images?.enabled || options?.pdf?.extractImages;
  if (!enabled || (format !== "pdf" && !wantsEmbeddedImages(config.enrich))) return null;
  if (format !== "pdf" || order.length === 0 || order.some((id) => id !== VM_PDF_EXTRACTOR_ID) ||
      (config.voting.enabled && !["next-in-order", VM_PDF_EXTRACTOR_ID].includes(config.voting.secondary))) {
    throw new Error(`Embedded image extraction requires a ${VM_PDF_EXTRACTOR_ID}-only PDF route`);
  }
  if (!provider.embeddedImages) throw new Error("The sandboxed PDF provider does not return embedded images");
  if (config.enrich.some((target) => !EMBEDDED_IMAGE_TARGETS.has(target))) {
    throw new Error("Embedded images cannot be combined with non-image enrichment targets");
  }
  if (!config.enrich.length) config.enrich = ["document/media-map"];
  return { minWidth: options?.images?.minWidth ?? 1, minHeight: options?.images?.minHeight ?? 1 };
}

function extensionOf(mediaType: string): string {
  return mediaType === "image/png" ? "png" : "webp";
}

/** The stable ID of a document's image asset: shared by the media map and the Markdown references. */
export function embeddedImageArtifactId(sourceDocumentId: string, sha256: string, mediaType: string = "image/webp"): string {
  return `${sourceDocumentId}:${sha256}.${extensionOf(mediaType)}`;
}

/**
 * Check a provider's image set before anything uses it: every fact parses strictly, every placement names one asset,
 * assets are unique, hash to their bytes and stay within the size bounds, and the page range covers the document.
 */
export function validateEmbeddedImageSet(images: EmbeddedImageSet, pageCount: number): EmbeddedImageSet {
  if (images.first !== 1 || images.last !== pageCount || images.pageCount !== pageCount) throw new Error("Embedded image page count mismatch");
  if (images.placements.length > MAX_EMBEDDED_IMAGES || images.assets.length > MAX_EMBEDDED_IMAGES) throw new Error("Too many embedded images");
  const assets = new Map<string, EmbeddedImageSet["assets"][number]>();
  let total = 0;
  for (const asset of images.assets) {
    if (assets.has(asset.sha256)) throw new Error("Duplicate embedded image asset");
    if (!Buffer.isBuffer(asset.bytes) || asset.bytes.length > MAX_EMBEDDED_IMAGE_BYTES) throw new Error("Embedded image asset exceeds its limit");
    if (createHash("sha256").update(asset.bytes).digest("hex") !== asset.sha256) throw new Error("Embedded image asset hash mismatch");
    if (asset.mediaType !== "image/webp" && asset.mediaType !== "image/png") throw new Error("Unsupported embedded image media type");
    total += asset.bytes.length;
    assets.set(asset.sha256, asset);
  }
  if (total > MAX_EMBEDDED_IMAGE_TOTAL_BYTES) throw new Error("Embedded images exceed their total limit");
  const keys = new Set<string>();
  const placements = images.placements.map((raw) => {
    const fact = embeddedImageFactsSchema.parse(raw);
    const asset = assets.get(fact.sha256);
    if (!asset || asset.width !== fact.width || asset.height !== fact.height) throw new Error("Embedded image placement names no matching asset");
    if (fact.pageNumber > pageCount) throw new Error("Embedded image placement outside the document");
    const key = `${fact.pageNumber}:${fact.occurrence}`;
    if (keys.has(key)) throw new Error("Duplicate embedded image occurrence");
    keys.add(key);
    return fact;
  });
  for (const fact of placements) {
    if (fact.maskOf !== undefined && !keys.has(`${fact.pageNumber}:${fact.maskOf}`)) throw new Error("Embedded image mask names no image");
  }
  return { ...images, placements };
}

/** Which image references the final Markdown holds, by anchor, with the index of the block each precedes. */
export function markdownImageAnchors(markdown: string): Map<string, number> {
  const found = new Map<string, number>();
  markdown.split("\f").forEach((page) => {
    const lines = page.split("\n");
    let content = 0;
    for (const [start, end] of markdownBlocks(page)) {
      const anchor = start === end ? parseImageAnchorLine(lines[start]!) : null;
      if (anchor) found.set(anchor.anchor, content);
      else content += 1;
    }
  });
  return found;
}

/** Placements an artifact reference carries: the bounding box when the producer established one, else the page alone. */
function artifactPlacement(p: EmbeddedImageFacts): ArtifactPlacement {
  if (p.placement.status !== "known") return { pageNumber: p.pageNumber, fidelity: "page-only" };
  return { pageNumber: p.pageNumber, bbox: p.placement.bbox, coordinateSpace: "pdf-points", fidelity: p.placement.validatedBy === "sequence" ? "exact" : "approximate" };
}

/** Media-map entries for validated facts: class, route and whether the final Markdown references each occurrence. */
export function mediaMapEntries(
  placements: readonly EmbeddedImageFacts[],
  context: {
    pageCount: number; artifactId: (fact: EmbeddedImageFacts) => string; mediaType: (fact: EmbeddedImageFacts) => MediaMapImage["mediaType"];
    /** The final Markdown, when at hand. Without it, an image counts as included when its route puts it in Markdown
     * and `referencesInserted` says the producer's references went in; otherwise it is not in the Markdown. */
    markdown?: string | null;
    referencesInserted: boolean;
  },
): { entries: MediaMapImage[]; counts: Record<string, number>; routed: number } {
  const planned = planImageRouting(placements, { pageCount: context.pageCount });
  const inMarkdown = context.markdown == null ? null : markdownImageAnchors(context.markdown);
  const entries = placements.map((p, index): MediaMapImage => {
    const { classification, route, markdownIncluded } = planned[index]!;
    const anchor = imageAnchorId(p.pageNumber, p.occurrence);
    // When the final Markdown is at hand it is the truth: an image is "included" exactly when its reference is in it.
    const included = inMarkdown ? inMarkdown.has(anchor) : context.referencesInserted && markdownIncluded;
    return {
      pageNumber: p.pageNumber, occurrence: p.occurrence, role: p.role, artifactId: context.artifactId(p), sha256: p.sha256,
      mediaType: context.mediaType(p), width: p.width, height: p.height,
      ...(p.maskOf === undefined ? {} : { maskOf: { pageNumber: p.pageNumber, occurrence: p.maskOf } }),
      source: p.source, placement: p.placement, alt: p.alt, signals: p.signals, signalsUnavailable: p.signalsUnavailable,
      class: classification, route,
      markdown: { included, anchor, block: included ? (inMarkdown?.get(anchor) ?? p.anchor?.block ?? null) : null, method: included ? (p.anchor?.method ?? "page-end") : null },
    };
  });
  const counts = routeCounts(planned);
  return { entries, counts, routed: (counts.ocr ?? 0) + (counts.vision ?? 0) + (counts.label ?? 0) };
}

export function buildMediaMap(args: {
  pageCount: number; encoding: MediaMap["encoding"]; placementSource: MediaMap["placementSource"]; minWidth: number; minHeight: number;
  entries: MediaMapImage[]; counts: Record<string, number>; routed: number;
}): MediaMap {
  // Validated whole before it is written: a field the contract does not name cannot reach an artifact.
  return mediaMapSchema.parse({
    version: MEDIA_MAP_VERSION, pageCount: args.pageCount, encoding: args.encoding, minWidth: args.minWidth, minHeight: args.minHeight,
    masks: "separate-linked-assets", placementSource: args.placementSource, coordinateSpace: "pdf-points-top-left",
    routing: { table: IMAGE_ROUTING_TABLE_VERSION, routedImages: args.routed, cap: IMAGE_ROUTING.maxRoutedPerDocument, counts: args.counts },
    images: args.entries,
  });
}

/** Materialise a provider's validated image set as artifacts; never run a PDF or image parser in the worker. */
export async function embeddedImageGraph(args: {
  images: EmbeddedImageSet;
  producer: { id: string; optionsDigest: string };
  sourcePath: string; sourceDocumentId: string; sourceHash: string;
  pageCount: number; targets: string[]; scratchDir: string; signal?: AbortSignal;
  /** The final document Markdown (references already inserted): the map then reports what the Markdown actually holds. */
  markdownPath?: string;
  recordUsage?: (event: UsageEvent) => void;
  canContinue?: () => boolean;
  reserveOrientation?: () => boolean;
}): Promise<LocalPdfGraphOutput> {
  if (!args.targets.length || args.targets.some((t) => !EMBEDDED_IMAGE_TARGETS.has(t))) throw new Error("Embedded image enrichment supports image targets only");
  args.signal?.throwIfAborted();
  const images = validateEmbeddedImageSet(args.images, args.pageCount);
  const source: ExtractionArtifactRef = { id: `${args.sourceDocumentId}:source:${args.sourceHash.slice(0, 16)}`, kind: "source/pdf", uri: args.sourcePath,
    mediaType: "application/pdf", sha256: args.sourceHash, sourceDocumentId: args.sourceDocumentId, derivedFrom: [], placements: [],
    producer: { id: "source", optionsDigest: args.sourceHash } };
  const artifacts: ExtractionArtifactRef[] = [source];
  const imageIds = new Map<string, string>();
  const mediaTypes = new Map<string, MediaMapImage["mediaType"]>();
  const orientation = new Map<string, unknown>();
  const normalize = imageOrientationEnabled();
  if (normalize && !args.recordUsage) throw new Error("Image orientation requires scoped usage recording");
  const digest = createHash("sha256").update(`${args.producer.optionsDigest}:${IMAGE_ROUTING_TABLE_VERSION}`).digest("hex");
  // One decision per occurrence from the single threshold table; masks and skipped images are classified, never re-decided here.
  const planned = planImageRouting(images.placements, { pageCount: images.pageCount });
  const emit = async (kind: string, name: string, bytes: Buffer, mediaType: string, placements: ArtifactPlacement[]): Promise<ExtractionArtifactRef> => {
    args.signal?.throwIfAborted();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const uri = path.join(args.scratchDir, name);
    await writeFile(uri, bytes, { flag: "wx", mode: 0o600 });
    const ref: ExtractionArtifactRef = { id: `${args.sourceDocumentId}:${name}`, kind, uri, mediaType, sha256,
      sourceDocumentId: args.sourceDocumentId, derivedFrom: [source.id], placements,
      producer: { id: args.producer.id, optionsDigest: digest } };
    artifacts.push(ref);
    return ref;
  };
  for (const asset of images.assets) {
    const placements = images.placements.filter((p) => p.sha256 === asset.sha256);
    if (placements.length === 0) continue;
    const allSkipped = images.placements.every((p, i) => p.sha256 !== asset.sha256 || planned[i]!.route.action === "skip");
    const onlyMasks = placements.every((p) => p.role === "mask" || p.role === "smask");
    const ref = await emit(onlyMasks ? "page/embedded-image-mask" : "page/embedded-image", `${asset.sha256}.${extensionOf(asset.mediaType)}`, asset.bytes, asset.mediaType,
      placements.map(artifactPlacement));
    imageIds.set(asset.sha256, ref.id);
    mediaTypes.set(asset.sha256, asset.mediaType);
    // Mask pixels and their associated source must remain aligned; never turn one independently.
    const linkedMask = placements.some((p) => p.role !== "image" || images.placements.some((mask) => mask.pageNumber === p.pageNumber && mask.maskOf === p.occurrence));
    if (normalize && !linkedMask && allSkipped) orientation.set(asset.sha256, { status: "skipped-route" });
    else if (normalize && !linkedMask) {
      if (args.canContinue && !args.canContinue()) throw new Error("Image orientation refused: run cost cap exceeded");
      if (args.reserveOrientation && !args.reserveOrientation()) {
        orientation.set(asset.sha256, { status: "skipped-limit" });
        continue;
      }
      const prepared = await normalizeImageOrientation(ref.uri, args.recordUsage!, args.signal);
      try {
        if (prepared.metadata.status === "corrected" || prepared.metadata.exifApplied) {
          const bytes = await readFile(prepared.path);
          const derived = await emit("page/embedded-image", `${asset.sha256}.upright.png`, bytes, "image/png", placements.map(artifactPlacement));
          derived.derivedFrom = [ref.id];
          derived.producer = { id: prepared.metadata.model, optionsDigest: createHash("sha256")
            .update(JSON.stringify({ policy: "quarter-turn@1", ...prepared.metadata })).digest("hex") };
          orientation.set(asset.sha256, { ...prepared.metadata, artifactId: derived.id });
        } else orientation.set(asset.sha256, prepared.metadata);
      } finally { await prepared.release(); }
    } else if (normalize) orientation.set(asset.sha256, { status: "skipped-linked-mask" });
  }
  const markdown = args.markdownPath ? await readFile(args.markdownPath, "utf8") : null;
  const mapped = mediaMapEntries(images.placements, {
    pageCount: images.pageCount, markdown, referencesInserted: true,
    artifactId: (p) => imageIds.get(p.sha256)!, mediaType: (p) => mediaTypes.get(p.sha256)!,
  });
  const entries = mapped.entries.map((entry, index) => {
    const sha256 = images.placements[index]!.sha256;
    return orientation.has(sha256) ? { ...entry, orientation: orientation.get(sha256) } : entry;
  });
  if (args.targets.includes("page/embedded-image-set")) {
    if (images.pageCount > 10_000) throw new Error("Embedded page image set limit exceeded");
    for (let page = 1; page <= images.pageCount; page++) {
      await emit("page/embedded-image-set", `page-${page}.json`, Buffer.from(JSON.stringify({ pageNumber: page, images: entries.filter((p) => p.pageNumber === page) })), "application/json", [{ pageNumber: page, fidelity: "page-only" }]);
    }
  }
  // A media map always accompanies assets, including an empty inventory and explicit page count.
  const map = buildMediaMap({ pageCount: images.pageCount, encoding: images.encoding, placementSource: images.placementSource,
    minWidth: images.minWidth, minHeight: images.minHeight, entries, counts: mapped.counts, routed: mapped.routed });
  await emit("document/media-map", "media-map.json", Buffer.from(JSON.stringify(map)), "application/json", []);
  const stats = mediaMapStats(map, images.assets.length);
  console.log(`[embedded-images] document=${args.sourceDocumentId} producer=${args.producer.id} images=${stats.images} assets=${stats.assets} route=${Object.entries(stats.byRoute).map(([k, v]) => `${k}:${v}`).join(",") || "none"} class=${Object.entries(stats.byClass).map(([k, v]) => `${k}:${v}`).join(",") || "none"} placement=${stats.placementKnown}/${stats.images} signals=${stats.signalsAvailable}/${stats.images} markdown=${stats.inMarkdown}`);
  return { artifacts, targets: artifacts.filter((a) => args.targets.includes(a.kind)), steps: [args.producer.id], stats };
}

/** Per-run measurements recorded beside the graph: image counts by class and route, placement and Markdown coverage. */
export function mediaMapStats(map: MediaMap, assets: number): Record<string, unknown> & { images: number; assets: number; byClass: Record<string, number>; byRoute: Record<string, number>; placementKnown: number; signalsAvailable: number; inMarkdown: number } {
  const byClass: Record<string, number> = {};
  for (const e of map.images) byClass[e.class.label] = (byClass[e.class.label] ?? 0) + 1;
  return {
    images: map.images.length, assets, byClass, byRoute: { ...map.routing.counts } as Record<string, number>, routed: map.routing.routedImages, routedCap: map.routing.cap,
    placementKnown: map.images.filter((e) => e.placement.status === "known").length, placementUnknown: map.images.filter((e) => e.placement.status === "unknown").length,
    signalsAvailable: map.images.filter((e) => e.signals !== null).length, inMarkdown: map.images.filter((e) => e.markdown.included).length,
  };
}
