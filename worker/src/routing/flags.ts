/**
 * Every environment flag the page router reads, parsed in one place with safe defaults.
 *
 * Booleans are on only for `1`/`true`; enums accept their listed values (case-insensitive) and fall back
 * to the default on anything else, with one warning per process. So a typo never switches a feature on.
 * PAGE_ROUTER_MODE is the exception: it is a worker Config ceiling (config.ts readPageRouterMode).
 * Engine flags of the native-pdf adapter are read by their owners: DOCSLURP_PDF_ENGINE and
 * DOCSLURP_NATIVE_PDF_EMPHASIS (native-pdf/mode.ts), DOCSLURP_NATIVE_PDF_POPPLER (native-pdf/engine.ts),
 * DOCSLURP_NATIVE_PDF_MODULE/_DIR and NATIVE_PDF_OCR_MODEL_DIR/_OCR_MAX_CONCURRENT/_FONTS_DIR (native-pdf/loader.ts),
 * PDF_RASTER_CONCURRENCY (native-pdf/render.ts), PDF_RASTER_ENGINE, PDF_PDFTOPPM_CONCURRENCY and
 * PDF_PDFTOPPM_PROCESS_CONCURRENCY (pipeline/pdf-asset-cache.ts), PROBE_OVERLAP_RENDER and PROBE_OVERLAP_MAX_PAGES
 * (routing/page-input.ts readProbeOverlap).
 * Target availability comes from credential presence (OPENROUTER_API_KEY, *_ENDPOINT_URL; runtime.ts buildRuntimeCatalog).
 */

import { readDisableNonFreeSoftware } from "@docslurp/shared";

/** Table candidate gate: `shadow` logs ruled-grid-or-crop decisions and estimates; extraction is unchanged. */
export type TableGateMode = "off" | "shadow";
/**
 * Page OCR from the native-pdf engine: `scripts` (default) only when tesseract's output is not words in its languages
 * and the engine reads another script; `prefer` engine first (guarded); `off` tesseract only. See executors/ocr-policy.ts.
 */
export type NativeOcrPolicy = "off" | "scripts" | "prefer";

export interface RoutingFlags {
  /**
   * DISABLE_NON_FREE_SOFTWARE=1|true (default false: non-free allowed). When on, the catalogs, decision chain,
   * executors and flat-tier route policy exclude every "non-free" licence-class model or engine. Proprietary hosted
   * APIs are unaffected (privacy modes govern them). Typos default to false with one warning (readDisableNonFreeSoftware).
   */
  disableNonFreeSoftware: boolean;
  /** PAGE_ROUTER_TABLE_GATE=off|shadow (default off). */
  tableGate: TableGateMode;
  /** PAGE_ROUTER_PREFER_NATIVE_MARKDOWN=1|true (default off): accept-text pages take native-pdf Markdown. */
  preferNativeMarkdown: boolean;
  /** NATIVE_PDF_OCR=off|scripts|prefer (default scripts). */
  nativeOcr: NativeOcrPolicy;
  /** PAGE_ROUTER_LABELER_MODEL: local image labeler checkpoint (default Florence-2-small-ft). */
  labelerModel: string;
  /** PAGE_ROUTER_MODEL_PRICES_PATH: model price list override (default: the shipped list). */
  modelPricesPath: string | null;
  /** DOCSLURP_DECISION_HEALTH_HISTORY: JSON file for the multi-day canary history (default in memory). */
  healthHistoryPath: string | null;
  /** DECISION_LOCAL_SIDECAR_CMD: command of the local decision-model sidecar (default none). */
  localDecisionSidecarCmd: string | null;
}

export const DEFAULT_LABELER_MODEL = "microsoft/Florence-2-small-ft";
export const HEALTH_HISTORY_ENV = "DOCSLURP_DECISION_HEALTH_HISTORY";

const warned = new Set<string>();

function text(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = text(env, name)?.toLowerCase();
  return value === "1" || value === "true";
}

function choice<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], fallback: T): T {
  const value = text(env, name)?.toLowerCase();
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  const key = `${name}=${value}`;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[page-router] ignoring unknown ${name}=${value}; using ${fallback} (allowed: ${allowed.join(", ")})`);
  }
  return fallback;
}

export function readRoutingFlags(env: NodeJS.ProcessEnv = process.env): RoutingFlags {
  return {
    disableNonFreeSoftware: readDisableNonFreeSoftware(env),
    tableGate: choice(env, "PAGE_ROUTER_TABLE_GATE", ["off", "shadow"] as const, "off"),
    preferNativeMarkdown: flag(env, "PAGE_ROUTER_PREFER_NATIVE_MARKDOWN"),
    nativeOcr: choice(env, "NATIVE_PDF_OCR", ["off", "scripts", "prefer"] as const, "scripts"),
    labelerModel: text(env, "PAGE_ROUTER_LABELER_MODEL") ?? DEFAULT_LABELER_MODEL,
    modelPricesPath: text(env, "PAGE_ROUTER_MODEL_PRICES_PATH"),
    healthHistoryPath: text(env, HEALTH_HISTORY_ENV),
    localDecisionSidecarCmd: text(env, "DECISION_LOCAL_SIDECAR_CMD"),
  };
}
