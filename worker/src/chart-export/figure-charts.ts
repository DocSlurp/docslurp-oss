import { lstat, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import { DOPPLER_FIGURE_LIMITS, dopplerFigureRecordSchema, dopplerFigureSlot, type DopplerFigureRecord } from "@docslurp/shared";

import { validateDeterministicBatch, validateDeterministicResult } from "./extractors/host.js";
import type { DeterministicVisualResult as GuestResult } from "./extractors/types.js";
import { chartExportActive, chartExportConfigOf } from "./config.js";
import { chartExportInlineEnabled } from "./inline.js";

/*
 * Charts from Doppler's figure SVGs, extracted in the Doppler VM's own figure pass (guest protocol 15, `--figure-charts`):
 * the guest runs the chart guest bundle over each kept SVG figure with the words of the PDF's text layer around it and
 * writes `charts.json` beside the figures. No extra VM boots. The host:
 * - asks for it only when inline mode is on, the run's chart tier is active (free or models, under the switch) and the
 *   provider declares `figures.charts` (figureChartsRequest);
 * - takes `charts.json` out of the figure folder before the folder's own strict validation (takeFigureCharts), never
 *   following a link, at most FIGURE_CHARTS_MAX_BYTES;
 * - validates it against the stored figure index: only the document's own SVG figures, each once, and every result
 *   with the standalone guest's validator (validateDeterministicBatch). Anything malformed is a refusal: the figures and
 *   the Markdown stand either way;
 * - stores the validated answer as its own artifact, whose object name says whether it has work, so vision-extract
 *   decides from the ledger alone.
 */

export const FIGURE_CHARTS_FILE = "charts.json";
export const FIGURE_CHARTS_SCHEMA = "doppler-figure-charts@1";
export const FIGURE_CHARTS_MAX_BYTES = 4 * 1024 * 1024;
/** Document artifact slot of the stored answer (its object name ends `.charts.work.json` or `.charts.none.json`). */
export const FIGURE_CHARTS_SLOT = "doppler-figure-charts";
const SLUG = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const MAX_MS = 600_000;

export interface FigureChartsRequest { diagrams: boolean; pages: number }

/** The job's `figures.charts`, or null: inline mode, an active chart tier under the switch, and a provider that can. */
export function figureChartsRequest(
  pipeline: unknown, provider: { figures?: { charts?: boolean } } | null | undefined, pageCount: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): FigureChartsRequest | null {
  if (!chartExportInlineEnabled(env) || !chartExportActive(pipeline, env) || provider?.figures?.charts !== true) return null;
  const pages = Number.isSafeInteger(pageCount) && pageCount > 0 ? Math.min(pageCount, 100_000) : 1;
  return { diagrams: chartExportConfigOf(pipeline, env).diagrams !== false, pages };
}

export type TakenFigureCharts = { raw: unknown } | { refused: string } | null;

/**
 * Remove `charts.json` from a quiescent figure folder and return its parsed JSON (null when absent). A link, a directory
 * or an oversized file is removed and refused; it is never followed or read past the cap. The folder is then exactly
 * what it was before charts existed, so readDopplerFigureDir validates it unchanged.
 */
export async function takeFigureCharts(dir: string): Promise<TakenFigureCharts> {
  const file = path.join(dir, FIGURE_CHARTS_FILE);
  const info = await lstat(file).catch(() => null);
  if (!info) return null;
  try {
    if (!info.isFile()) return { refused: "not-a-file" };
    if (info.size > FIGURE_CHARTS_MAX_BYTES) return { refused: "result-too-large" };
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > FIGURE_CHARTS_MAX_BYTES) return { refused: "result-too-large" };
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
      try { return { raw: JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) }; } catch { return { refused: "result-invalid" }; }
    } finally {
      await handle.close();
    }
  } catch {
    return { refused: "read-failed" };
  } finally {
    await rm(file, { recursive: true, force: true });
  }
}

export interface StoredFigureChart { id: string; page: number; bbox: [number, number, number, number]; result: GuestResult }
export type StoredFigureCharts =
  | { schemaVersion: typeof FIGURE_CHARTS_SCHEMA; status: "ok"; ms: number | null; figures: StoredFigureChart[] }
  | { schemaVersion: typeof FIGURE_CHARTS_SCHEMA; status: "refused"; reason: string };

const refused = (reason: string): StoredFigureCharts => ({ schemaVersion: FIGURE_CHARTS_SCHEMA, status: "refused", reason });

