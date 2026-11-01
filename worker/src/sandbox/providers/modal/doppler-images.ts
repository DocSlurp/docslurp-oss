import { createHash } from "node:crypto";

/** Binary, uncompressed framing: no archive paths, extraction, or image decoding on the host. */
export const IMAGE_MAGIC = Buffer.from("DOPIMG1\n");
export const MAX_IMAGE_WIRE = 64 * 1024 * 1024;
export const MAX_IMAGE_HEADER = 256 * 1024;
export const MAX_IMAGE_COUNT = 512;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 24 * 1024 * 1024;
export type ImageRole = "image" | "mask" | "smask" | "stencil";
export interface EmbeddedAsset { sha256: string; width: number; height: number; mediaType: "image/webp"; bytes: Buffer }
export interface EmbeddedPlacement { pageNumber: number; occurrence: number; role: ImageRole; width: number; height: number; sha256: string; maskOf?: number }
export interface EmbeddedImages { minWidth?: number; minHeight?: number; pageCount: number; first: number; last: number; assets: EmbeddedAsset[]; placements: EmbeddedPlacement[] }
const integer = (n: unknown, min: number, max: number): n is number => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;
const refuse = (): never => { throw new Error("Invalid or oversized Doppler image bundle"); };

/** Fixed encoder's simple lossless container only; this does not decode image pixels. */
export function losslessWebpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 25 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 16) !== "WEBPVP8L" ||
      bytes.readUInt32LE(4) + 8 !== bytes.length || 20 + Math.ceil(bytes.readUInt32LE(16) / 2) * 2 !== bytes.length ||
      bytes[20] !== 0x2f || (bytes[24]! & 0xe0) !== 0) return null;
  const bits = bytes.readUInt32LE(21);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

/** Validate every offset, hash and placement before any artifacts can be published. */
export function decodeImageBundle(wire: Buffer): { markdown: Buffer; images: EmbeddedImages } {
  if (wire.length > MAX_IMAGE_WIRE || wire.length < 12 || !wire.subarray(0, 8).equals(IMAGE_MAGIC)) return refuse();
  const headerBytes = wire.readUInt32BE(8);
  if (!headerBytes || headerBytes > MAX_IMAGE_HEADER || 12 + headerBytes > wire.length) return refuse();
  let h: any;
  try { h = JSON.parse(wire.subarray(12, 12 + headerBytes).toString("utf8")); } catch { return refuse(); }
  if (!h || h.version !== "doppler-images@1" || !integer(h.pageCount, 1, 100_000) || !integer(h.first, 1, h.pageCount) ||
      !integer(h.last, h.first, h.pageCount) || !integer(h.markdownBytes, 0, MAX_IMAGE_WIRE) ||
      !Array.isArray(h.assets) || h.assets.length > MAX_IMAGE_COUNT || !Array.isArray(h.placements) || h.placements.length > MAX_IMAGE_COUNT) return refuse();
  const minWidth = h.minWidth ?? 1, minHeight = h.minHeight ?? 1;
  if (!integer(minWidth, 1, 4096) || !integer(minHeight, 1, 4096)) return refuse();
  let offset = 12 + headerBytes;
  if (offset + h.markdownBytes > wire.length) return refuse();
  const markdown = wire.subarray(offset, offset += h.markdownBytes);
  const assets: EmbeddedAsset[] = [];
  const byHash = new Map<string, EmbeddedAsset>();
  let bytesTotal = 0;
  for (const a of h.assets) {
    if (!a || typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256) || byHash.has(a.sha256) || a.mediaType !== "image/webp" ||
        !integer(a.width, 1, MAX_IMAGE_PIXELS) || !integer(a.height, 1, MAX_IMAGE_PIXELS) || a.width * a.height > MAX_IMAGE_PIXELS ||
        !integer(a.length, 25, MAX_IMAGE_BYTES) || offset + a.length > wire.length) return refuse();
    bytesTotal += a.length;
    if (bytesTotal > MAX_IMAGE_TOTAL_BYTES) return refuse();
    const bytes = wire.subarray(offset, offset += a.length);
    const dimensions = losslessWebpDimensions(bytes);
    if (!dimensions || dimensions.width !== a.width || dimensions.height !== a.height ||
        createHash("sha256").update(bytes).digest("hex") !== a.sha256) return refuse();
    const asset: EmbeddedAsset = { sha256: a.sha256, width: a.width, height: a.height, mediaType: "image/webp", bytes };
    assets.push(asset); byHash.set(a.sha256, asset);
  }
  if (offset !== wire.length) return refuse();
  const placements: EmbeddedPlacement[] = [];
  const used = new Set<string>();
  let pixels = 0, previousPage = 0, previousOccurrence = -1;
  for (const p of h.placements) {
    const asset = p && byHash.get(p.sha256);
    if (!asset || !integer(p.pageNumber, h.first, h.last) || !integer(p.occurrence, 0, MAX_IMAGE_COUNT - 1) ||
        !["image", "mask", "smask", "stencil"].includes(p.role) || p.width !== asset.width || p.height !== asset.height ||
        p.pageNumber < previousPage || (p.pageNumber === previousPage && p.occurrence <= previousOccurrence)) return refuse();
    const previous = placements.at(-1);
    if (p.role === "mask" || p.role === "smask") {
      if (!previous || previous.role !== "image" || previous.pageNumber !== p.pageNumber || p.maskOf !== previous.occurrence) return refuse();
    } else if (p.maskOf !== undefined || p.width < minWidth || p.height < minHeight) return refuse();
    pixels += p.width * p.height;
    if (pixels > MAX_IMAGE_PIXELS) return refuse();
    previousPage = p.pageNumber; previousOccurrence = p.occurrence; used.add(p.sha256);
    placements.push({ pageNumber: p.pageNumber, occurrence: p.occurrence, role: p.role, width: p.width, height: p.height,
      sha256: p.sha256, ...(p.maskOf === undefined ? {} : { maskOf: p.maskOf }) });
  }
  if (used.size !== assets.length) return refuse();
  return { markdown, images: { ...(h.minWidth === undefined ? {} : { minWidth }), ...(h.minHeight === undefined ? {} : { minHeight }), pageCount: h.pageCount, first: h.first, last: h.last, assets, placements } };
}

