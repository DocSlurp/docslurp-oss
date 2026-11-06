import type { PageLayoutImage, PageTable } from "@docslurp/shared";

/** One page of pdf-layout-facts@1 as routing reads it (worker/scripts/pdf_layout_facts.py `layout_facts`). */
export interface PageLayoutFacts {
  /** Placed images; null when the image listing or the walk is unknown for the page. */
  images: PageLayoutImage[] | null;
  /** The extractor's tables with their geometry; null when the page's Markdown was not given. */
  tables: PageTable[] | null;
  /** The text layer's word count; null when its word boxes are unknown. */
  words: number | null;
  /** Ruled grids (Doppler's ruling lines); null when the rules are unknown. */
  grids: PageTable[] | null;
  /** Share of the page covered by the union of its table boxes and grids; null when unknown. */
  tableCoverage: number | null;
}

/** Parse a pdf-layout-facts@1 payload into per-page facts; malformed pages are dropped (unknown), never guessed. */
export function parsePageLayoutFacts(payload: unknown, maxPage = 100_000): Map<number, PageLayoutFacts> {
  const out = new Map<number, PageLayoutFacts>();
  const root = payload as { version?: unknown; pages?: unknown } | null;
  if (!root || root.version !== "pdf-layout-facts@1" || !Array.isArray(root.pages)) return out;
  const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
  for (const entry of root.pages.slice(0, 100_000)) {
    const page = entry as Record<string, unknown> | null;
    const pageNumber = num(page?.pageNumber);
    if (!page || pageNumber === null || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > maxPage || page.known !== true) continue;
    const images = Array.isArray(page.images) ? (page.images as Array<Record<string, unknown>>).slice(0, 64).map((image) => {
      const bbox = Array.isArray(image.bbox) && image.bbox.length === 4 && image.bbox.every((v) => num(v) !== null) ? image.bbox as [number, number, number, number] : null;
      const ppi = Array.isArray(image.ppi) ? [num(image.ppi[0]), num(image.ppi[1])] as [number | null, number | null] : [null, null] as [null, null];
      return {
        bbox, coverage: num(image.coverage), widthPx: num(image.widthPx) ?? 0, heightPx: num(image.heightPx) ?? 0,
        bitsPerComponent: num(image.bitsPerComponent), colorSpace: typeof image.colorSpace === "string" ? image.colorSpace : "other",
        encoding: typeof image.encoding === "string" ? image.encoding : "other", ppi, bytesPerPixel: num(image.bytesPerPixel),
        repeated: image.repeated === true, wordsInside: num(image.wordsInside),
      } satisfies PageLayoutImage;
    }) : null;
    const tables = Array.isArray(page.tables) ? (page.tables as Array<Record<string, unknown>>).slice(0, 64).map((table) => ({
      rows: num(table.rows) ?? 0, columns: num(table.columns) ?? 0, coverage: num(table.coverage),
    })) : null;
    const grids = Array.isArray(page.grids) ? (page.grids as Array<Record<string, unknown>>).slice(0, 64).map((grid) => ({
      rows: num(grid.rows) ?? 0, columns: num(grid.columns) ?? 0, coverage: num(grid.coverage),
    })) : null;
    out.set(pageNumber, { images, tables, words: num(page.words), grids, tableCoverage: num(page.tableCoverage) });
  }
  return out;
}
