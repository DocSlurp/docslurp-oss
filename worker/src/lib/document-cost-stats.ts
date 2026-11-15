import { pageCostRoute, PAGE_COST_ROUTES, type PageCostRoute } from "@docslurp/shared";
import type { PageLayoutFacts } from "./page-layout-facts.js";

/** Settings-independent structural observations. Null means this evidence source cannot measure the quantity. */
export function documentCostStats(facts: ReadonlyMap<number, PageLayoutFacts> | undefined, pageCount: number) {
  const pages = Math.max(0, Math.min(100_000, Math.trunc(pageCount)));
  const routes = Object.fromEntries(PAGE_COST_ROUTES.map((route) => [route, 0])) as Record<PageCostRoute, number>;
  const images = { placements: 0, unknownPages: 0, sizeUnknown: 0, declaredBytes: 0, bytesUnknown: 0,
    megapixels: [0, 0, 0, 0, 0], repeatedPlacements: 0, uniqueObjects: null,
    classes: { decorative: 0, picture: 0, scanLike: 0, unknown: 0 } };
  const tables = { grids: 0, unknownPages: 0 };
  const textLayers = { none: 0, visible: 0, invisible: 0, mixed: 0, unknownPages: 0 };
  for (let number = 1; number <= pages; number += 1) {
    const page = facts?.get(number);
    // This evidence has no path count. A wordless page without images may still contain a vector drawing.
    routes[pageCostRoute({ words: page?.words ?? null, images: page?.images?.length ?? null,
      vectorPaths: null, grids: page?.grids ?? null, gridCoverage: page?.tableCoverage ?? null })] += 1;
    if (page?.textLayer) textLayers[page.textLayer] += 1; else textLayers.unknownPages += 1;
    if (page?.grids) tables.grids += page.grids.length; else tables.unknownPages += 1;
    if (!page?.images) { images.unknownPages += 1; continue; }
    for (const image of page.images) {
      images.placements += 1;
      if (image.repeated) images.repeatedPlacements += 1;
      const pixels = image.widthPx * image.heightPx;
      if (image.widthPx > 0 && image.heightPx > 0) {
        const mp = pixels / 1_000_000;
        images.megapixels[[0.0625, 0.25, 1, 4].filter((floor) => mp >= floor).length]! += 1;
      } else images.sizeUnknown += 1;
      if (image.bytesPerPixel !== null && image.bytesPerPixel !== undefined && pixels > 0) images.declaredBytes += Math.round(image.bytesPerPixel * pixels);
      else images.bytesUnknown += 1;
      // Structural classes are planning hints, not semantic chart/photo classification or billing evidence.
      if (image.coverage === null || pixels <= 0) images.classes.unknown += 1;
      else if (image.repeated || Math.min(image.widthPx, image.heightPx) < 32 || image.coverage < 0.02) images.classes.decorative += 1;
      else if (image.coverage >= 0.5) images.classes.scanLike += 1;
      else images.classes.picture += 1;
    }
  }
  return { schema: 1, pages, routes, images, tables, textLayers,
    charts: { count: null, classes: null, sizes: null, repeats: null },
    vectors: { paths: null, clusters: null }, scanCopy: null };
}
