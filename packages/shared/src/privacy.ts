import { inferModelTarget, isLocalModelProvider, type ModelTarget } from "./embedding.js";
import {
  createPrivateEndpointFetch,
  isPrivateModelUri,
  lookupPrivateModelRoute,
  privateEndpointAuthHeaders,
  privateEndpointCallCost,
  PRIVATE_MODEL_PROVIDER,
  PrivateEndpointResolutionError,
  type PrivateEndpointCost,
  type PrivateModelCapability,
  type PrivateModelRoute,
} from "./private-endpoints.js";

/**
 * Workspace privacy execution modes (`pipeline.privacyMode`).
 *
 * - `standard`: hosted model providers (OpenRouter, OpenAI, Anthropic, ...) may
 *   receive document content and queries.
 * - `local-only`: no workspace content, page image, query or audio may be sent to
 *   a hosted/remote AI provider. LLM, vision, embedding, rerank and
 *   speech-to-text calls must use local runtimes (transformers.js, ONNX,
 *   Florence local-cli, or loopback ollama/vLLM/LM Studio servers). Optional
 *   stages that only have a hosted route are skipped; required work with no
 *   local route fails with {@link PrivacyModeViolationError}.
 * - `strict-privacy`: identical call policy to `local-only`, and every blocked
 *   hosted attempt is also written to `privacy_audit_log` so operators can prove
 *   no content left the deployment. The codebase defines no zero-retention
 *   provider tier, so strict-privacy never relaxes the local-only rule.
 *
 * Both non-standard modes also allow operator-registered private endpoints
 * (`llm://private/<alias>/<model>`, target `private`; see private-endpoints.ts).
 * Under strict-privacy every allowed private call writes a `privacy_audit_log`
 * row before the request is sent, so operators can prove where content went.
 *
 * Unknown modes fail closed (treated as non-standard).
 */
export interface ProviderCallDescriptor {
  /** Provider host label, e.g. `openrouter`, `openai`, `transformers.js`, `ollama`. */
  provider: string;
  /** Model id as sent to the provider. */
  model: string;
  /** Logical operation, e.g. `worker.text.document-summary` or `app.search.hyde`. */
  operation: string;
  /** Declared target from a validated model config, when available. */
  target?: ModelTarget;
  /** `llm://provider/model` route, when available. */
  modelUri?: string;
  /** Required for private endpoint calls: the registry is checked per capability. */
  capability?: PrivateModelCapability;
  /** URL the client will call; private calls fail closed unless it matches the registry. */
  baseUrl?: string | null;
}

/** `standard` (or an unset mode, which defaults to standard) allows hosted providers. */
export function privacyModeAllowsHosted(mode: string | null | undefined): boolean {
  return mode === undefined || mode === null || mode === "standard";
}

/** strict-privacy records every blocked hosted attempt in `privacy_audit_log`. */
export function privacyModeAuditsBlockedCalls(mode: string | null | undefined): boolean {
  return mode === "strict-privacy";
}

/** strict-privacy writes one audit row per allowed private endpoint call. */
export function privacyModeAuditsPrivateCalls(mode: string | null | undefined): boolean {
  return mode === "strict-privacy";
}

function isPrivateCall(call: Pick<ProviderCallDescriptor, "provider" | "modelUri">): boolean {
  return call.provider.trim().toLowerCase() === PRIVATE_MODEL_PROVIDER || isPrivateModelUri(call.modelUri);
}

/**
 * Classifies a call. Private: provider `private` whose alias, model and
 * capability resolve in the operator registry and whose URL (if given) matches.
 * Local: every signal agrees on a local provider. Anything else is hosted, so
 * an unregistered or mismatched private route is blocked like a hosted one.
 */
export function resolveProviderTarget(
  call: Pick<ProviderCallDescriptor, "provider" | "target" | "modelUri"> & Partial<Pick<ProviderCallDescriptor, "model" | "capability" | "baseUrl">>,
): ModelTarget {
  if (call.target === "hosted") return "hosted";
  if (isPrivateCall(call)) {
    if (call.target === "local" || !call.capability) return "hosted";
    const ref = call.modelUri ?? call.model;
    if (!ref) return "hosted";
    if (call.modelUri && call.model && !isPrivateModelUri(call.model) && !call.modelUri.endsWith(`/${call.model}`)) return "hosted";
    return lookupPrivateModelRoute({ ref, capability: call.capability, baseUrl: call.baseUrl }).ok ? "private" : "hosted";
  }
  if (call.target === "private") return "hosted";
  if (!isLocalModelProvider(call.provider)) return "hosted";
  if (call.modelUri) {
    try {
      if (inferModelTarget(call.modelUri) !== "local") return "hosted";
    } catch {
      return "hosted";
    }
  }
  return "local";
}

