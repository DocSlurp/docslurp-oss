import { buildNativeParserPayload } from "./parser-payload.js";
import type { NativePdfDocument } from "./types.js";

/**
 * Page-region classification for the optional `pdfRegionExtraction` artifact, built in-process from the same
 * block/line/span payload as the parser artifact. A block's region comes from the relative position of its centre:
 * header (top 10% of the page height), footer (bottom 10%), left/right sidebar (outer 15% of the width), else body.
 */
export interface NativePdfRegionOptions {
  headerPct?: number;
  footerPct?: number;
  sidebarPct?: number;
}

type Box = [number, number, number, number];
type PayloadSpan = { text: string; size: number; bbox: Box };
type PayloadLine = { bbox: Box; spans: PayloadSpan[] };
type PayloadBlock = { bbox: Box; lines: PayloadLine[] };
type PayloadPage = { number: number; width?: number; height?: number; blocks: PayloadBlock[] };

export type NativePdfRegionType = "header" | "sidebar-left" | "body" | "sidebar-right" | "footer";
const REGION_ORDER: NativePdfRegionType[] = ["header", "sidebar-left", "body", "sidebar-right", "footer"];

const round2 = (value: number) => Math.round(value * 100) / 100;
const roundBox = (box: Box): Box => [round2(box[0]), round2(box[1]), round2(box[2]), round2(box[3])];

export function classifyRegion(bbox: Box, pageWidth: number, pageHeight: number, options: NativePdfRegionOptions = {}): NativePdfRegionType {
  const { headerPct = 0.1, footerPct = 0.1, sidebarPct = 0.15 } = options;
  const centreY = (bbox[1] + bbox[3]) / 2;
  const centreX = (bbox[0] + bbox[2]) / 2;
  if (centreY < pageHeight * headerPct) return "header";
  if (centreY > pageHeight * (1 - footerPct)) return "footer";
  if (centreX < pageWidth * sidebarPct) return "sidebar-left";
  if (centreX > pageWidth * (1 - sidebarPct)) return "sidebar-right";
  return "body";
}

export function regionsFromPayload(payload: { pages: unknown[] }, options: NativePdfRegionOptions = {}) {
  const pages = (payload.pages as PayloadPage[]).map((page) => {
    const width = page.width ?? 612;
    const height = page.height ?? 792;
    const byRegion = new Map<NativePdfRegionType, Array<{ bbox: Box; text: string; lines: unknown[] }>>();
    for (const block of page.blocks) {
      const lines = block.lines
        .map((line) => ({
          bbox: roundBox(line.bbox),
          spans: line.spans.filter((span) => span.text.trim()).map((span) => ({ text: span.text, bbox: roundBox(span.bbox), size: Math.round(span.size * 10) / 10 })),
        }))
        .filter((line) => line.spans.length > 0);
      const text = lines.flatMap((line) => line.spans.map((span) => span.text)).join(" ").trim();
      if (!text) continue;
      const region = classifyRegion(block.bbox, width, height, options);
      byRegion.set(region, [...(byRegion.get(region) ?? []), { bbox: roundBox(block.bbox), text, lines }]);
    }
    const regions = REGION_ORDER.flatMap((type) => {
      const blocks = byRegion.get(type);
      if (!blocks) return [];
      return [{
        type,
        bbox: roundBox([
          Math.min(...blocks.map((b) => b.bbox[0])), Math.min(...blocks.map((b) => b.bbox[1])),
          Math.max(...blocks.map((b) => b.bbox[2])), Math.max(...blocks.map((b) => b.bbox[3])),
        ]),
        text: blocks.map((b) => b.text).join("\n"),
        blockCount: blocks.length,
        blocks,
      }];
    });
    return { pageNumber: page.number, width: round2(width), height: round2(height), regionCount: regions.length, regions };
  });
  return { extractor: "native-pdf-regions", pageCount: pages.length, pages };
}

export async function buildNativePdfRegions(doc: NativePdfDocument, options: NativePdfRegionOptions = {}, signal?: AbortSignal) {
  return regionsFromPayload(await buildNativeParserPayload(doc, signal), options);
}
