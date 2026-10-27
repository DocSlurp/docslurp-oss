/**
 * Pixel-orientation normalisation for the routed vision path (E2, I2).
 *
 * Scans and photographed pages arrive rotated even when the PDF says /Rotate 0, and hosted VLMs and the open
 * OCR models lose accuracy on 90/180/270 degree pages (wild-v1: Gemini Flash Lite 0.930 -> 0.881, DeepSeek-OCR-2
 * 0.251 on 90 degree scans). Before any model call we look for a confident rotation and turn the raster upright.
 * A wrong rotation is worse than none, so every ambiguous page is left alone.
 *
 * Tesseract OSD was measured and rejected as the detector: on real document pages it named a false 180 degree
 * rotation on 2-6% of upright pages at confidence >= 2, and still 0.4% at confidence >= 5 where it recovers only
 * 3% of turned pages; used as a veto on the heuristic below it cancelled only correct proposals. The detector is a
 * CPU projection heuristic on a 1200 px grayscale ink map (about 50 ms per page, no subprocess):
 *
 *  1. axis: text lines make the row ink profile oscillate when the page is upright or upside down, and the
 *     column profile oscillate when it is sideways (log ratio of detail energy, six strips per direction);
 *  2. direction: Latin lines hold more ink below their vertical midpoint than above it (ascenders pull the line
 *     box up, descenders are rarer), so the ink centroid of upright lines sits low; a weighted z-score over lines.
 *
 * Both decisions need a margin, and the direction needs enough lines, otherwise the page is left alone. The
 * thresholds are the values measured by `scripts/page-router/transcription_bench.py orient`, which reads them
 * from this file and runs this module on upright and turned pages.
 *
 * STATUS: eval-only, not wired into any production path (no flag reads it). E2 measured 0.35% false rotations
 * and ~43% recovery of turned pages; that is not enough evidence to rotate customer rasters before VLM calls.
 * Wiring it (behind a default-off flag in executors/deps.ts `vlm`) needs a fresh-corpus A/B first.
 */

import sharp from "sharp";

import type { RasterRef } from "./executors/types.js";

/** Long edge of the grayscale ink map the heuristic reads. */
export const INK_MAP_LONG_EDGE_PX = 1200;
/** Minimum |log energy ratio| between row and column ink profiles before a page counts as upright/sideways. */
export const AXIS_MIN_LOG_RATIO = 1.5;
/** Minimum |z| of the line-centroid statistic before up/down is decided. */
export const DIRECTION_MIN_Z = 3;
/** Minimum number of text lines behind the direction decision. */
export const DIRECTION_MIN_LINES = 10;

export type Rotation = 0 | 90 | 180 | 270;

// ---- Projection heuristic -------------------------------------------------

/** Row-major boolean ink map (1 = dark pixel). */
export interface InkMap {
  width: number;
  height: number;
  ink: Uint8Array;
}

/** Otsu threshold over a 256-bin histogram; ink = pixels at or below it. */
export function inkMapFromGray(gray: Uint8Array, width: number, height: number): InkMap {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]!]!++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]!;
  let wb = 0;
  let sb = 0;
  let best = -1;
  let threshold = 127;
  for (let i = 0; i < 256; i++) {
    wb += hist[i]!;
    if (wb === 0) continue;
    const wf = total - wb;
    if (wf === 0) break;
    sb += i * hist[i]!;
    const between = wb * wf * (sb / wb - (sumAll - sb) / wf) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  const ink = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) ink[i] = gray[i]! <= threshold ? 1 : 0;
  return { width, height, ink };
}

/** The map after turning the page 90 degrees clockwise. */
export function rotateInkClockwise(map: InkMap): InkMap {
  const { width: w, height: h } = map;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = map.ink[y * w + x]!;
  return { width: h, height: w, ink: out };
}

/** Sum of squared deviations from a centred 41-sample moving average (zero padded), i.e. line-pitch detail energy. */
function detailEnergy(profile: Float64Array): number {
  const half = 20;
  const prefix = new Float64Array(profile.length + 1);
  for (let i = 0; i < profile.length; i++) prefix[i + 1] = prefix[i]! + profile[i]!;
  let energy = 0;
  for (let i = 0; i < profile.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(profile.length - 1, i + half);
    const trend = (prefix[hi + 1]! - prefix[lo]!) / 41;
    energy += (profile[i]! - trend) ** 2;
  }
  return energy;
}

/** > 0: text lines run horizontally (upright or upside down); < 0: vertically (sideways). Six strips per direction. */
export function axisLogRatio(map: InkMap, strips = 6): number {
  const { width: w, height: h, ink } = map;
  let rows = 0;
  let cols = 0;
  for (let s = 0; s < strips; s++) {
    const x0 = Math.floor((s * w) / strips);
    const x1 = Math.floor(((s + 1) * w) / strips);
    const rowProfile = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = x0; x < x1; x++) n += ink[y * w + x]!;
      rowProfile[y] = n;
    }
    rows += detailEnergy(rowProfile);
    const y0 = Math.floor((s * h) / strips);
    const y1 = Math.floor(((s + 1) * h) / strips);
    const colProfile = new Float64Array(w);
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) colProfile[x]! += ink[y * w + x]!;
    cols += detailEnergy(colProfile);
  }
  return Math.log((rows + 1) / (cols + 1));
}

