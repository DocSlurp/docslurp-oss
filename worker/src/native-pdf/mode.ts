/**
 * DOCSLURP_PDF_ENGINE selects how the native PDF engine participates:
 * - `off` (default): not used; extractor order and outputs are unchanged.
 * - `shadow`: runs beside the primary PDF extractor, records per-page agreement
 *   and timing to performance_log (metric `native-pdf-shadow`), never serves output.
 * - `native-pdf`: primary PDF extractor with automatic kreuzberg fallback.
 */
export type NativePdfMode = "off" | "shadow" | "native-pdf";

export function resolveNativePdfMode(env: NodeJS.ProcessEnv = process.env): NativePdfMode {
  const raw = env.DOCSLURP_PDF_ENGINE?.trim().toLowerCase();
  if (raw === "shadow" || raw === "native-pdf") return raw;
  if (raw && raw !== "off" && raw !== "kreuzberg") {
    console.warn(`[native-pdf] ignoring unknown DOCSLURP_PDF_ENGINE=${raw}; using off`);
  }
  return "off";
}

/** Opt-in emphasis repair: mis-emphasis costs on strict scorers (P1 §1). */
export function nativePdfEmphasisEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DOCSLURP_NATIVE_PDF_EMPHASIS === "1" || env.DOCSLURP_NATIVE_PDF_EMPHASIS === "true";
}
