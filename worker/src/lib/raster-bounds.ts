/** Bound pixel allocation before invoking either renderer, including oversized PDF media boxes. */
export function boundedRasterDpi(widthPt: number, heightPt: number, requestedDpi: number): number {
  if (![widthPt, heightPt, requestedDpi].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("Invalid PDF page dimensions");
  }
  // Leave a pixel of rounding headroom for engines which ceil each axis.
  return Math.min(requestedDpi, 4095 * 72 / Math.max(widthPt, heightPt),
    Math.sqrt(15_990_000 / (widthPt * heightPt)) * 72);
}
