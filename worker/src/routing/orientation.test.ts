import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AXIS_MIN_LOG_RATIO,
  axisLogRatio,
  detectOrientation,
  directionZ,
  inkMapFromGray,
  normalizeOrientation,
  proposeRotation,
  rotateInkClockwise,
  type InkMap,
} from "./orientation.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "orientation-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A synthetic upright text page: justified lines of pseudo-random "words" built from x-height bodies with
// ascender and (rarer) descender strokes, the way Latin body text distributes ink.
function textPage(width = 700, height = 900, lines = 48): InkMap {
  const ink = new Uint8Array(width * height);
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const fill = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) for (let x = x0; x < Math.min(width, x1); x++) ink[y * width + x] = 1;
  };
  for (let l = 0; l < lines; l++) {
    const base = 50 + l * 17;
    let x = 50 + Math.floor(rand() * 3) * 6;
    const right = width - 50 - Math.floor(rand() * 40);
    while (x < right) {
      const glyph = 3 + Math.floor(rand() * 5);
      const r = rand();
      fill(x, x + glyph, base - 7, base); // x-height body
      if (r < 0.3) fill(x, x + 2, base - 13, base - 7); // ascender
      else if (r > 0.94) fill(x, x + 2, base, base + 4); // descender
      x += glyph + 1 + (rand() < 0.15 ? 5 : 0);
    }
  }
  return { width, height, ink };
}

function turnClockwise(map: InkMap, times: number): InkMap {
  let out = map;
  for (let i = 0; i < times; i++) out = rotateInkClockwise(out);
  return out;
}

describe("projection heuristic", () => {
  it("proposes no rotation for an upright text page", () => {
    const reading = proposeRotation(textPage());
    expect(reading.axis).toBeGreaterThanOrEqual(AXIS_MIN_LOG_RATIO);
    expect(reading.proposal).toBe(0);
  });

  it("proposes the clockwise turn that restores a page turned 90, 180 or 270 degrees", () => {
    const upright = textPage();
    for (const turned of [1, 2, 3]) {
      expect(proposeRotation(turnClockwise(upright, turned)).proposal).toBe((360 - turned * 90) % 360);
    }
  });

  it("separates horizontal from vertical text lines", () => {
    const upright = textPage();
    expect(axisLogRatio(upright)).toBeGreaterThan(0);
    expect(axisLogRatio(rotateInkClockwise(upright))).toBeLessThan(0);
  });

  it("leaves blank, noise and sparse pages alone", () => {
    expect(proposeRotation({ width: 300, height: 400, ink: new Uint8Array(300 * 400) }).proposal).toBe(0);
    const sparse = textPage(700, 900, 4);
    expect(proposeRotation(turnClockwise(sparse, 2)).proposal).toBe(0);
    let seed = 7;
    const noise = new Uint8Array(300 * 400).map(() => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 5 === 0 ? 1 : 0));
    expect(proposeRotation({ width: 300, height: 400, ink: noise }).proposal).toBe(0);
  });

  it("scores upright lines positive and upside-down lines negative", () => {
    const upright = textPage();
    expect(directionZ(upright).z).toBeGreaterThan(0);
    expect(directionZ(turnClockwise(upright, 2)).z).toBeLessThan(0);
  });

  it("thresholds Otsu into an ink map", () => {
    const gray = new Uint8Array(100).fill(250);
    gray.fill(10, 0, 20);
    const map = inkMapFromGray(gray, 10, 10);
    expect(Array.from(map.ink.slice(0, 20)).every((v) => v === 1)).toBe(true);
    expect(Array.from(map.ink.slice(20)).every((v) => v === 0)).toBe(true);
  });

  it("rotates an ink map clockwise", () => {
    const map: InkMap = { width: 3, height: 2, ink: Uint8Array.from([1, 0, 0, 0, 0, 0]) }; // dot at top-left
    const turned = rotateInkClockwise(map);
    expect([turned.width, turned.height]).toEqual([2, 3]);
    expect(Array.from(turned.ink)).toEqual([0, 1, 0, 0, 0, 0]); // top-left goes to top-right
  });
});

describe("normalizeOrientation", () => {
  const writePage = async (name: string, turns: number) => {
    const map = turnClockwise(textPage(), turns);
    const file = path.join(dir, name);
    const gray = Buffer.alloc(map.width * map.height, 255);
    for (let i = 0; i < gray.length; i++) if (map.ink[i]) gray[i] = 0;
    await sharp(gray, { raw: { width: map.width, height: map.height, channels: 1 } }).png().toFile(file);
    return file;
  };

  it("leaves an upright page untouched", async () => {
    const file = await writePage("up.png", 0);
    const result = await normalizeOrientation({ path: file, mimeType: "image/png" });
    expect(result.rotated).toBe(false);
    expect(result.raster.path).toBe(file);
    expect(result.rotation).toBe(0);
  });

  it("turns sideways and upside-down pages upright and swaps dimensions when needed", async () => {
    for (const [turns, size] of [[1, [700, 900]], [2, [700, 900]], [3, [700, 900]]] as const) {
      const file = await writePage(`turn-${turns}.png`, turns);
      const result = await normalizeOrientation({ path: file, mimeType: "image/png" });
      expect(result.rotation).toBe((360 - turns * 90) % 360);
      expect(result.rotated).toBe(true);
      const meta = await sharp(result.raster.path).metadata();
      expect([meta.width, meta.height]).toEqual(size);
      expect((await detectOrientation(result.raster.path)).rotation).toBe(0);
    }
  });

  it("reads a downscaled copy of large images", async () => {
    const file = await writePage("big.png", 2);
    await sharp(file).resize({ width: 2100, height: 2700, fit: "fill", kernel: "nearest" }).png().toFile(path.join(dir, "big2.png"));
    expect((await detectOrientation(path.join(dir, "big2.png"))).rotation).toBe(180);
  });
});

describe("rendered text", () => {
  const words = "the quarterly report summarises delivery schedules for regional offices and the retention policy of every facility";
  const paragraph = Array.from({ length: 46 }, (_, i) => `<text x="50" y="${60 + i * 26}" font-size="17" font-family="DejaVu Sans, sans-serif">${i + 1} ${words.slice(i % 7, 100 + (i % 5) * 3)} ${words.slice(0, 18 + (i % 4) * 4)}</text>`).join("");
  const page = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1300"><rect width="1000" height="1300" fill="white"/>${paragraph}</svg>`);

  it("rotates turned pages back to upright and leaves the upright page alone", async () => {
    const upright = await sharp(page).png().toBuffer();
    for (const turn of [0, 90, 180, 270]) {
      const file = path.join(dir, `svg-${turn}.png`);
      await sharp(upright).rotate(turn).png().toFile(file);
      const result = await normalizeOrientation({ path: file, mimeType: "image/png" });
      expect(result.rotation).toBe((360 - turn) % 360);
    }
  });
});
