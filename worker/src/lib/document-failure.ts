/**
 * Which stage errors are the Document's fault. A Document that exhausted its
 * strategies on its own input is skipped by later stages so the rest of the
 * Run keeps going; anything that says the platform, not the file, is unwell
 * (database, storage, network, provider throttling, shutdown, cancellation,
 * a stalled stage) still fails the stage so it retries or the Run fails.
 */

import { isShutdownMessage } from "../temporal/failure-classification.js";
import { findHungWorkError, HungWorkError } from "./hung-work.js";
import { findProviderRetryableError } from "./provider-retry.js";

/**
 * A Run-wide stop that is not the Document's fault: a spend cap reached, or a
 * workspace policy (privacy mode, disabled provider) that forbids the work for
 * every Document. It fails the stage instead of skipping one Document.
 */
export class RunPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunPolicyError";
  }
}

const INFRASTRUCTURE_ERROR_CODES = new Set([
  "STORAGE_READ_FAILED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
]);
const INFRASTRUCTURE_ERROR_NAMES = new Set([
  "CancelledFailure",
  "AbortError",
  "PostgresError",
  "NoSuchBucket",
  "CredentialsProviderError",
  // The worker, not the Document: a command's teardown failed here, or this worker is quarantined.
  "CommandTeardownError",
  "WorkerQuarantinedError",
]);

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

export function isDocumentLevelFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  for (const link of causeChain(error)) {
    if (!(link instanceof Error)) continue;
    if (link instanceof RunPolicyError) return false;
    const code = (link as { code?: unknown }).code;
    if (typeof code === "string" && INFRASTRUCTURE_ERROR_CODES.has(code)) return false;
    // Postgres SQLSTATE classes 08 (connection), 53 (resources), 57 (operator), XX (internal).
    if (link.name === "PostgresError" && typeof code === "string" && /^(08|53|57|XX)/.test(code)) return false;
    if (INFRASTRUCTURE_ERROR_NAMES.has(link.name)) return false;
    if (isShutdownMessage(link.message)) return false;
  }
  const hung = findHungWorkError(error);
  if (hung instanceof HungWorkError ? hung.kind === "stage-stalled" : hung !== null) return false;
  if (findProviderRetryableError(error)) return false;
  return true;
}