export function encodeImageBundle(images: EmbeddedImages, markdown = Buffer.alloc(0)): Buffer {
  const header = Buffer.from(JSON.stringify({ version: "doppler-images@1", pageCount: images.pageCount, first: images.first, last: images.last,
    minWidth: images.minWidth, minHeight: images.minHeight, markdownBytes: markdown.length, assets: images.assets.map(({ bytes, ...a }) => ({ ...a, length: bytes.length })), placements: images.placements }));
  const prefix = Buffer.alloc(12); IMAGE_MAGIC.copy(prefix); prefix.writeUInt32BE(header.length, 8);
  const size = 12 + header.length + markdown.length + images.assets.reduce((sum, a) => sum + a.bytes.length, 0);
  if (size > MAX_IMAGE_WIRE || header.length > MAX_IMAGE_HEADER) return refuse();
  const wire = Buffer.concat([prefix, header, markdown, ...images.assets.map(a => a.bytes)], size);
  decodeImageBundle(wire);
  return wire;
}

export function mergeImageBundles(parts: EmbeddedImages[], pages: number): EmbeddedImages {
  const assets = new Map<string, EmbeddedAsset>();
  const placements: EmbeddedPlacement[] = [];
  let next = 1;
  for (const part of parts) {
    if (part.pageCount !== pages || part.first !== next || (part.minWidth ?? 1) !== (parts[0]?.minWidth ?? 1) || (part.minHeight ?? 1) !== (parts[0]?.minHeight ?? 1)) return refuse();
    next = part.last + 1;
    for (const a of part.assets) assets.set(a.sha256, a);
    placements.push(...part.placements);
  }
  if (next !== pages + 1) return refuse();
  const result = { minWidth: parts[0]?.minWidth, minHeight: parts[0]?.minHeight, pageCount: pages, first: 1, last: pages, assets: [...assets.values()], placements };
  // The whole-document image budget applies even when each shard fitted independently.
  encodeImageBundle(result);
  return result;
}
