import {
  configurePrivateCallAudit,
  getPrivateModelEndpointRegistry,
  isPrivateModelUri,
  lookupPrivateModelRoute,
  startPrivateEndpointHealthProbe,
  validatePrivateModelEndpointsAtStartup,
  buildBlockedPrivacyAuditEntry,
  formatPrivacyBlockLog,
  isProviderCallAllowed,
  privacyModeAuditsBlockedCalls,
  privacyModeSchema,
  type PrivacyAuditEntry,
  type PrivacyMode,
  type ProviderCallDescriptor,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { noteProviderPolicyProject } from "./request-context.js";

/**
 * API-side enforcement of project `privacyMode` (semantics in
 * packages/shared/src/privacy.ts). The AI client helpers in `./ai.ts` assert
 * the mode before every hosted call; the helpers here resolve a project's
 * mode fail-closed, withhold hosted API keys from optional features, and record
 * strict-privacy blocks in `privacy_audit_log`.
 */

const strictness: Record<PrivacyMode, number> = {
  standard: 0,
  "local-only": 1,
  "strict-privacy": 2,
};

/** Reads `privacyMode` from a stored or normalized pipeline. Unknown values fail closed. */
export function privacyModeOf(pipeline: unknown): PrivacyMode {
  if (!pipeline || typeof pipeline !== "object") return "standard";
  const raw = (pipeline as { privacyMode?: unknown }).privacyMode;
  if (raw === undefined || raw === null) return "standard";
  const parsed = privacyModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : "strict-privacy";
}

/** The most restrictive mode across several projects (for cross-project answers). */
export function strictestPrivacyMode(modes: Iterable<PrivacyMode>): PrivacyMode {
  let strictest: PrivacyMode = "standard";
  for (const mode of modes) {
    if (strictness[mode] > strictness[strictest]) strictest = mode;
  }
  return strictest;
}

/**
 * Loads a project's privacy mode. A lookup failure returns `local-only`
 * rather than `standard`, so an outage cannot open a hosted call.
 */
export async function loadProjectPrivacyMode(projectId: string): Promise<PrivacyMode> {
  try {
    const [row] = await sql<{ pipeline: unknown }[]>`
      select pipeline from projects where id = ${projectId} limit 1
    `;
    return privacyModeOf(row?.pipeline);
  } catch {
    return "local-only";
  }
}

export async function insertPrivacyAuditEntries(entries: readonly PrivacyAuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map((entry) => ({
    document_id: entry.documentId,
    run_id: entry.runId,
    project_id: entry.projectId,
    model_id: entry.modelId,
    endpoint: entry.endpoint,
    privacy_mode: entry.privacyMode,
  }));
  await sql`
    insert into privacy_audit_log ${sql(rows, "document_id", "run_id", "project_id", "model_id", "endpoint", "privacy_mode")}
  `;
}

/**
 * Returns true when the call may proceed. Otherwise logs the block, records it
 * for strict-privacy projects, and returns false so optional features skip.
 */
export async function allowHostedCallForProject(args: {
  privacyMode: PrivacyMode;
  projectId: string | null;
  call: ProviderCallDescriptor;
}): Promise<boolean> {
  // The project's China-provider setting applies to this request's hosted calls from here on.
  noteProviderPolicyProject(args.projectId);
  if (isProviderCallAllowed(args.privacyMode, args.call)) return true;
  console.warn(`${formatPrivacyBlockLog(args.privacyMode, args.call)} project=${args.projectId ?? "-"}`);
  if (privacyModeAuditsBlockedCalls(args.privacyMode)) {
    try {
      await insertPrivacyAuditEntries([
        buildBlockedPrivacyAuditEntry({ privacyMode: args.privacyMode, call: args.call, projectId: args.projectId }),
      ]);
    } catch (error) {
      // The call stays blocked; a lost audit row must not reopen it.
      console.error(`[privacy] audit write failed project=${args.projectId ?? "-"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return false;
}

/** Hosted API key for an optional feature, or undefined when privacyMode blocks it. */
export async function hostedApiKeyForProject(args: {
  apiKey: string | undefined;
  privacyMode: PrivacyMode;
  projectId: string | null;
  call: ProviderCallDescriptor;
}): Promise<string | undefined> {
  if (!args.apiKey) return undefined;
  return (await allowHostedCallForProject(args)) ? args.apiKey : undefined;
}

/**
 * Resolves the strictest privacy mode across projects that contribute content
 * to one hosted call, and the API key to use (undefined when any blocks it).
 * Each blocking project gets its own audit row.
 */
export async function hostedApiKeyForProjects(args: {
  apiKey: string | undefined;
  projectIds: Iterable<string>;
  call: ProviderCallDescriptor;
}): Promise<{ apiKey: string | undefined; privacyMode: PrivacyMode }> {
  const ids = [...new Set(args.projectIds)];
  for (const projectId of ids) noteProviderPolicyProject(projectId);
  const modes = await Promise.all(ids.map((projectId) => loadProjectPrivacyMode(projectId)));
  const privacyMode = strictestPrivacyMode(modes);
  if (!args.apiKey) return { apiKey: undefined, privacyMode };
  let allowed = true;
  for (const [index, projectId] of ids.entries()) {
    if (!(await allowHostedCallForProject({ privacyMode: modes[index]!, projectId, call: args.call }))) allowed = false;
  }
  return { apiKey: allowed ? args.apiKey : undefined, privacyMode };
}

export function openRouterCall(operation: string, model: string): ProviderCallDescriptor {
  return { provider: "openrouter", model, operation, target: "hosted" };
}

// Private endpoint calls made by the API pass an explicit audit scope
// (project), so strict-privacy rows are written here before content is sent.
configurePrivateCallAudit({ write: insertPrivacyAuditEntries });

/**
 * API startup: validates DOCSLURP_PRIVATE_MODEL_ENDPOINTS (throws on invalid
 * config) and starts a non-blocking `GET /models` probe per endpoint.
 */
export function initializePrivateModelEndpoints(): void {
  for (const line of validatePrivateModelEndpointsAtStartup()) console.log(line);
  if (getPrivateModelEndpointRegistry().endpoints.length > 0) startPrivateEndpointHealthProbe();
}

/**
 * Text model the API may use for a project's content when hosted models are
 * blocked: the project's `textGeneration.model` when it is a registered
 * private route, else the operator's `DOCSLURP_PRIVATE_TEXT_MODEL`. Returns
 * undefined in standard mode (behaviour unchanged) or when nothing resolves.
 */
export function privateTextModelForProject(pipeline: unknown, privacyMode: PrivacyMode): string | undefined {
  if (privacyMode === "standard") return undefined;
  const projectModel = pipeline && typeof pipeline === "object"
    ? (pipeline as { textGeneration?: { model?: unknown } }).textGeneration?.model
    : undefined;
  for (const candidate of [projectModel, process.env.DOCSLURP_PRIVATE_TEXT_MODEL?.trim()]) {
    if (typeof candidate === "string" && isPrivateModelUri(candidate)
      && lookupPrivateModelRoute({ ref: candidate, capability: "text" }).ok) return candidate;
  }
  return undefined;
}
