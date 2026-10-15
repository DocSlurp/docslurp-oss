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

/**
 * API-side enforcement of workspace `privacyMode` (semantics in
 * packages/shared/src/privacy.ts). The AI client helpers in `./ai.ts` assert
 * the mode before every hosted call; the helpers here resolve a workspace's
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

/** The most restrictive mode across several workspaces (for cross-workspace answers). */
export function strictestPrivacyMode(modes: Iterable<PrivacyMode>): PrivacyMode {
  let strictest: PrivacyMode = "standard";
  for (const mode of modes) {
    if (strictness[mode] > strictness[strictest]) strictest = mode;
  }
  return strictest;
}

/**
 * Loads a workspace's privacy mode. A lookup failure returns `local-only`
 * rather than `standard`, so an outage cannot open a hosted call.
 */
export async function loadWorkspacePrivacyMode(workspaceId: string): Promise<PrivacyMode> {
  try {
    const [row] = await sql<{ pipeline: unknown }[]>`
      select pipeline from workspaces where id = ${workspaceId} limit 1
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
    workspace_id: entry.workspaceId,
    model_id: entry.modelId,
    endpoint: entry.endpoint,
    privacy_mode: entry.privacyMode,
  }));
  await sql`
    insert into privacy_audit_log ${sql(rows, "document_id", "run_id", "workspace_id", "model_id", "endpoint", "privacy_mode")}
  `;
}

/**
 * Returns true when the call may proceed. Otherwise logs the block, records it
 * for strict-privacy workspaces, and returns false so optional features skip.
 */
export async function allowHostedCallForWorkspace(args: {
  privacyMode: PrivacyMode;
  workspaceId: string | null;
  call: ProviderCallDescriptor;
}): Promise<boolean> {
  if (isProviderCallAllowed(args.privacyMode, args.call)) return true;
  console.warn(`${formatPrivacyBlockLog(args.privacyMode, args.call)} workspace=${args.workspaceId ?? "-"}`);
  if (privacyModeAuditsBlockedCalls(args.privacyMode)) {
    try {
      await insertPrivacyAuditEntries([
        buildBlockedPrivacyAuditEntry({ privacyMode: args.privacyMode, call: args.call, workspaceId: args.workspaceId }),
      ]);
    } catch (error) {
      // The call stays blocked; a lost audit row must not reopen it.
      console.error(`[privacy] audit write failed workspace=${args.workspaceId ?? "-"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return false;
}

/** Hosted API key for an optional feature, or undefined when privacyMode blocks it. */
export async function hostedApiKeyForWorkspace(args: {
  apiKey: string | undefined;
  privacyMode: PrivacyMode;
  workspaceId: string | null;
  call: ProviderCallDescriptor;
}): Promise<string | undefined> {
  if (!args.apiKey) return undefined;
  return (await allowHostedCallForWorkspace(args)) ? args.apiKey : undefined;
}

/**
 * Resolves the strictest privacy mode across workspaces that contribute content
 * to one hosted call, and the API key to use (undefined when any blocks it).
 * Each blocking workspace gets its own audit row.
 */
export async function hostedApiKeyForWorkspaces(args: {
  apiKey: string | undefined;
  workspaceIds: Iterable<string>;
  call: ProviderCallDescriptor;
}): Promise<{ apiKey: string | undefined; privacyMode: PrivacyMode }> {
  const ids = [...new Set(args.workspaceIds)];
  const modes = await Promise.all(ids.map((workspaceId) => loadWorkspacePrivacyMode(workspaceId)));
  const privacyMode = strictestPrivacyMode(modes);
  if (!args.apiKey) return { apiKey: undefined, privacyMode };
  let allowed = true;
  for (const [index, workspaceId] of ids.entries()) {
    if (!(await allowHostedCallForWorkspace({ privacyMode: modes[index]!, workspaceId, call: args.call }))) allowed = false;
  }
  return { apiKey: allowed ? args.apiKey : undefined, privacyMode };
}

export function openRouterCall(operation: string, model: string): ProviderCallDescriptor {
  return { provider: "openrouter", model, operation, target: "hosted" };
}

// Private endpoint calls made by the API pass an explicit audit scope
// (workspace), so strict-privacy rows are written here before content is sent.
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
 * Text model the API may use for a workspace's content when hosted models are
 * blocked: the workspace's `textGeneration.model` when it is a registered
 * private route, else the operator's `DOCSLURP_PRIVATE_TEXT_MODEL`. Returns
 * undefined in standard mode (behaviour unchanged) or when nothing resolves.
 */
export function privateTextModelForWorkspace(pipeline: unknown, privacyMode: PrivacyMode): string | undefined {
  if (privacyMode === "standard") return undefined;
  const workspaceModel = pipeline && typeof pipeline === "object"
    ? (pipeline as { textGeneration?: { model?: unknown } }).textGeneration?.model
    : undefined;
  for (const candidate of [workspaceModel, process.env.DOCSLURP_PRIVATE_TEXT_MODEL?.trim()]) {
    if (typeof candidate === "string" && isPrivateModelUri(candidate)
      && lookupPrivateModelRoute({ ref: candidate, capability: "text" }).ok) return candidate;
  }
  return undefined;
}
