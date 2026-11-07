/*
 * Where OCR runs (docs/extraction/ocr.md). OCR reads customer bytes, so every mode is an explicit operator choice and
 * every refusal is loud: the worker never moves OCR to a weaker boundary, and never substitutes another reader for an
 * OCR path that is missing.
 *
 * - `vm`: an extractor plugin's `sandboxedOcr` provider reads each job in a fresh VM or microVM. The default under
 *   `DOCSLURP_SERVICE_PROFILE=service`. Without a provider the worker refuses to start; a failed VM read fails the page.
 * - `local`: the fixed `docslurp_ocr.py` CLI under the worker's parser sandbox. Only for customer-owned execution, where the
 *   operator owns both the bytes and the machine: it needs `DOCSLURP_SERVICE_PROFILE=self-hosted` and is refused at startup
 *   under `service` (or when the profile is unset).
 * - `hosted`: a hosted vision model reads stored image bytes as they are. Nothing is decoded, rasterised or resized on the
 *   host, so inputs that would need it (PDF pages, TIFF, unknown formats) are refused and the page fails.
 * - `off`: no OCR. The default everywhere else (a stock self-hosted install runs with NODE_ENV=production and no plugin;
 *   it reads no OCR rather than refusing to start).
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

/**
 * An OCR read the boundary failed or refused in `vm`/`local` mode. Callers that have other readers (the page router's
 * project-model fallback and cascades) must let it propagate: no other reader serves a page whose OCR failed.
 */
export class OcrBoundaryFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OcrBoundaryFailure";
  }
}

/**
 * OCR could not run for a reason that is not the input's: the VM could not be created, capacity, a deadline, a dropped
 * transfer, a provider that is not ready. Retrying later (Temporal backs off and retries the activity, possibly on another
 * worker) can succeed, so stages rethrow it instead of failing the page.
 */
export class OcrInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OcrInfrastructureError";
  }
}

/**
 * The boundary refused or rejected this input deterministically: a usage or model-pin refusal, hostile or undecodable
 * input, an internal CLI crash on these bytes, or a result that failed validation. Reading the same bytes again gives the
 * same answer, so the page fails without an in-process retry.
 */
export class OcrDeterministicFailure extends Error {
  constructor(message: string, readonly reason: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OcrDeterministicFailure";
  }
}

/** Exit codes of `docslurp_ocr.py` that refuse the job or its input (usage, model, input, internal). */
const OCR_CLI_REFUSAL_EXIT_CODES = new Set([2, 3, 4, 5]);

/**
 * Classify a failed boundary run. Aborts and command-teardown failures pass through unchanged (their callers handle
 * them). A provider marks a deterministic refusal by throwing an error with `ocrRefused: true` (SandboxedOcrProvider);
 * the local CLI by its refusal exit codes. Everything else is infrastructure.
 */
export function classifyOcrRunError(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return error;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "CommandTeardownError" || error.name === "WorkerQuarantinedError")) return error;
  if (error instanceof OcrRefusedError || error instanceof OcrDeterministicFailure || error instanceof OcrInfrastructureError) return error;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  if ((error as { ocrRefused?: unknown } | null)?.ocrRefused === true) {
    return new OcrDeterministicFailure(`OCR boundary refused the job: ${message}`, "boundary-refused", { cause: error });
  }
  const exitCode = (error as { name?: unknown; exitCode?: unknown } | null);
  if (exitCode?.name === "CommandExitError" && typeof exitCode.exitCode === "number" && OCR_CLI_REFUSAL_EXIT_CODES.has(exitCode.exitCode)) {
    return new OcrDeterministicFailure(`OCR CLI refused the job: ${message}`, "cli-refused", { cause: error });
  }
  return new OcrInfrastructureError(`OCR boundary failed to run: ${message}`, { cause: error });
}

/** Artifact-ledger key listing (JSON) the pages of a document whose OCR read failed; vision never reads them instead. */
export const OCR_FAILED_PAGES_KEY = "ocr-failed-pages";

