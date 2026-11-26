import { PAGE_COST_ROUTES, type PageCostRoute } from "@docslurp/shared";
import { parsePageCostEvidence } from "./page-cost-evidence.js";
import { pageCostRouteOf, pageEvidenceFromLayout } from "./page-evidence.js";
import type { PageLayoutFacts } from "./page-layout-facts.js";

/** Settings-independent structural observations. Null means this evidence source cannot measure the quantity. */
export function documentCostStats(facts: ReadonlyMap<number, PageLayoutFacts> | undefined, pageCount: number, evidence?: ReadonlyMap<number, unknown>, sourceLexical?: ReadonlyMap<number, boolean | null>) {
  const pages = Math.max(0, Math.min(100_000, (Number.isFinite(pageCount) ? Math.trunc(pageCount) : 0)));
  const routes = Object.fromEntries(PAGE_COST_ROUTES.map((route) => [route, 0])) as Record<PageCostRoute, number>;
  const images = { placements: 0, unknownPages: 0, sizeUnknown: 0, declaredBytes: 0, bytesUnknown: 0,
    megapixels: [0, 0, 0, 0, 0], repeatedPlacements: 0, uniqueObjects: null,
    classes: { decorative: 0, picture: 0, scanLike: 0, unknown: 0 } };
  const tables = { grids: 0, unknownPages: 0 };
  const textLayers = { none: 0, visible: 0, invisible: 0, mixed: 0, unknownPages: 0 };
  const observations = {
    vectorPaths: { count: 0, unknownPages: 0 }, vectorClusters: { count: 0, unknownPages: 0 },
    chartCandidates: { count: 0, unknownPages: 0 }, confirmedCharts: { count: 0, unknownPages: 0 },
    lexicalText: { presentPages: 0, absentPages: 0, unknownPages: 0 },
    copyClasses: { copy: 0, decode: 0, render: 0, unknownPages: 0 },
    identities: { uniqueObjects: 0, extraPlacements: 0, unknownPages: 0 },
  };
  const candidates = { count: 0, unknownPages: 0, areaPt2: [0, 0, 0, 0], classes: { image: 0, vector: 0 }, repeats: 0, repeatsUnknown: 0 };
  const identities = new Map<number, number>();
  for (let number = 1; number <= pages; number += 1) {
    const page = facts?.get(number);
    const observed = parsePageCostEvidence(evidence?.get(number));
    // Final OCR text can nominate charts, but cannot prove a source text layer existed.
    if (sourceLexical) observed.lexicalText = sourceLexical.get(number) ?? null;
    for (const key of ["vectorPaths", "vectorClusters", "chartCandidates", "confirmedCharts"] as const) {
      const value = observed[key];
      if (value === null) observations[key].unknownPages += 1;
      else observations[key].count += value;
    }
    if (observed.lexicalText === null) observations.lexicalText.unknownPages += 1;
    else observations.lexicalText[observed.lexicalText ? "presentPages" : "absentPages"] += 1;
    if (observed.copyClasses === null) observations.copyClasses.unknownPages += 1;
    else for (const key of ["copy", "decode", "render"] as const) observations.copyClasses[key] += observed.copyClasses[key];
    if (observed.imageObjects === null) observations.identities.unknownPages += 1;
    else for (const id of observed.imageObjects) identities.set(id, (identities.get(id) ?? 0) + 1);
    if (observed.chartRegions === null || observed.chartCandidates !== observed.chartRegions.length) candidates.unknownPages += 1;
    else for (const region of observed.chartRegions) {
      candidates.count += 1;
      candidates.classes[region.source] += 1;
      candidates.areaPt2[[2500, 10000, 40000].filter(floor => region.areaPt2 >= floor).length]! += 1;
      if (region.repeated === null) candidates.repeatsUnknown += 1;
      else if (region.repeated) candidates.repeats += 1;
    }
    // The page's cost path from its evidence (page-evidence.ts pageCostRouteOf). This evidence has no path count: a wordless
    // page without images may still contain a vector drawing.
    routes[pageCostRouteOf(page ? pageEvidenceFromLayout(number, page) : undefined, observed)] += 1;
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
  observations.identities.uniqueObjects = identities.size;
  for (const placements of identities.values()) observations.identities.extraPlacements += placements - 1;
  return { observations, schema: 1, pages, routes, images, tables, textLayers,
    charts: { count: null, classes: null, sizes: null, repeats: null, candidates },
    vectors: { paths: null, clusters: null }, scanCopy: null };
}
