/*
 * Page reader configuration (page-reader.ts): the operator flag, the per-document page budget and the startup check.
 * Kept apart from the reader so the OCR mode check (mode.ts) can run it without importing the pipeline.
 */
import { pageImageReaderProvider } from "../extractors/plugins.js";
import type { OcrMode } from "./mode.js";

export const OCR_PAGE_READER_MODES = ["off", "escalation", "all"] as const;
export type OcrPageReaderMode = (typeof OCR_PAGE_READER_MODES)[number];

export const OCR_PAGE_READER_METRIC = "ocr-page-reader";
/** Most pages one document may send to the reader unless `DOCSLURP_OCR_PAGE_READER_MAX_PAGES` says otherwise. */
export const DEFAULT_OCR_PAGE_READER_MAX_PAGES = 2000;
export const OCR_PAGE_READER_MAX_PAGES_LIMIT = 20_000;

/** `DOCSLURP_OCR_PAGE_READER`: `off` (default, also unset), `escalation` or `all`. Throws on anything else. */
export function ocrPageReaderMode(env: NodeJS.ProcessEnv = process.env): OcrPageReaderMode {
  const raw = env.DOCSLURP_OCR_PAGE_READER?.trim().toLowerCase();
  if (!raw) return "off";
  if (!(OCR_PAGE_READER_MODES as readonly string[]).includes(raw)) {
    throw new Error(`DOCSLURP_OCR_PAGE_READER must be one of ${OCR_PAGE_READER_MODES.join(", ")}; got ${JSON.stringify(raw)}`);
  }
  return raw as OcrPageReaderMode;
}

/** `DOCSLURP_OCR_PAGE_READER_MAX_PAGES`: the per-document page budget, 0..20000 (default 2000). Throws on anything else. */
export function ocrPageReaderMaxPages(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DOCSLURP_OCR_PAGE_READER_MAX_PAGES?.trim();
  if (!raw) return DEFAULT_OCR_PAGE_READER_MAX_PAGES;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed > OCR_PAGE_READER_MAX_PAGES_LIMIT) {
    throw new Error(`DOCSLURP_OCR_PAGE_READER_MAX_PAGES must be an integer from 0 to ${OCR_PAGE_READER_MAX_PAGES_LIMIT}; got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Default daily cap on one organization's reader provider cost, in cents (`DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS`). */
export const DEFAULT_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS = 2000;
export const OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS_LIMIT = 10_000_000;

/**
 * `DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS`: provider cost one organization's reader jobs may commit per UTC day,
 * across every worker, before further pages keep the recogniser read (page-reader-budget.ts), 0..10000000 (default 2000;
 * 0 sends nothing). The run cost cap counts only billable credits, and reader usage bills 0 credits, so this is the
 * reader's own spend bound.
 */
export function ocrPageReaderOrgDailyMaxCostCents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS?.trim();
  if (!raw) return DEFAULT_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed > OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS_LIMIT) {
    throw new Error(`DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS must be an integer from 0 to ${OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS_LIMIT}; got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Which frames the OCR boundary should keep as PNG for the reader (engine.ts OcrReadInput.keepFrames). */
export function ocrPageReaderKeepFrames(mode: OcrPageReaderMode): "candidates" | "all" | undefined {
  return mode === "all" ? "all" : mode === "escalation" ? "candidates" : undefined;
}

/**
 * Startup check, run with the OCR mode check. Throws (the worker does not start) when the reader is on but cannot run as
 * configured: an unknown mode or page budget, no provider, a provider that is not ready, or an OCR mode with no boundary
 * PNGs to read (`hosted`, `off`).
 */
export function assertOcrPageReaderConfiguration(env: NodeJS.ProcessEnv, ocrMode: OcrMode): OcrPageReaderMode {
  const mode = ocrPageReaderMode(env);
  const maxPages = ocrPageReaderMaxPages(env);
  const orgDailyMaxCostCents = ocrPageReaderOrgDailyMaxCostCents(env);
  if (mode === "off") return mode;
  if (ocrMode !== "vm" && ocrMode !== "local") {
    throw new Error(`DOCSLURP_OCR_PAGE_READER=${mode} reads the OCR boundary's page images and needs DOCSLURP_OCR_MODE=vm or local (got ${ocrMode}); refusing to start`);
  }
  const provider = pageImageReaderProvider();
  if (!provider) {
    throw new Error(`DOCSLURP_OCR_PAGE_READER=${mode} needs a page image reader plugin (pageImageReader in DOCSLURP_EXTRACTOR_PLUGINS); refusing to start rather than read pages anywhere else`);
  }
  provider.assertConfigured();
  console.log(`[ocr] page-reader mode=${mode} provider=${provider.id} maxPages=${maxPages} orgDailyMaxCostCents=${orgDailyMaxCostCents}`);
  return mode;
}