export function isProviderCallAllowed(
  mode: string | null | undefined,
  call: Parameters<typeof resolveProviderTarget>[0],
): boolean {
  return privacyModeAllowsHosted(mode) || resolveProviderTarget(call) !== "hosted";
}

export class PrivacyModeViolationError extends Error {
  readonly code = "PRIVACY_MODE_VIOLATION";
  constructor(
    readonly privacyMode: string,
    readonly call: ProviderCallDescriptor,
  ) {
    super(
      `Workspace privacy mode '${privacyMode}' blocks hosted AI call ${call.operation} ` +
        `(${call.provider}/${call.model}); configure a local model route or switch the workspace to standard.`,
    );
    this.name = "PrivacyModeViolationError";
  }
}

export function isPrivacyModeViolation(error: unknown): error is PrivacyModeViolationError {
  return error instanceof PrivacyModeViolationError
    || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "PRIVACY_MODE_VIOLATION");
}

/** Fail-closed guard placed directly in front of every hosted AI client call. */
export function assertProviderAllowed(
  mode: string | null | undefined,
  call: ProviderCallDescriptor,
): void {
  if (!isProviderCallAllowed(mode, call)) {
    throw new PrivacyModeViolationError(String(mode), call);
  }
}

/** Row shape for `privacy_audit_log`. `endpoint` is prefixed `blocked:` because the call never left. */
export interface PrivacyAuditEntry {
  workspaceId: string | null;
  runId: string | null;
  documentId: string | null;
  modelId: string;
  endpoint: string;
  privacyMode: string;
}

export function buildBlockedPrivacyAuditEntry(args: {
  privacyMode: string;
  call: ProviderCallDescriptor;
  workspaceId?: string | null;
  runId?: string | null;
  documentId?: string | null;
}): PrivacyAuditEntry {
  return {
    workspaceId: args.workspaceId ?? null,
    runId: args.runId ?? null,
    documentId: args.documentId ?? null,
    modelId: `${args.call.provider}/${args.call.model}`.slice(0, 400),
    endpoint: `blocked:${args.call.operation}`,
    privacyMode: args.privacyMode,
  };
}

/** Console line for blocked calls, mirroring the `[ai-usage]` convention. */
export function formatPrivacyBlockLog(mode: string, call: ProviderCallDescriptor): string {
  return `[privacy] blocked operation=${call.operation} provider=${call.provider} model=${call.model} privacy_mode=${mode}`;
}

// ---------------------------------------------------------------------------
// Private endpoint calls
// ---------------------------------------------------------------------------

/** Who a private call is attributed to in `privacy_audit_log`. */
export interface PrivateCallAuditScope {
  workspaceId?: string | null;
  runId?: string | null;
  documentId?: string | null;
}

export interface PrivateCallAuditConfig {
  /** Persists audit rows; a rejection refuses the call. */
  write(entries: readonly PrivacyAuditEntry[]): Promise<void>;
  /** Ambient scope (e.g. the worker's current run), used when a call passes none. */
  currentScope?(): PrivateCallAuditScope | undefined;
}

let privateCallAudit: PrivateCallAuditConfig | undefined;

/** Registered once per process (worker and app startup). */
export function configurePrivateCallAudit(config: PrivateCallAuditConfig | undefined): void {
  privateCallAudit = config;
}

/** Row for an allowed private call: `endpoint` is `private:<alias>:<operation>`. */
export function buildAllowedPrivateAuditEntry(args: {
  privacyMode: string;
  route: Pick<PrivateModelRoute, "alias" | "model">;
  operation: string;
  scope: PrivateCallAuditScope;
}): PrivacyAuditEntry {
  return {
    workspaceId: args.scope.workspaceId ?? null,
    runId: args.scope.runId ?? null,
    documentId: args.scope.documentId ?? null,
    modelId: `private/${args.route.alias}/${args.route.model.id}`.slice(0, 400),
    endpoint: `private:${args.route.alias}:${args.operation}`.slice(0, 400),
    privacyMode: args.privacyMode,
  };
}

