import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  MAX_IMAGE_PIXELS,
  buildContactSheet,
  buildGridState,
  buildImageStateParts,
  buildNamedImagesState,
  computeGridLayout,
  gridCellOrigin,
  pageLabel,
  prepareThumbnail,
} from "./contact-sheet.js";
import { makePage } from "./routing-test-fixtures.js";

async function page(w: number, h: number, color: string): Promise<Buffer> {
  return await sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
}

describe("grid layout", () => {
  it("golden dimensions for 9 pages at 384 px", () => {
    const layout = computeGridLayout(9, 384);
    expect(layout).toMatchObject({ cols: 3, rows: 3, tilePx: 384, gutterPx: 12, badgePx: 38, cellWidth: 396, cellHeight: 434, width: 1200, height: 1314 });
  });

  it("golden dimensions for 4 pages at 256 px and 16 pages at 256 px", () => {
    expect(computeGridLayout(4, 256)).toMatchObject({ cols: 2, rows: 2, width: 2 * 264 + 8, height: 2 * (256 + 26 + 8) + 8 });
    expect(computeGridLayout(16, 256)).toMatchObject({ cols: 4, rows: 4 });
  });

  it("keeps every sheet under ~2 MP by shrinking tiles", () => {
    for (const [count, tile] of [[16, 512], [16, 384], [9, 512], [4, 512]] as const) {
      const layout = computeGridLayout(count, tile);
      expect(layout.width * layout.height).toBeLessThanOrEqual(MAX_IMAGE_PIXELS);
    }
    expect(computeGridLayout(16, 512).tilePx).toBeLessThan(512);
    expect(computeGridLayout(4, 384).tilePx).toBe(384);
  });

  it("places cells row-major with a gutter", () => {
    const layout = computeGridLayout(9, 384);
    expect(gridCellOrigin(layout, 0)).toEqual({ x: 12, y: 12 });
    expect(gridCellOrigin(layout, 4)).toEqual({ x: 12 + 396, y: 12 + 434 });
    expect(gridCellOrigin(layout, 8)).toEqual({ x: 12 + 2 * 396, y: 12 + 2 * 434 });
  });
});

describe("contact sheet render", () => {
  it("renders dimensions, a dark badge strip and the tile below it", async () => {
    const pages = [
      { pageNumber: 3, source: await page(300, 400, "#ff0000") },
      { pageNumber: 7, source: await page(400, 300, "#00ff00") },
      { pageNumber: 12, source: await page(300, 400, "#0000ff") },
    ];
    const sheet = await buildContactSheet(pages, 256);
    const meta = await sharp(sheet.png).metadata();
    expect([meta.width, meta.height]).toEqual([sheet.width, sheet.height]);
    expect(sheet.layout).toMatchObject({ cols: 2, rows: 2 });
    expect(sheet.pages).toEqual([3, 7, 12]);

    const { data, info } = await sharp(sheet.png).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    const o0 = gridCellOrigin(sheet.layout, 0);
    // Badge corner sits inside the rounded rect's body: dark, not page content.
    const badge = px(o0.x + 6, o0.y + Math.floor(sheet.layout.badgePx / 2));
    expect(badge.every((c) => c < 40)).toBe(true);
    // Centre of the first tile is the page's red.
    expect(px(o0.x + 128, o0.y + sheet.layout.badgePx + 128)).toEqual([255, 0, 0]);
    // Landscape page is letterboxed: second tile centre is green.
    const o1 = gridCellOrigin(sheet.layout, 1);
    expect(px(o1.x + 128, o1.y + sheet.layout.badgePx + 128)).toEqual([0, 255, 0]);
    // The unused fourth cell stays background grey.
    const o3 = gridCellOrigin(sheet.layout, 3);
    expect(px(o3.x + 128, o3.y + 128)).toEqual([0xd4, 0xd8, 0xde]);
  });

  it("grid state legend names every page", async () => {
    const sheet = await buildContactSheet([{ pageNumber: 1, source: await page(100, 100, "#888") }, { pageNumber: 2, source: await page(100, 100, "#888") }], 256);
    const state = buildGridState(sheet);
    expect(typeof state[0]).toBe("string");
    expect(state[0]).toContain("P01=row 1 col 1");
    expect(state[0]).toContain("P02=row 1 col 2");
    expect(state[1]).toMatchObject({ type: "image_url" });
  });
});

describe("named images and per-page", () => {
  it("builds ['Page P07:', image, ...] states", async () => {
    const a = await prepareThumbnail({ pageNumber: 7, source: await page(600, 800, "#123456") }, 384);
    const b = await prepareThumbnail({ pageNumber: 8, source: await page(600, 800, "#654321") }, 384);
    const state = buildNamedImagesState([a, b]);
    expect(state).toHaveLength(4);
    expect(state[0]).toBe("Page P07:");
    expect(state[2]).toBe("Page P08:");
    expect(state[1]).toMatchObject({ type: "image_url" });
    const meta = await sharp(a.png).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(384);
  });

  it("pageLabel pads to two digits", () => {
    expect(pageLabel(7)).toBe("P07");
    expect(pageLabel(123)).toBe("P123");
  });

  it("buildImageStateParts follows the page thumbnail uri and rejects pages without one", async () => {
    const thumbs = new Map([[1, await page(200, 300, "#999")]]);
    const parts = await buildImageStateParts("named-images", [makePage(1)], thumbs, 256);
    expect(parts.images[0]).toBe("Page P01:");
    await expect(buildImageStateParts("grid", [makePage(2)], thumbs, 256)).rejects.toThrow(/no thumbnail/);
    expect((await buildImageStateParts("text-state", [makePage(2)], thumbs)).images).toEqual([]);
  });
});
