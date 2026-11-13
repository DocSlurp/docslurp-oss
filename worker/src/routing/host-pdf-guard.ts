/**
 * Whether this deployment keeps PDF bytes off the worker host, and the refusal the page router raises when something would
 * read them there anyway (open, render, clip, probe or byte scan).
 *
 * The test is the one extract-markdown uses for `sandboxed-pdf-deployment` (DOCSLURP_PDF_EXTRACTOR=vm-pdf or
 * sandboxedPdfConfigured), widened by vmOnlyParsing (NODE_ENV=production or the service profile): a production host that
 * forgot to configure the VM provider still never parses a PDF in-process. An unknown setting throws inside the shared
 * readers; that is read here as sandboxed, never as permission.
 */
import { resolvePdfExtractorSetting, sandboxedPdfConfigured } from "@docslurp/shared";

import { vmOnlyParsing } from "../lib/vm-only-parsing.js";

export type SandboxedPdfReason = "sandboxed-pdf-deployment" | "vm-only-parsing" | "pdf-setting-unreadable";

export function sandboxedPdfDeploymentReason(env: NodeJS.ProcessEnv = process.env): SandboxedPdfReason | null {
  try {
    if (resolvePdfExtractorSetting(env) === "vm-pdf" || sandboxedPdfConfigured(env)) return "sandboxed-pdf-deployment";
  } catch {
    return "pdf-setting-unreadable";
  }
  return vmOnlyParsing(env) ? "vm-only-parsing" : null;
}

export const HOST_PDF_REFUSED_CODE = "HOST_PDF_REFUSED";

/** Raised before any host-side PDF access on a sandboxed deployment. Nothing was read when it is thrown. */
export class HostPdfRefusedError extends Error {
  readonly code = HOST_PDF_REFUSED_CODE;
  constructor(readonly operation: string, readonly reason: SandboxedPdfReason) {
    super(`host PDF access refused: ${operation} on a sandboxed deployment (${reason})`);
    this.name = "HostPdfRefusedError";
  }
}