/** The pages of a document whose OCR read failed, from the run's artifact ledger. */
export function ocrFailedPages(ledger: { readDocument(documentId: string, key: string): string | null | undefined }, documentId: string): Set<number> {
  try {
    const raw = JSON.parse(ledger.readDocument(documentId, OCR_FAILED_PAGES_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((page): page is number => Number.isSafeInteger(page) && page > 0) : []);
  } catch {
    return new Set();
  }
}

/** Add pages to the document's OCR-failed list in the run's artifact ledger. */
export function recordOcrFailedPages(
  state: { artifactLedger: { readDocument(documentId: string, key: string): string | null | undefined; recordDocument(documentId: string, key: string, value: string): void } },
  documentId: string,
  pages: readonly number[],
): string {
  const known = ocrFailedPages(state.artifactLedger, documentId);
  for (const page of pages) if (Number.isSafeInteger(page) && page > 0) known.add(page);
  const list = JSON.stringify([...known].sort((a, b) => a - b));
  state.artifactLedger.recordDocument(documentId, OCR_FAILED_PAGES_KEY, list);
  return list;
}

/** `DOCSLURP_OCR_MODE`, or the default: `vm` under the service profile, `off` elsewhere. Throws on an unknown value. */
export function resolveOcrMode(env: NodeJS.ProcessEnv = process.env): OcrMode {
  const raw = env.DOCSLURP_OCR_MODE?.trim().toLowerCase();
  if (!raw) return resolveServiceProfile(env) === "service" ? "vm" : "off";
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
  // With a VM OCR provider loaded the deployment reads customer files in VMs; nothing OCRs on the worker host.
  const provider = sandboxedOcrProvider();
  if (provider) return `DOCSLURP_OCR_MODE=local runs OCR on the worker host, and the ${provider.id} VM OCR provider is loaded`;
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
  const profile = resolveServiceProfile(env);
  const provider = sandboxedOcrProvider();
  // A loaded VM OCR provider means a deployment that reads customer files in VMs: it must say which profile it is, and it
  // never runs OCR on the worker host instead.
  if (provider && profile === null) {
    throw new Error("a sandboxedOcr provider plugin is loaded but DOCSLURP_SERVICE_PROFILE is unset; set it (service) rather than let the OCR boundary depend on a default; refusing to start");
  }
  if (provider && mode === "local") {
    throw new Error(`DOCSLURP_OCR_MODE=local would run OCR on the worker host while the ${provider.id} VM provider is loaded; use vm; refusing to start`);
  }
  if (mode === "vm") {
    if (!provider) {
      throw new Error("DOCSLURP_OCR_MODE=vm needs an OCR provider plugin (sandboxedOcr in DOCSLURP_EXTRACTOR_PLUGINS); refusing to start rather than run OCR anywhere else");
    }
    provider.assertConfigured();
  }
  if (mode === "local") {
    const refusal = localOcrRefusal(env);
    if (refusal) throw new Error(`${refusal}; refusing to start`);
  }
  console.log(`[ocr] mode=${mode} profile=${profile ?? "unset"}${mode === "vm" ? " boundary=vm" : mode === "local" ? " boundary=local-sandbox" : ""}`);
  const longEdge = ocrLongEdgeOptIn(env);
  if (longEdge !== null) {
    console.warn(
      `[ocr] long-edge-opt-in DOCSLURP_OCR_MAX_LONG_EDGE=${longEdge} (default ${OCR_LONG_EDGE_DEFAULT}): more VM time and memory per page; ` +
        "with escalation a dense page can cost more than the Rich page it bills (docs/extraction/ocr.md)",
    );
  }
  return mode;
}

/** The OCR long-edge default (engine.ts OCR_DEFAULT_MAX_LONG_EDGE); a larger cap is an explicit operator opt-in. */
const OCR_LONG_EDGE_DEFAULT = 2000;

/** The configured long-edge cap when it opts in above the default (up to 4000), else null. */
export function ocrLongEdgeOptIn(env: NodeJS.ProcessEnv = process.env): number | null {
  const parsed = Number(env.DOCSLURP_OCR_MAX_LONG_EDGE?.trim());
  return Number.isInteger(parsed) && parsed > OCR_LONG_EDGE_DEFAULT && parsed <= 4000 ? parsed : null;
}
