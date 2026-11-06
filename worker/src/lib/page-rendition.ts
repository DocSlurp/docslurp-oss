import type { Document } from "../models.js";
import { documentArtifactRoot } from "./artifact-root.js";

/**
 * An uploaded image's pages are never decoded in the worker process. The OCR boundary (a VM, or the customer-owned local
 * sandbox) writes a bounded, normalized rendition of each frame as raw 8-bit RGB behind a fixed header (worker/scripts/
 * docslurp_ocr.py write_rendition); the worker stores it here and page-image embedding builds its pixels from these bytes
 * with no image decoder (no PNG, ICC, EXIF or text chunks reach libspng, lcms2 or libexif). Caps: long edge (the embedder's
 * 1024 px input), pixels and size.
 */
export const PAGE_RENDITION = Object.freeze({ maxLongEdge: 1024, maxBytes: 4 * 1024 * 1024 });

/** The rendition header: magic, then width and height as u32 big-endian; RGB pixels follow, row-major, 3 bytes each. */
export const RENDITION_MAGIC = Buffer.from("DSRGB1\n\0", "latin1");
export const RENDITION_HEADER_BYTES = RENDITION_MAGIC.length + 8;

export interface RawRendition { width: number; height: number; pixels: Buffer }

/**
 * A rendition's dimensions and pixels, or null unless the bytes are exactly a header plus width x height x 3 pixel bytes,
 * within the long-edge, pixel and byte caps. Checked when the boundary returns it and again whenever it is read back.
 */
export function parseRawRendition(bytes: Uint8Array, cap: { maxLongEdge: number; maxBytes: number } = PAGE_RENDITION): RawRendition | null {
  if (bytes.length < RENDITION_HEADER_BYTES || bytes.length > cap.maxBytes) return null;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.subarray(0, RENDITION_MAGIC.length).equals(RENDITION_MAGIC)) return null;
  const width = buffer.readUInt32BE(RENDITION_MAGIC.length);
  const height = buffer.readUInt32BE(RENDITION_MAGIC.length + 4);
  if (width < 1 || height < 1 || Math.max(width, height) > cap.maxLongEdge || width * height > cap.maxLongEdge * cap.maxLongEdge) return null;
  if (buffer.length !== RENDITION_HEADER_BYTES + width * height * 3) return null;
  return { width, height, pixels: buffer.subarray(RENDITION_HEADER_BYTES) };
}

export function pageRenditionKey(document: Pick<Document, "id" | "userId" | "runId" | "artifactRoot">, pageNumber: number): string {
  return `${documentArtifactRoot(document)}/images/${document.id}/rendition/page-${pageNumber}.rgb`;
}
