/**
 * Thumbnail packaging for decision-model triage: a numbered contact-sheet grid
 * ("grid"), a named multi-image state ("named-images") and per-page states
 * ("per-page"). Tile long edge is 256/384/512 px; any single image stays
 * under ~2 MP (the decision models bill ~1000 tokens per MP).
 */

import type { DecisionFormat, PageInput } from "@docslurp/shared";
import sharp, { type OverlayOptions } from "sharp";

import { imageDataUrlPart, type DecisionStatePart } from "./decision-client.js";

export const TILE_LONG_EDGES = [256, 384, 512] as const;
export type TileLongEdge = (typeof TILE_LONG_EDGES)[number];
export const MAX_IMAGE_PIXELS = 2_000_000;

export interface SheetPage {
  pageNumber: number;
  /** PNG/JPEG file path or encoded bytes. */
  source: string | Uint8Array;
}

export function pageLabel(pageNumber: number): string {
  return `P${String(pageNumber).padStart(2, "0")}`;
}

export interface GridLayout {
  cols: number;
  rows: number;
  /** Long edge actually used (may shrink below the requested one to honour the pixel cap). */
  tilePx: number;
  /** Height of the badge strip above each tile. */
  badgePx: number;
  gutterPx: number;
  cellWidth: number;
  cellHeight: number;
  width: number;
  height: number;
}

export function computeGridLayout(
  count: number,
  requestedTilePx: number,
  maxPixels = MAX_IMAGE_PIXELS,
): GridLayout {
  if (count < 1) throw new Error("contact sheet needs at least one page");
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  let tilePx = Math.max(32, Math.round(requestedTilePx));
  const build = (tile: number): GridLayout => {
    const gutterPx = Math.max(4, Math.round(tile / 32));
    const badgePx = Math.max(18, Math.round(tile * 0.1));
    const cellWidth = tile + gutterPx;
    const cellHeight = tile + badgePx + gutterPx;
    return {
      cols,
      rows,
      tilePx: tile,
      badgePx,
      gutterPx,
      cellWidth,
      cellHeight,
      width: cols * cellWidth + gutterPx,
      height: rows * cellHeight + gutterPx,
    };
  };
  let layout = build(tilePx);
  while (layout.width * layout.height > maxPixels && tilePx > 32) {
    tilePx = Math.max(32, Math.floor(tilePx * 0.95));
    layout = build(tilePx);
  }
  return layout;
}

export function gridCellOrigin(layout: GridLayout, index: number): { x: number; y: number } {
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return {
    x: layout.gutterPx + col * layout.cellWidth,
    y: layout.gutterPx + row * layout.cellHeight,
  };
}

async function loadTile(source: string | Uint8Array, tilePx: number): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(source)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({ width: tilePx, height: tilePx, fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function badgeSvg(label: string, width: number, height: number): Buffer {
  const fontSize = Math.round(height * 0.72);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" rx="${Math.round(height / 4)}" fill="#0b0f14"/>` +
      `<text x="${Math.round(width / 2)}" y="${Math.round(height * 0.76)}" text-anchor="middle" ` +
      `font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="${fontSize}" fill="#ffffff">${label}</text>` +
      `</svg>`,
  );
}

export interface ContactSheet {
  png: Buffer;
  width: number;
  height: number;
  layout: GridLayout;
  /** Page numbers in cell order (row-major). */
  pages: number[];
  tilePx: number;
}

/** Renders pages into a numbered grid; the badge strip above each tile carries the page label. */
export async function buildContactSheet(pages: readonly SheetPage[], tileLongEdge: number = 384): Promise<ContactSheet> {
  const layout = computeGridLayout(pages.length, tileLongEdge);
  const composites: OverlayOptions[] = [];
  for (const [index, page] of pages.entries()) {
    const origin = gridCellOrigin(layout, index);
    const tile = await loadTile(page.source, layout.tilePx);
    const badgeWidth = Math.min(layout.tilePx, Math.round(layout.badgePx * 2.6));
    composites.push({ input: badgeSvg(pageLabel(page.pageNumber), badgeWidth, layout.badgePx - 2), left: origin.x, top: origin.y });
    composites.push({
      input: tile.data,
      left: origin.x + Math.floor((layout.tilePx - tile.width) / 2),
      top: origin.y + layout.badgePx + Math.floor((layout.tilePx - tile.height) / 2),
    });
  }
  const png = await sharp({
    create: { width: layout.width, height: layout.height, channels: 3, background: "#d4d8de" },
  })
    .composite(composites)
    .png()
    .toBuffer();
  return {
    png,
    width: layout.width,
    height: layout.height,
    layout,
    pages: pages.map((page) => page.pageNumber),
    tilePx: layout.tilePx,
  };
}

/** State for the "grid" format: one instruction line plus the sheet. */
export function buildGridState(sheet: ContactSheet): DecisionStatePart[] {
  const legend = sheet.pages
    .map((pageNumber, index) => `${pageLabel(pageNumber)}=row ${Math.floor(index / sheet.layout.cols) + 1} col ${(index % sheet.layout.cols) + 1}`)
    .join(", ");
  return [
    `Contact sheet of document pages. Each thumbnail is labeled with a badge above it (${legend}).`,
    imageDataUrlPart(sheet.png),
  ];
}

export interface NamedImage {
  pageNumber: number;
  png: Uint8Array;
}

/** Normalizes a page thumbnail to the tile long edge (PNG, <= 2 MP). */
export async function prepareThumbnail(page: SheetPage, tileLongEdge: number = 384): Promise<NamedImage> {
  const side = Math.min(tileLongEdge, Math.floor(Math.sqrt(MAX_IMAGE_PIXELS)));
  const tile = await loadTile(page.source, side);
  return { pageNumber: page.pageNumber, png: tile.data };
}

/** Named multi-image state: ["Page P07:", image, "Page P08:", image, ...]. */
export function buildNamedImagesState(images: readonly NamedImage[]): DecisionStatePart[] {
  const parts: DecisionStatePart[] = [];
  for (const image of images) {
    parts.push(`Page ${pageLabel(image.pageNumber)}:`, imageDataUrlPart(image.png));
  }
  return parts;
}

/** Thumbnail sources by page number; falls back to each page's `thumbnail.uri` (a file path). */
export type PageThumbnails = ReadonlyMap<number, string | Uint8Array>;

function thumbnailFor(page: PageInput, thumbnails: PageThumbnails | undefined): SheetPage {
  const pageNumber = page.features.pageNumber;
  const source = thumbnails?.get(pageNumber) ?? page.thumbnail?.uri;
  if (!source) throw new Error(`no thumbnail for page ${pageNumber}`);
  return { pageNumber, source };
}

/** Image parts for a triage request in the given format (text-state has none). */
export async function buildImageStateParts(
  format: DecisionFormat,
  pages: readonly PageInput[],
  thumbnails: PageThumbnails | undefined,
  tileLongEdge: number = 384,
): Promise<{ images: DecisionStatePart[]; tilePx: number | null }> {
  if (format === "text-state") return { images: [], tilePx: null };
  const sources = pages.map((page) => thumbnailFor(page, thumbnails));
  if (format === "grid") {
    const sheet = await buildContactSheet(sources, tileLongEdge);
    return { images: buildGridState(sheet), tilePx: sheet.tilePx };
  }
  const prepared = await Promise.all(sources.map((source) => prepareThumbnail(source, tileLongEdge)));
  return { images: buildNamedImagesState(prepared), tilePx: tileLongEdge };
}
