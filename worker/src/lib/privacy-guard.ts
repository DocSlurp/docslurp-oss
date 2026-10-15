import { AsyncLocalStorage } from "node:async_hooks";
import type { Sql } from "postgres";
import {
  configurePrivateCallAudit,
  getPrivateModelEndpointRegistry,
  startPrivateEndpointHealthProbe,
  textModelCallDescriptor,
  validatePrivateModelEndpointsAtStartup,
  type PrivateCallAuditScope,
  buildBlockedPrivacyAuditEntry,
  formatPrivacyBlockLog,
  isProviderCallAllowed,
  privacyModeAuditsBlockedCalls,
  type PrivacyAuditEntry,
  type ProviderCallDescriptor,
} from "@docslurp/shared";

import type { WorkflowState } from "../pipeline/pipeline.js";
import { currentPerfContext } from "./perf-context.js";

/**
 * Stage-level privacy gate. Returns true when the workspace privacy mode allows
 * the call. Otherwise it logs the block, records audit rows for strict-privacy
 * workspaces (one per document), and returns false so the caller can skip the
 * optional work. Clients also call `assertProviderAllowed` directly, so a
 * missed stage gate still fails closed.
 */
export async function allowHostedCall(
  state: WorkflowState,
  call: ProviderCallDescriptor,
  documentIds: readonly string[] = [],
): Promise<boolean> {
  const mode = state.run.pipeline.privacyMode;
  if (isProviderCallAllowed(mode, call)) return true;

  console.warn(`${formatPrivacyBlockLog(mode, call)} run=${state.run.id}`);
  // A document shard's stage is blocked again by the unsharded pass, which audits every document once.
  if (privacyModeAuditsBlockedCalls(mode) && state.store?.recordPrivacyAudit && !state.shard) {
    const targets: Array<string | null> = documentIds.length > 0 ? [...documentIds] : [null];
    try {
      await state.store.recordPrivacyAudit(
        targets.map((documentId) => buildBlockedPrivacyAuditEntry({
          privacyMode: mode,
          call,
          workspaceId: state.run.workspaceId ?? null,
          runId: state.run.id,
          documentId,
        })),
      );
    } catch (error) {
      // The call stays blocked either way; a lost audit row must not reopen it.
      console.error(`[privacy] audit write failed run=${state.run.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return false;
}

/**
 * Descriptor for the worker's text generation client: OpenRouter (hosted), or
 * an operator-registered `llm://private/<alias>/<model>` route (private).
 */
export function openRouterTextCall(operation: string, model: string): ProviderCallDescriptor {
  return textModelCallDescriptor(`worker.text.${operation}`, model);
}

// ---------------------------------------------------------------------------
// Private endpoint audit scope
// ---------------------------------------------------------------------------

const privacyAuditScope = new AsyncLocalStorage<PrivateCallAuditScope>();

/**
 * Attributes private endpoint calls made inside `fn` to a workspace and run.
 * Strict-privacy private calls without a workspace scope are refused, so every
 * worker entry that runs AI stages wraps its work here.
 */
export function runWithPrivacyAuditScope<T>(scope: PrivateCallAuditScope, fn: () => Promise<T>): Promise<T> {
  return privacyAuditScope.run(scope, fn);
}

export function currentPrivacyAuditScope(): PrivateCallAuditScope | undefined {
  const scope = privacyAuditScope.getStore();
  if (!scope) return undefined;
  const documentId = scope.documentId ?? currentPerfContext()?.documentId ?? null;
  return { ...scope, documentId };
}

/**
 * Worker startup: validates DOCSLURP_PRIVATE_MODEL_ENDPOINTS (throws on invalid
 * config), registers the audit writer, and starts a non-blocking /models probe.
 */
export function initializePrivateModelEndpoints(write: (entries: readonly PrivacyAuditEntry[]) => Promise<void>): void {
  for (const line of validatePrivateModelEndpointsAtStartup()) console.log(line);
  configurePrivateCallAudit({ write, currentScope: currentPrivacyAuditScope });
  if (getPrivateModelEndpointRegistry().endpoints.length > 0) startPrivateEndpointHealthProbe();
}

/** Inserts `privacy_audit_log` rows; shared by the run store and background jobs. */
export async function insertPrivacyAuditRows(
  sql: Sql<Record<string, unknown>>,
  entries: readonly PrivacyAuditEntry[],
): Promise<void> {
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
 * Privacy gate for background jobs that run outside a WorkflowState (graph
 * rebuilds). Same policy and audit behaviour as {@link allowHostedCall}.
 */
export async function allowHostedCallForWorkspace(
  sql: Sql<Record<string, unknown>>,
  args: { privacyMode: string; workspaceId: string; call: ProviderCallDescriptor },
): Promise<boolean> {
  if (isProviderCallAllowed(args.privacyMode, args.call)) return true;
  console.warn(`${formatPrivacyBlockLog(args.privacyMode, args.call)} workspace=${args.workspaceId}`);
  if (privacyModeAuditsBlockedCalls(args.privacyMode)) {
    try {
      await insertPrivacyAuditRows(sql, [buildBlockedPrivacyAuditEntry({ privacyMode: args.privacyMode, call: args.call, workspaceId: args.workspaceId })]);
    } catch (error) {
      console.error(`[privacy] audit write failed workspace=${args.workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return false;
}
