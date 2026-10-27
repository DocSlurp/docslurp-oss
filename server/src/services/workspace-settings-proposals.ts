import { workspaceSettingsProposalInputSchema, workspaceSettingsPipelinePatchSchema } from "./workspace-settings-proposal-input.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { analyzeSearchSettingsChange, type WorkspaceSettingsProposal, type PipelineFeatures } from "@docslurp/shared";
import { sql } from "../db.js";
import type { RequestActor } from "../lib/request-actor.js";
import { isFirstPartyAppActor } from "../lib/first-party-app.js";
import { apiKeyCanUseWorkspace } from "../lib/api-key-workspace-scope.js";
import { openSettingsProposal, sealSettingsProposal } from "../lib/settings-proposal-tokens.js";
import { mergeWorkspaceSearchSettings, getWorkspaceSearchSettings, upsertWorkspaceSearchSettings } from "./search-controls.js";
import { canEditWorkspace, getWorkspaceAccess } from "./organizations.js";
import { applyWorkspaceChange, ConfigConflictError, planWorkspaceChange, reindexTargetSignature, type WorkspaceChangePlan } from "./config-change.js";
import { appendAuditLog } from "./audit-log.js";
import { getRun } from "./runs.js";
import { runLifecycle } from "./run-lifecycle.js";

const claimsSchema = z.object({
  purpose: z.literal("workspace-settings-proposal-v1"), actor: z.string(), userId: z.string(),
  sessionId: z.string().min(1), workspaceId: z.string(), orgId: z.string(),
  changes: workspaceSettingsProposalInputSchema.shape.changes, rowVersion: z.string().nullable(),
  fingerprint: z.string(), expiresAt: z.number(),
}).strict();
export class SettingsProposalError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 410, readonly category: string, message: string) { super(message); }
}
const identity = (actor: RequestActor) => actor.type === "session"
  ? `session:${actor.userId}:${actor.sessionId}` : `key:${actor.userId}:${actor.apiKey.keyId}`;
const fail = (status: 400 | 403 | 409 | 410, category: string, message: string): never => { throw new SettingsProposalError(status, category, message); };
/**
 * Settings proposals and Apply belong to the first-party DocSlurp app only.
 * No API key (server or client), MCP token or capability token may prepare or
 * apply one, so a customer cannot hand this power to its own end users.
 */
function assertFirstPartyApp(actor: RequestActor): void {
  if (!isFirstPartyAppActor(actor)) fail(403, "settings_proposal_forbidden", "Workspace settings changes from chat are available only in the DocSlurp app");
}