export interface AuthorizedPrivateCall {
  route: PrivateModelRoute;
  /** Model id to send to the server. */
  model: string;
  baseUrl: string;
  /** Fetch bound to the registered URL, with the operator auth header. */
  fetch: typeof fetch;
  /** Usage-ledger provider label. */
  provider: typeof PRIVATE_MODEL_PROVIDER;
  /** Usage-ledger model label: `<alias>/<model>`. */
  usageModel: string;
  cost(args: { inputTokens?: number | null; outputTokens?: number | null; durationMs?: number | null }): PrivateEndpointCost;
}

/**
 * The single gate in front of every private endpoint request: resolves the
 * route in the operator registry (fail closed), checks the privacy mode, binds
 * auth, and under strict-privacy writes the audit row before returning. Call
 * once per outbound request.
 */
export async function authorizePrivateModelCall(args: {
  privacyMode: string | null | undefined;
  modelUri: string;
  capability: PrivateModelCapability;
  operation: string;
  auditScope?: PrivateCallAuditScope;
  baseFetch?: typeof fetch;
}): Promise<AuthorizedPrivateCall> {
  const mode = args.privacyMode ?? "standard";
  const descriptor: ProviderCallDescriptor = {
    provider: PRIVATE_MODEL_PROVIDER,
    model: args.modelUri,
    modelUri: args.modelUri,
    operation: args.operation,
    capability: args.capability,
  };
  const lookup = lookupPrivateModelRoute({ ref: args.modelUri, capability: args.capability });
  if (!lookup.ok) {
    if (!privacyModeAllowsHosted(mode)) {
      console.warn(`${formatPrivacyBlockLog(mode, descriptor)} reason=${JSON.stringify(lookup.reason)}`);
      throw new PrivacyModeViolationError(mode, descriptor);
    }
    throw new PrivateEndpointResolutionError(lookup.reason);
  }
  const route = lookup.route;
  // Resolve credentials before auditing so a missing token never logs a call that cannot happen.
  privateEndpointAuthHeaders(route.endpoint);
  const boundFetch = createPrivateEndpointFetch(route, { baseFetch: args.baseFetch, chatTemplateKwargs: route.model.chatTemplateKwargs });
  const scope = { ...privateCallAudit?.currentScope?.(), ...stripUndefined(args.auditScope) };
  if (privacyModeAuditsPrivateCalls(mode)) {
    if (!privateCallAudit) {
      throw new PrivacyModeViolationError(mode, { ...descriptor, operation: `${args.operation} (no audit sink configured)` });
    }
    if (!scope.workspaceId) {
      throw new PrivacyModeViolationError(mode, { ...descriptor, operation: `${args.operation} (no workspace audit scope)` });
    }
    // Proof first: if the row cannot be written the content is not sent.
    await privateCallAudit.write([buildAllowedPrivateAuditEntry({ privacyMode: mode, route, operation: args.operation, scope })]);
  }
  console.log(
    `[privacy] private-call operation=${args.operation} alias=${route.alias} model=${route.model.id} ` +
      `capability=${args.capability} privacy_mode=${mode} workspace=${scope.workspaceId ?? "-"}`,
  );
  return {
    route,
    model: route.model.id,
    baseUrl: route.baseUrl,
    fetch: boundFetch,
    provider: PRIVATE_MODEL_PROVIDER,
    usageModel: `${route.alias}/${route.model.id}`,
    cost: (usage) => privateEndpointCallCost({ route, ...usage }),
  };
}

function stripUndefined(scope: PrivateCallAuditScope | undefined): PrivateCallAuditScope {
  if (!scope) return {};
  return Object.fromEntries(Object.entries(scope).filter(([, value]) => value !== undefined && value !== null)) as PrivateCallAuditScope;
}

/**
 * Descriptor for a text-generation call whose model is either an OpenRouter id
 * (hosted) or an `llm://private/<alias>/<model>` route (private).
 */
export function textModelCallDescriptor(operation: string, model: string): ProviderCallDescriptor {
  return isPrivateModelUri(model)
    ? { provider: PRIVATE_MODEL_PROVIDER, model, modelUri: model, operation, capability: "text" }
    : { provider: "openrouter", model, operation, target: "hosted" };
}
