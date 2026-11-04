/*
 * Thresholds that decide whether a PDF page holds its content as pixels and goes to a vision read (billed Rich).
 * The worker routes pages with them (worker/src/lib/page-image-evidence.ts, worker/src/stages/classify-route.ts),
 * and the offline estimator's PDF probe classifies pages with the same numbers from the estimate card.
 */
export const PAGE_RASTER_ROUTING = {
  /** Pages with fewer native words than this are "sparse" and get raster evidence. */
  sparsePageWords: 30,
  /** Images covering less than this share of the page (logos, bullets, rules, tracking pixels) are ignored. */
  minSignificantImageCoverage: 0.02,
  /** Images with a shorter side than this (in pixels) carry no readable content. */
  minSignificantImagePixels: 32,
  /** A page without native text whose largest image covers at least this share holds its content as pixels. */
  rasterPageMinLargestImageCoverage: 0.25,
  /** ...or whose significant images together cover at least this share (banded or tiled scans). */
  rasterPageMinTotalImageCoverage: 0.35,
  /**
   * A page whose native text is only a stamp, page number or generated footer ("Page 1 of 2", a Bates number) over an
   * image covering at least `stampedScanMinImageCoverage` is a scan placed with margins.
   */
  stampTextMaxWords: 10,
  stampedScanMinImageCoverage: 0.5,
  /** A page with a little more native text (title, caption) needs an image this large to be a scan. */
  sparseTextFullPageImageCoverage: 0.85,
} as const;