/** Text-line row spans of an upright-axis page: rows whose ink count clears 8% of the busiest row, gaps <= 3 bridged. */
function textLines(rowInk: Float64Array): Array<[number, number]> {
  const n = rowInk.length;
  let max = 0;
  for (const v of rowInk) if (v > max) max = v;
  const threshold = Math.max(max * 0.08, 2);
  const on = Array.from(rowInk, (v) => v > threshold);
  const lines: Array<[number, number]> = [];
  let i = 0;
  while (i < n) {
    if (!on[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && (on[j] || (j + 3 < n && (on[j] || on[j + 1] || on[j + 2] || on[j + 3])))) j++;
    lines.push([i, j]);
    i = j;
  }
  return lines;
}

/** z > 0: lines hold their ink low, as upright Latin text does; z < 0: upside down. `lines` counts the evidence. */
export function directionZ(map: InkMap): { z: number; lines: number } {
  const { width: w, ink } = map;
  const rowInk = new Float64Array(map.height);
  for (let y = 0; y < map.height; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += ink[y * w + x]!;
    rowInk[y] = n;
  }
  const values: number[] = [];
  const weights: number[] = [];
  for (const [a, b] of textLines(rowInk)) {
    const height = b - a;
    if (height < 6 || height > 60) continue;
    let total = 0;
    let moment = 0;
    for (let y = a; y < b; y++) {
      total += rowInk[y]!;
      moment += (y - a + 0.5) * rowInk[y]!;
    }
    if (total < 50) continue;
    values.push(moment / total / height - 0.5);
    weights.push(total);
  }
  if (values.length === 0) return { z: 0, lines: 0 };
  let wSum = 0;
  let mean = 0;
  for (let i = 0; i < values.length; i++) {
    wSum += weights[i]!;
    mean += values[i]! * weights[i]!;
  }
  mean /= wSum;
  let spread = 0;
  for (let i = 0; i < values.length; i++) spread += (values[i]! - mean) ** 2 * weights[i]! ** 2;
  return { z: mean / (Math.sqrt(spread) / wSum + 1e-6), lines: values.length };
}

export interface HeuristicReading {
  axis: number;
  z: number | null;
  lines: number;
  /** Clockwise degrees the heuristic proposes; 0 = leave the page alone. */
  proposal: Rotation;
}

export function proposeRotation(map: InkMap): HeuristicReading {
  const axis = axisLogRatio(map);
  if (axis >= AXIS_MIN_LOG_RATIO) {
    const { z, lines } = directionZ(map);
    return { axis, z, lines, proposal: lines >= DIRECTION_MIN_LINES && z <= -DIRECTION_MIN_Z ? 180 : 0 };
  }
  if (axis <= -AXIS_MIN_LOG_RATIO) {
    // Read the page as if turned 90 degrees clockwise: upright there means a 90 degree fix, upside down 270.
    const { z, lines } = directionZ(rotateInkClockwise(map));
    if (lines < DIRECTION_MIN_LINES) return { axis, z, lines, proposal: 0 };
    return { axis, z, lines, proposal: z >= DIRECTION_MIN_Z ? 90 : z <= -DIRECTION_MIN_Z ? 270 : 0 };
  }
  return { axis, z: null, lines: 0, proposal: 0 };
}

export interface OrientationResult {
  /** Clockwise degrees applied to make the page upright; 0 when none is justified. */
  rotation: Rotation;
  heuristic: HeuristicReading;
  latencyMs: number;
}

async function loadInkMap(imagePath: string): Promise<InkMap> {
  const edge = INK_MAP_LONG_EDGE_PX;
  const { data, info } = await sharp(imagePath)
    .flatten({ background: "#ffffff" })
    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return inkMapFromGray(new Uint8Array(data.buffer, data.byteOffset, info.width * info.height), info.width, info.height);
}

/** Reads a page's orientation without modifying it. */
export async function detectOrientation(imagePath: string): Promise<OrientationResult> {
  const started = Date.now();
  const heuristic = proposeRotation(await loadInkMap(imagePath));
  return { rotation: heuristic.proposal, heuristic, latencyMs: Date.now() - started };
}

export interface NormalizedRaster extends OrientationResult {
  raster: RasterRef;
  /** True when `raster` is a new file the caller must clean up. */
  rotated: boolean;
}

/** Returns the raster upright: the input when no confident rotation is found, else a rotated PNG next to it. */
export async function normalizeOrientation(raster: RasterRef): Promise<NormalizedRaster> {
  const result = await detectOrientation(raster.path);
  if (result.rotation === 0) return { ...result, raster, rotated: false };
  const target = `${raster.path}.upright.png`;
  await sharp(raster.path).rotate(result.rotation, { background: "#ffffff" }).png().toFile(target);
  return { ...result, raster: { path: target, mimeType: "image/png", ...(raster.dpi ? { dpi: raster.dpi } : {}) }, rotated: true };
}
