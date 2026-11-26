/** Bound pixel allocation before invoking either renderer, including oversized PDF media boxes. */
export function boundedRasterDpi(widthPt: number, heightPt: number, requestedDpi: number): number {
  if (![widthPt, heightPt, requestedDpi].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("Invalid PDF page dimensions");
  }
  // Leave a pixel of rounding headroom for engines which ceil each axis.
  return Math.min(requestedDpi, 4095 * 72 / Math.max(widthPt, heightPt),
    Math.sqrt(15_990_000 / (widthPt * heightPt)) * 72);
}

/**
 * `boundedRasterDpi`, further lowered so the page's longest edge renders at most `maxLongEdgePx` (a vision model's
 * training size). Computed from the page's measured point size, so no image is decoded to apply it.
 */
export function longEdgeCappedDpi(widthPt: number, heightPt: number, requestedDpi: number, maxLongEdgePx?: number): number {
  const bounded = boundedRasterDpi(widthPt, heightPt, requestedDpi);
  if (maxLongEdgePx === undefined) return bounded;
  if (!(Number.isInteger(maxLongEdgePx) && maxLongEdgePx >= 1)) throw new Error("maxLongEdgePx must be a positive integer");
  return Math.min(bounded, maxLongEdgePx * 72 / Math.max(widthPt, heightPt));
}

/** `boundedRasterEdge` at `dpi`, never above `maxLongEdgePx` when one is set. */
export function longEdgeCappedEdge(widthPt: number, heightPt: number, dpi: number, maxLongEdgePx?: number): number {
  const edge = boundedRasterEdge(widthPt, heightPt, dpi);
  return maxLongEdgePx === undefined ? edge : Math.min(edge, maxLongEdgePx);
}

/** Independent renderer-side square cap: safe even if metadata and render geometry disagree. */
export function boundedRasterEdge(widthPt: number, heightPt: number, dpi: number): number {
  const boundedDpi = boundedRasterDpi(widthPt, heightPt, dpi);
  // 4000² = 16 MP, so both limits hold for any aspect ratio, rotation or UserUnit.
  return Math.min(4000, Math.ceil(Math.max(widthPt, heightPt) * boundedDpi / 72));
}

/**
 * The pixel size pdftoppm gives a page rendered with `-scale-to edge` (its long side scaled to exactly `edge`, the short side
 * rounded up, width and height swapped for a page rotated 90 or 270 degrees), from the page's CropBox size in points and
 * rotation. The host takes a render's dimensions from this plan, never from the PNG the parser VM wrote. Null when the
 * rotation is unknown.
 *
 * Accurate to one pixel, not exact: pdfinfo prints sizes to six significant digits while pdftoppm uses the page's real box
 * (a 1283.6004-point page prints as 1283.6; 612.0004 and 611.9996 both print as 612), and floating point can round the
 * short side either way: a square page renders one pixel wider than `edge`, as pdftoppm itself does, so a side is at most
 * `edge + 1`. Callers use it as metadata (stored image dimensions, area
 * estimates), never as exact pixel coordinates; anything that needs exact pixels must measure the image in the VM.
 */
export function plannedPdftoppmDimensions(size: { widthPt: number; heightPt: number; rotate?: number }, edge: number): { widthPx: number; heightPx: number } | null {
  const { widthPt, heightPt, rotate } = size;
  if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) return null;
  if (!(Number.isFinite(widthPt) && widthPt > 0 && Number.isFinite(heightPt) && heightPt > 0 && Number.isInteger(edge) && edge >= 1)) return null;
  // pdftoppm: resolution = 72 * scaleTo / (width when it is the strictly longer side, else height); that side renders at exactly
  // scaleTo, the other at its points times resolution / 72, rounded up (so a square page can be one pixel wider than tall).
  const byWidth = widthPt > heightPt;
  const scale = ((72 * edge) / (byWidth ? widthPt : heightPt)) / 72;
  const across = byWidth ? edge : Math.max(1, Math.ceil(widthPt * scale));
  const down = byWidth ? Math.max(1, Math.ceil(heightPt * scale)) : edge;
  return rotate === 90 || rotate === 270 ? { widthPx: down, heightPx: across } : { widthPx: across, heightPx: down };
}
