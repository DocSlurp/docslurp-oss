/*
 * Where OCR runs (docs/extraction/ocr.md). OCR reads customer bytes, so every mode is an explicit operator choice and
 * every refusal is loud: the worker never moves OCR to a weaker boundary, and never substitutes another reader for an
 * OCR path that is missing.
 *
 * - `vm`: an extractor plugin's `sandboxedOcr` provider reads each job in a fresh VM or microVM. The production default.
 *   Without a provider the worker refuses to start; a failed VM read fails the page.
 * - `local`: the fixed `docslurp_ocr.py` CLI under the worker's parser sandbox. Only for customer-owned execution, where the
 *   operator owns both the bytes and the machine: it needs `DOCSLURP_SERVICE_PROFILE=self-hosted` and is refused at startup
 *   under `service` (or when the profile is unset).
 * - `hosted`: a hosted vision model reads stored image bytes as they are. Nothing is decoded, rasterised or resized on the
 *   host, so inputs that would need it (PDF pages, TIFF, unknown formats) are refused and the page fails.
 * - `off`: no OCR. The default outside production.
 */
import { sandboxedOcrProvider } from "../extractors/plugins.js";

export const OCR_MODES = ["vm", "local", "hosted", "off"] as const;
export type OcrMode = (typeof OCR_MODES)[number];

export const SERVICE_PROFILES = ["service", "self-hosted"] as const;
export type ServiceProfile = (typeof SERVICE_PROFILES)[number];

/** Raised when OCR is refused by configuration or policy. Stages fail the page or document; they never fall back. */
export class OcrRefusedError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = "OcrRefusedError";
  }
}

/** `DOCSLURP_OCR_MODE`, or the default: `vm` in production, `off` elsewhere. Throws on an unknown value. */
export function resolveOcrMode(env: NodeJS.ProcessEnv = process.env): OcrMode {
  const raw = env.DOCSLURP_OCR_MODE?.trim().toLowerCase();
  if (!raw) return env.NODE_ENV === "production" ? "vm" : "off";
  if (!(OCR_MODES as readonly string[]).includes(raw)) {
    throw new Error(`DOCSLURP_OCR_MODE must be one of ${OCR_MODES.join(", ")}; got ${JSON.stringify(raw)}`);
  }
  return raw as OcrMode;
}

/** `DOCSLURP_SERVICE_PROFILE`, or null when unset. Throws on an unknown value. */
export function resolveServiceProfile(env: NodeJS.ProcessEnv = process.env): ServiceProfile | null {
  const raw = env.DOCSLURP_SERVICE_PROFILE?.trim().toLowerCase();
  if (!raw) return null;
  if (!(SERVICE_PROFILES as readonly string[]).includes(raw)) {
    throw new Error(`DOCSLURP_SERVICE_PROFILE must be one of ${SERVICE_PROFILES.join(", ")}; got ${JSON.stringify(raw)}`);
  }
  return raw as ServiceProfile;
}

/** Why `local` mode is refused under this environment, or null when it is allowed. */
export function localOcrRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const profile = resolveServiceProfile(env);
  if (profile === "self-hosted") return null;
  return profile === "service"
    ? "DOCSLURP_OCR_MODE=local runs OCR inside the worker host, which does not meet the VM boundary required for service-managed customer files (DOCSLURP_SERVICE_PROFILE=service)"
    : "DOCSLURP_OCR_MODE=local is only for customer-owned execution and needs DOCSLURP_SERVICE_PROFILE=self-hosted";
}

/**
 * Startup check, run after extractor plugins load. Throws (the worker does not start) when the chosen mode cannot run as
 * configured: `vm` without a provider, `local` outside a self-hosted profile.
 */
export function assertOcrConfiguration(env: NodeJS.ProcessEnv = process.env): OcrMode {
  const mode = resolveOcrMode(env);
  resolveServiceProfile(env);
  if (mode === "vm") {
    const provider = sandboxedOcrProvider();
    if (!provider) {
      throw new Error("DOCSLURP_OCR_MODE=vm needs an OCR provider plugin (sandboxedOcr in DOCSLURP_EXTRACTOR_PLUGINS); refusing to start rather than run OCR anywhere else");
    }
    provider.assertConfigured();
  }
  if (mode === "local") {
    const refusal = localOcrRefusal(env);
    if (refusal) throw new Error(`${refusal}; refusing to start`);
  }
  console.log(`[ocr] mode=${mode} profile=${resolveServiceProfile(env) ?? "unset"}${mode === "vm" ? " boundary=vm" : mode === "local" ? " boundary=local-sandbox" : ""}`);
  return mode;
}
