import type { CommandRunner } from "../tools/runner.js";
import { loadNativePdfEngine, nativePdfRefusal } from "./loader.js";
import { PopplerNativePdfEngine } from "./poppler-engine.js";
import type { NativePdfEngine } from "./types.js";

/**
 * The engine for this process: the private binding when present. With
 * DOCSLURP_NATIVE_PDF_POPPLER=1 a missing binding degrades to the poppler
 * text/markdown subset instead of reporting the extractor unavailable.
 */
export async function resolveNativePdfEngine(
  runner: Pick<CommandRunner, "extractText" | "pdfPageCount" | "run">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativePdfEngine | null> {
  // Under a VM-only PDF deployment neither the binding nor the host Poppler subset serves PDFs.
  if (nativePdfRefusal(env)) return null;
  const loaded = await loadNativePdfEngine(env);
  if (loaded.ok) return loaded.engine;
  if (env.DOCSLURP_NATIVE_PDF_POPPLER === "1" || env.DOCSLURP_NATIVE_PDF_POPPLER === "true") {
    return new PopplerNativePdfEngine(runner);
  }
  return null;
}
