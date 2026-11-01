import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import { DIGITAL_IMAGE_TARGETS, dopplerExtractorOptionsSchema, type DocumentExtractionConfig, type ExtractionArtifactRef } from "@docslurp/shared";
import { decodeImageBundle, MAX_IMAGE_WIRE } from "../sandbox/providers/modal/doppler-images.js";
import type { LocalPdfGraphOutput } from "./local-graph-runner.js";

export const DOPPLER_IMAGE_TARGETS = new Set<string>(DIGITAL_IMAGE_TARGETS);
export function wantsDopplerImages(targets: readonly string[]): boolean { return targets.some(t => DOPPLER_IMAGE_TARGETS.has(t)); }

/** Resolve explicit public options before any VM work, and refuse weaker/non-PDF routes. */
export function resolveDopplerImages(config: DocumentExtractionConfig, format: string, order: readonly string[]): { minWidth: number; minHeight: number } | null {
  const options = config.options?.doppler === undefined ? undefined : dopplerExtractorOptionsSchema.parse(config.options.doppler);
  const enabled = wantsDopplerImages(config.enrich) || options?.images?.enabled || options?.pdf?.extractImages;
  if (!enabled || (format !== "pdf" && !wantsDopplerImages(config.enrich))) return null;
  if (format !== "pdf" || order.length === 0 || order.some(id => id !== "doppler") ||
      (config.voting.enabled && !["next-in-order", "doppler"].includes(config.voting.secondary))) {
    throw new Error("Embedded image extraction requires a Doppler-only PDF route");
  }
  if (config.enrich.some(t => !DOPPLER_IMAGE_TARGETS.has(t))) throw new Error("Doppler images cannot be combined with non-image enrichment targets");
  if (!config.enrich.length) config.enrich = ["document/media-map"];
  return { minWidth: options?.images?.minWidth ?? 1, minHeight: options?.images?.minHeight ?? 1 };
}

/** Materialise validated VM bytes; never run a PDF or image parser in the worker. */
export async function dopplerImageGraph(args: {
  bundlePath: string; sourcePath: string; sourceDocumentId: string; sourceHash: string;
  pageCount: number; targets: string[]; scratchDir: string; signal?: AbortSignal;
}): Promise<LocalPdfGraphOutput> {
  if (!args.targets.length || args.targets.some(t => !DOPPLER_IMAGE_TARGETS.has(t))) throw new Error("Doppler image enrichment supports image targets only");
  args.signal?.throwIfAborted();
  const file = await open(args.bundlePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let wire: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_WIRE) throw new Error("Invalid Doppler image sidecar");
    wire = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < wire.length) {
      const { bytesRead } = await file.read(wire, total, wire.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== info.size) throw new Error("Doppler image sidecar changed");
    wire = wire.subarray(0, total);
  } finally { await file.close(); }
  const { markdown, images } = decodeImageBundle(wire);
  if (markdown.length || images.first !== 1 || images.last !== args.pageCount || images.pageCount !== args.pageCount) throw new Error("Doppler image page count mismatch");
  const source: ExtractionArtifactRef = { id: `${args.sourceDocumentId}:source:${args.sourceHash.slice(0,16)}`, kind: "source/pdf", uri: args.sourcePath,
    mediaType: "application/pdf", sha256: args.sourceHash, sourceDocumentId: args.sourceDocumentId, derivedFrom: [], placements: [],
    producer: { id: "source", optionsDigest: args.sourceHash } };
  const artifacts: ExtractionArtifactRef[] = [source];
  const imageIds = new Map<string, string>();
  const digest = createHash("sha256").update("doppler-images@1:lossless-webp:page-only").digest("hex");
  const emit = async (kind: string, name: string, bytes: Buffer, mediaType: string, pages: number[]): Promise<ExtractionArtifactRef> => {
    args.signal?.throwIfAborted();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const uri = path.join(args.scratchDir, name);
    await writeFile(uri, bytes, { flag: "wx", mode: 0o600 });
    const ref: ExtractionArtifactRef = { id: `${args.sourceDocumentId}:${name}`, kind, uri, mediaType, sha256,
      sourceDocumentId: args.sourceDocumentId, derivedFrom: [source.id], placements: pages.map(pageNumber => ({ pageNumber, fidelity: "page-only" })),
      producer: { id: "doppler-embedded-images", optionsDigest: digest } };
    artifacts.push(ref); return ref;
  };
  for (const asset of images.assets) {
    const placements = images.placements.filter(p => p.sha256 === asset.sha256);
    const onlyMasks = placements.every(p => p.role === "mask" || p.role === "smask");
    const ref = await emit(onlyMasks ? "page/embedded-image-mask" : "page/embedded-image", `${asset.sha256}.webp`, asset.bytes, asset.mediaType,
      placements.map(p => p.pageNumber));
    imageIds.set(asset.sha256, ref.id);
  }
  const entries = images.placements.map(p => ({ pageNumber: p.pageNumber, occurrence: p.occurrence, role: p.role,
    artifactId: imageIds.get(p.sha256)!, sha256: p.sha256, mediaType: "image/webp", placement: "page-only", width: p.width, height: p.height,
    ...(p.maskOf === undefined ? {} : { maskOf: { pageNumber: p.pageNumber, occurrence: p.maskOf } }) }));
  if (args.targets.includes("page/embedded-image-set")) {
    if (images.pageCount > 10_000) throw new Error("Doppler page image set limit exceeded");
    for (let page = 1; page <= images.pageCount; page++) {
      await emit("page/embedded-image-set", `page-${page}.json`, Buffer.from(JSON.stringify({ pageNumber: page, images: entries.filter(p => p.pageNumber === page) })), "application/json", [page]);
    }
  }
  // A media map always accompanies assets, including an empty inventory and explicit page count.
  await emit("document/media-map", "media-map.json", Buffer.from(JSON.stringify({ pageCount: images.pageCount, placement: "page-only",
    encoding: "lossless-webp", minWidth: images.minWidth ?? 1, minHeight: images.minHeight ?? 1, masks: "separate-linked-assets", images: entries })), "application/json", []);
  return { artifacts, targets: artifacts.filter(a => args.targets.includes(a.kind)), steps: ["doppler-embedded-images"] };
}