/** The document's own SVG figures (each with its own file), by id, from the validated figure index. */
function ownSvgFigures(index: readonly unknown[]): Map<string, DopplerFigureRecord> {
  const out = new Map<string, DopplerFigureRecord>();
  for (const raw of index) {
    const parsed = dopplerFigureRecordSchema.safeParse(raw);
    if (!parsed.success) continue;
    const f = parsed.data;
    let ownSlot = false;
    try { ownSlot = f.slot === dopplerFigureSlot(f.id); } catch { ownSlot = false; }
    if (f.format === "svg" && f.fileOf === f.id && ownSlot) out.set(f.id, f);
  }
  return out;
}

/**
 * The guest's answer, checked against the figure index the host stored. Never throws: anything malformed or naming a
 * figure that is not one of the document's own SVG figures refuses the whole answer.
 */
export function validateFigureCharts(taken: TakenFigureCharts, index: readonly unknown[]): StoredFigureCharts | null {
  if (taken === null) return null;
  if ("refused" in taken) return refused(taken.refused);
  const o = taken.raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || o.schemaVersion !== FIGURE_CHARTS_SCHEMA) return refused("result-invalid");
  if (o.status === "refused") {
    const keys = Object.keys(o).sort().join(",");
    return keys === "reason,schemaVersion,status" && typeof o.reason === "string" && SLUG.test(o.reason) ? refused(o.reason) : refused("result-invalid");
  }
  if (o.status !== "ok") return refused("result-invalid");
  const keys = Object.keys(o).sort();
  if (keys.some((k) => !["batch", "figures", "ms", "schemaVersion", "status"].includes(k)) || !Array.isArray(o.figures)) return refused("result-invalid");
  const ms = o.ms === undefined ? null : Number.isSafeInteger(o.ms) && (o.ms as number) >= 0 && (o.ms as number) <= MAX_MS ? (o.ms as number) : NaN;
  if (Number.isNaN(ms)) return refused("result-invalid");
  const own = ownSvgFigures(index);
  const ids = o.figures as unknown[];
  if (ids.length > DOPPLER_FIGURE_LIMITS.maxFiles || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !own.has(id))) return refused("unknown-figure");
  let results: GuestResult[];
  try {
    results = validateDeterministicBatch(o.batch, ids.length);
  } catch {
    return refused("result-invalid");
  }
  return {
    schemaVersion: FIGURE_CHARTS_SCHEMA, status: "ok", ms,
    figures: (ids as string[]).map((id, i) => {
      const f = own.get(id)!;
      // Page and box come from the host's own index, never from the guest's answer.
      return { id, page: f.page, bbox: f.bbox, result: results[i]! };
    }),
  };
}

/** A stored answer read back (storage is not trusted either): the same shape checks, results validated again. */
export function readStoredFigureCharts(raw: unknown): StoredFigureCharts | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.schemaVersion !== FIGURE_CHARTS_SCHEMA) return null;
  if (o.status === "refused") return typeof o.reason === "string" && SLUG.test(o.reason) ? refused(o.reason) : null;
  if (o.status !== "ok" || !Array.isArray(o.figures) || o.figures.length > DOPPLER_FIGURE_LIMITS.maxFiles) return null;
  try {
    const figures = (o.figures as Array<Record<string, unknown>>).map((f) => {
      const bbox = f.bbox as unknown[];
      if (typeof f.id !== "string" || !Number.isSafeInteger(f.page) || (f.page as number) < 1 || !Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("bad figure");
      return { id: f.id, page: f.page as number, bbox: bbox as [number, number, number, number], result: validateDeterministicResult(f.result) };
    });
    return { schemaVersion: FIGURE_CHARTS_SCHEMA, status: "ok", ms: typeof o.ms === "number" ? o.ms : null, figures };
  } catch {
    return null;
  }
}

/** Whether the answer gives the free pass anything to export or defer. */
export function figureChartsHaveWork(charts: StoredFigureCharts | null): boolean {
  return charts?.status === "ok" && charts.figures.some((f) => f.result.visuals.length > 0 || (f.result.deferred?.length ?? 0) > 0);
}

/** Object name of the stored answer: the work bit is in the name, so the ledger alone says whether to look. */
export function figureChartsObjectName(documentId: string, work: boolean): string {
  return `${documentId}.charts.${work ? "work" : "none"}.json`;
}

/** Whether a recorded slot URI points at an answer with work. */
export function figureChartsSlotHasWork(uri: string | undefined): boolean {
  return typeof uri === "string" && uri.endsWith(".charts.work.json");
}
