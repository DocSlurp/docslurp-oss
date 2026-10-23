/** Bound pixel allocation before invoking either renderer, including oversized PDF media boxes. */
export function boundedRasterDpi(widthPt: number, heightPt: number, requestedDpi: number): number {
  if (![widthPt, heightPt, requestedDpi].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("Invalid PDF page dimensions");
  }
  // Leave a pixel of rounding headroom for engines which ceil each axis.
  return Math.min(requestedDpi, 4095 * 72 / Math.max(widthPt, heightPt),
    Math.sqrt(15_990_000 / (widthPt * heightPt)) * 72);
}

/** Independent renderer-side square cap: safe even if metadata and render geometry disagree. */
export function boundedRasterEdge(widthPt: number, heightPt: number, dpi: number): number {
  const boundedDpi = boundedRasterDpi(widthPt, heightPt, dpi);
  // 4000² = 16 MP, so both limits hold for any aspect ratio, rotation or UserUnit.
  return Math.min(4000, Math.ceil(Math.max(widthPt, heightPt) * boundedDpi / 72));
}