async function authorize(actor: RequestActor, workspaceId: string, sessionId: string, client = sql) {
  // Rechecked under the configuration lock, like every other authorization.
  assertFirstPartyApp(actor);
  const access = await getWorkspaceAccess(workspaceId, actor.userId, client);
  if (!access || !canEditWorkspace(access, actor.userId)) return fail(403, "settings_proposal_forbidden", "Workspace editing permission is required");
  const [session] = await client<{ id: string }[]>`select id from chat_sessions where id=${sessionId} and user_id=${actor.userId} and workspace_id=${workspaceId}`;
  if (!session) return fail(403, "settings_proposal_forbidden", "The proposal must belong to your workspace conversation");
  return access;
}
function fingerprint(plan: WorkspaceChangePlan): string {
  return createHash("sha256").update(JSON.stringify({ impact: plan.impact, targets: reindexTargetSignature(plan.targets), estimate: plan.estimate })).digest("hex");
}
const PIPELINE_LABELS: Record<string, string> = {
  "mediaVideo.enabled": "Video frame analysis",
  "vision.forceAllPages": "Read every page with vision",
  "vision.maxPagesPerDocument": "Vision pages per file",
};
function changedValues(before: PipelineFeatures, after: PipelineFeatures, patch: z.infer<typeof workspaceSettingsPipelinePatchSchema>) {
  return Object.entries(patch).flatMap(([key, value]) => {
    const old = before[key as keyof PipelineFeatures], next = after[key as keyof PipelineFeatures];
    if (value && typeof value === "object") return Object.keys(value).map(child => ({
      key: `pipeline.${key}.${child}`, label: PIPELINE_LABELS[`${key}.${child}`] ?? `${key}.${child}`,
      before: (old as Record<string, unknown> | undefined)?.[child] ?? null, after: (next as Record<string, unknown>)[child],
    }));
    return [{ key: `pipeline.${key}`, label: key.replace(/([A-Z])/g, " $1"), before: old ?? null, after: next }];
  }).filter(change => JSON.stringify(change.before) !== JSON.stringify(change.after));
}
/** Answer and retrieval changes need different wording from pipeline changes: none of them touches stored documents. */
export function searchSettingsReasons(changes: z.infer<typeof claimsSchema>["changes"]): Array<{ field: string; effect: string }> {
  const chat = Object.keys(changes.chat ?? {}).map(key => ({ field: `chat.${key}`, effect: CHAT_EFFECTS[key] ?? CHAT_DEFAULT_EFFECT }));
  const retrieval = Object.keys(changes.retrieval ?? {}).map(key => ({ field: `retrieval.${key}`, effect: RETRIEVAL_EFFECT }));
  return [...chat, ...retrieval];
}
const CHAT_DEFAULT_EFFECT = "Changes how chat answers are written and cited. Applies from the next chat message; no documents are reprocessed.";
const CHAT_EFFECTS: Record<string, string> = {
  enabled: "Turns chat on or off for this workspace. Applies from the next chat message; no documents are reprocessed.",
  mode: "Changes what context chat reads before answering. Applies from the next chat message; no documents are reprocessed.",
  searchInstructions: "Changes the instructions chat follows when it searches and answers. Applies from the next chat message; no documents are reprocessed.",
};
const RETRIEVAL_EFFECT = "Changes how searches rank and return passages. Applies to the next search; no documents are reprocessed.";
async function plan(actor: RequestActor, workspaceId: string, changes: z.infer<typeof claimsSchema>["changes"]) {
  // The planner versions and loads one base snapshot before merging the proposal.
  const config = await planWorkspaceChange({ workspaceId, userId: actor.userId, input: { apply: "reindex" }, pipelineOverrides: changes.pipeline });
  if (!config || (actor.type === "apiKey" && !apiKeyCanUseWorkspace(actor.apiKey, config.workspace))) return fail(403, "settings_proposal_forbidden", "Workspace is unavailable");
  const searchBefore = await getWorkspaceSearchSettings(workspaceId, actor.userId);
  const searchAfter = mergeWorkspaceSearchSettings(searchBefore, {
    ...(changes.chat ? { chat: changes.chat } : {}), ...(changes.retrieval ? { retrievalDefaults: changes.retrieval } : {}),
  });
  const searchImpact = analyzeSearchSettingsChange(searchBefore, searchAfter);
  const searchReasons = searchImpact.kind === "none" ? [] : searchSettingsReasons(changes);
  const impact = config.impact.kind === "none" ? { ...searchImpact, reasons: searchReasons } : { ...config.impact, reasons: [...config.impact.reasons, ...searchReasons] };
  const digest = createHash("sha256").update(JSON.stringify({ config: fingerprint(config), searchBefore, searchAfter })).digest("hex");
  return { config, searchBefore, searchAfter, impact, digest };
}
const LABELS: Record<string, string> = { enabled: "Chat enabled", mode: "Chat context mode", answerStyle: "Answer style", citations: "Citations", searchInstructions: "Chat instructions", resultCount: "Search result count", useRerank: "Search reranking", useMmr: "Diversify search results", mmrLambda: "Search diversity balance", candidateDepth: "Search candidate depth", resultOrder: "Search result order" };
function searchChanges(planned: Awaited<ReturnType<typeof plan>>, changes: z.infer<typeof claimsSchema>["changes"]) {
  return (["chat", "retrieval"] as const).flatMap(group => Object.keys(changes[group] ?? {}).map(key => {
    const field = group === "retrieval" ? "retrievalDefaults" : "chat";
    return { key: `${group}.${key}`, label: LABELS[key] ?? key,
      before: (planned.searchBefore[field] as Record<string, unknown>)[key] ?? null,
      after: (planned.searchAfter[field] as Record<string, unknown>)[key] ?? null };
  })).filter(change => JSON.stringify(change.before) !== JSON.stringify(change.after));
}
export async function proposeWorkspaceSettings(args: { actor: RequestActor; workspaceId: string; sessionId: string; changes: unknown; now?: number }): Promise<WorkspaceSettingsProposal> {
  assertFirstPartyApp(args.actor);
  const changes = workspaceSettingsProposalInputSchema.shape.changes.parse(args.changes);
  const access = await authorize(args.actor, args.workspaceId, args.sessionId);
  const proposed = await plan(args.actor, args.workspaceId, changes);
  const changed = [...changedValues(proposed.config.workspace.pipeline, proposed.config.nextPipeline, changes.pipeline ?? {}), ...searchChanges(proposed, changes)];
  if (!changed.length) return fail(400, "settings_proposal_unchanged", "Those settings are already in effect");
  const expiresAt = (args.now ?? Date.now()) + 10 * 60_000;
  const token = sealSettingsProposal({ purpose: "workspace-settings-proposal-v1", actor: identity(args.actor), userId: args.actor.userId,
    sessionId: args.sessionId, workspaceId: args.workspaceId, orgId: access.orgId, changes,
    rowVersion: proposed.config.rowVersion, fingerprint: proposed.digest, expiresAt });
  return { token, workspaceId: args.workspaceId, expiresAt: new Date(expiresAt).toISOString(),
    changes: changed, before: Object.fromEntries(changed.map(c => [c.key, c.before])), after: Object.fromEntries(changed.map(c => [c.key, c.after])),
    impact: proposed.impact, estimate: proposed.config.estimate,
    reprocessAvailable: proposed.config.reindex !== null && proposed.config.targets.length > 0,
    reprocessRequired: proposed.config.reindex === "required" && proposed.config.targets.length > 0 };
}
export async function applySettingsProposal(args: { actor: RequestActor; workspaceId: string; token: string; reprocessExisting: boolean; now?: number }) {
  assertFirstPartyApp(args.actor);
  const parsed = claimsSchema.safeParse(openSettingsProposal(args.token));
  if (!parsed.success) return fail(403, "settings_proposal_invalid", "Invalid settings proposal");
  const claims = parsed.data;
  if (claims.expiresAt <= (args.now ?? Date.now())) return fail(410, "settings_proposal_expired", "This proposal expired; request a fresh proposal");
  if (claims.actor !== identity(args.actor) || claims.userId !== args.actor.userId || claims.workspaceId !== args.workspaceId) return fail(403, "settings_proposal_invalid", "This proposal belongs to another actor or workspace");
  const access = await authorize(args.actor, args.workspaceId, claims.sessionId);
  if (access.orgId !== claims.orgId) return fail(403, "settings_proposal_invalid", "Workspace organization changed");
  const prepared = await plan(args.actor, args.workspaceId, claims.changes);
  const planned = prepared.config;
  if (planned.rowVersion !== claims.rowVersion || prepared.digest !== claims.fingerprint) return fail(409, "settings_proposal_stale", "Settings or affected work changed; request a fresh proposal");
  if (planned.reindex === "required" && planned.targets.length && !args.reprocessExisting) return fail(409, "reprocess_consent_required", "This change requires explicit consent to reprocess existing documents");
  if (args.reprocessExisting && (!planned.reindex || !planned.targets.length)) return fail(400, "reprocess_unavailable", "This proposal does not include existing-document reprocessing");
  if (!args.reprocessExisting) { planned.input = { ...planned.input, apply: "new-uploads" }; planned.willReindex = false; }
  let applied;
  try {
    applied = await applyWorkspaceChange({ plan: planned, userId: args.actor.userId, maxAttempts: 1,
      authorize: async client => {
        await authorize(args.actor, args.workspaceId, claims.sessionId, client);
        await client`select workspace_id from workspace_search_settings where workspace_id=${args.workspaceId} for update`;
        const currentSearch = await getWorkspaceSearchSettings(args.workspaceId, args.actor.userId, client);
        if (JSON.stringify(currentSearch) !== JSON.stringify(prepared.searchBefore)) return fail(409, "settings_proposal_stale", "Search settings changed; request a fresh proposal");
      },
      afterSave: async client => {
        if (claims.changes.chat || claims.changes.retrieval) await upsertWorkspaceSearchSettings(prepared.searchAfter, client);
        await appendAuditLog({ orgId: claims.orgId, userId: args.actor.userId, workspaceId: args.workspaceId,
          action: "workspace.updated", resourceType: "workspace", resourceId: args.workspaceId,
          apiKeyId: args.actor.type === "apiKey" ? args.actor.apiKey.keyId : null,
          metadata: { source: "chat-settings-proposal", sessionId: claims.sessionId, changes: claims.changes, reprocessExisting: args.reprocessExisting } }, client);
      },
      ...(args.reprocessExisting ? { expectedTargetSignature: reindexTargetSignature(planned.targets) } : {}) });
  } catch (error) {
    if (error instanceof ConfigConflictError) return fail(409, "settings_proposal_stale", "Settings or affected work changed; request a fresh proposal");
    throw error;
  }
  if (!applied) return fail(403, "settings_proposal_forbidden", "Workspace editing permission is required");
  for (const runId of applied.queuedRunIds) {
    try { const run = await getRun(runId, args.actor.userId); if (run) await runLifecycle.start(run); }
    catch { console.warn("[settings-proposal] run start deferred to recovery"); }
  }
  return { applied: true as const, workspaceId: args.workspaceId, reprocess: {
    requested: args.reprocessExisting, status: !args.reprocessExisting ? "not-requested" as const
      : applied.queuedRunIds.length ? "queued" as const : "blocked" as const,
    ...(applied.job ? { jobId: applied.job.id } : {}) } };
}
