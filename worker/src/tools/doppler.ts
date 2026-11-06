import path from "node:path";

/**
 * Where Doppler's executables live: DOCSLURP_DOPPLER_BIN_DIR, else /usr/lib/doppler/bin, where the worker images install them.
 * Not on PATH, so every other host PDF tool stays Debian's poppler-utils; `pdftomarkdown` runs the fork's `pdftotext` from
 * beside itself. Used only in customer-owned local PDF mode (DOCSLURP_PDF_MODE=local); a VM deployment runs Doppler in its VM.
 */
export function dopplerBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOCSLURP_DOPPLER_BIN_DIR?.trim() || "/usr/lib/doppler/bin";
}

export function dopplerConverterPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dopplerBinDir(env), "pdftomarkdown");
}
