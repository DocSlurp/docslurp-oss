import { resolveLegacyQualityPatch, projectSettingsProposalInputSchema, projectSettingsPipelinePatchSchema } from "./project-settings-proposal-input.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { EDITOR_REQUIRED_CODE, EDITOR_REQUIRED_MESSAGE, analyzeSearchSettingsChange, type ProjectSettingsProposal, type PipelineFeatures } from "@docslurp/shared";
import { sql } from "../db.js";
import type { RequestActor } from "../lib/request-actor.js";
import { isFirstPartyAppActor } from "../lib/first-party-app.js";
import { apiKeyCanUseProject } from "../lib/api-key-project-scope.js";
import { openSettingsProposal, sealSettingsProposal } from "../lib/settings-proposal-tokens.js";
import { mergeProjectSearchSettings, getProjectSearchSettings, upsertProjectSearchSettings } from "./search-controls.js";
import { canEditProject, getProjectAccess } from "./organizations.js";
import { ChartExportUnavailableError } from "./chart-export-availability.js";
import { applyProjectChange, ConfigConflictError, planProjectChange, reindexTargetSignature, type ProjectChangePlan } from "./config-change.js";
import { appendAuditLog } from "./audit-log.js";
import { getRun } from "./runs.js";
import { runLifecycle } from "./run-lifecycle.js";

const claimsSchema = z.object({
  purpose: z.literal("project-settings-proposal-v1"), actor: z.string(), userId: z.string(),
  sessionId: z.string().min(1), projectId: z.string(), orgId: z.string(),
  changes: projectSettingsProposalInputSchema.shape.changes, rowVersion: z.string().nullable(),
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
  if (!isFirstPartyAppActor(actor)) fail(403, "settings_proposal_forbidden", "Project settings changes from chat are available only in the DocSlurp app");
}

async function authorize(actor: RequestActor, projectId: string, sessionId: string, client = sql) {
  // Rechecked under the configuration lock, like every other authorization.
  assertFirstPartyApp(actor);
  const access = await getProjectAccess(projectId, actor.userId, client);
  if (!access || !canEditProject(access, actor.userId)) return fail(403, EDITOR_REQUIRED_CODE, EDITOR_REQUIRED_MESSAGE);
  const [session] = await client<{ id: string }[]>`select id from chat_sessions where id=${sessionId} and user_id=${actor.userId} and project_id=${projectId}`;
  if (!session) return fail(403, "settings_proposal_forbidden", "The proposal must belong to your project conversation");
  return access;
}
function fingerprint(plan: ProjectChangePlan): string {
  return createHash("sha256").update(JSON.stringify({ impact: plan.impact, targets: reindexTargetSignature(plan.targets), estimate: plan.estimate })).digest("hex");
}
const PIPELINE_LABELS: Record<string, string> = {
  "mediaVideo.enabled": "Video frame analysis",
  quality: "Processing quality",
  "chartExport.tier": "Chart and diagram export",
  figures: "Figure extraction",
  "chartExport.formats": "Chart export formats",
  "chartExport.diagrams": "Export diagrams",
  figureResume: "Finish missing figures automatically",
};
function changedValues(before: PipelineFeatures, after: PipelineFeatures, patch: z.infer<typeof projectSettingsPipelinePatchSchema>) {
  return Object.entries(patch).flatMap(([key, value]) => {
    const old = before[key as keyof PipelineFeatures], next = after[key as keyof PipelineFeatures];
    if (value && typeof value === "object") return Object.keys(value).map(child => ({
      key: `pipeline.${key}.${child}`, label: PIPELINE_LABELS[`${key}.${child}`] ?? `${key}.${child}`,
      before: (old as Record<string, unknown> | undefined)?.[child] ?? null, after: (next as Record<string, unknown>)[child],
    }));
    return [{ key: `pipeline.${key}`, label: PIPELINE_LABELS[key] ?? key.replace(/([A-Z])/g, " $1"), before: old ?? null, after: next }];
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
  enabled: "Turns chat on or off for this project. Applies from the next chat message; no documents are reprocessed.",
  mode: "Changes what context chat reads before answering. Applies from the next chat message; no documents are reprocessed.",
  searchInstructions: "Changes the instructions chat follows when it searches and answers. Applies from the next chat message; no documents are reprocessed.",
};
const RETRIEVAL_EFFECT = "Changes how searches rank and return passages. Applies to the next search; no documents are reprocessed.";
async function plan(actor: RequestActor, projectId: string, changes: z.infer<typeof claimsSchema>["changes"]) {
  // The planner versions and loads one base snapshot before merging the proposal.
  let config: Awaited<ReturnType<typeof planProjectChange>>;
  try {
    config = await planProjectChange({ projectId, userId: actor.userId, input: { apply: "reindex" }, pipelineOverrides: changes.pipeline, origin: "app" });
  } catch (error) {
    if (error instanceof ChartExportUnavailableError) return fail(400, error.code, error.message);
    throw error;
  }
  if (!config || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, config.project))) return fail(403, "settings_proposal_forbidden", "Project is unavailable");
  const searchBefore = await getProjectSearchSettings(projectId, actor.userId);
  const searchAfter = mergeProjectSearchSettings(searchBefore, {
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
export async function proposeProjectSettings(args: { actor: RequestActor; projectId: string; sessionId: string; changes: unknown; now?: number }): Promise<ProjectSettingsProposal> {
  assertFirstPartyApp(args.actor);
  let changes = projectSettingsProposalInputSchema.shape.changes.parse(args.changes);
  const access = await authorize(args.actor, args.projectId, args.sessionId);
  let proposed = await plan(args.actor, args.projectId, changes);
  // A retired `vision: { forceAllPages: false }` means Auto on a Good project; re-plan with it so the token
  // seals the resolved change.
  const rawPipeline = (args.changes as { pipeline?: unknown } | null | undefined)?.pipeline;
  const resolvedPipeline = resolveLegacyQualityPatch(changes.pipeline ?? {}, rawPipeline, proposed.config.project.pipeline.quality);
  if (resolvedPipeline.quality !== changes.pipeline?.quality) {
    changes = { ...changes, pipeline: resolvedPipeline };
    proposed = await plan(args.actor, args.projectId, changes);
  }
  const changed = [...changedValues(proposed.config.project.pipeline, proposed.config.nextPipeline, changes.pipeline ?? {}), ...searchChanges(proposed, changes)];
  if (!changed.length) return fail(400, "settings_proposal_unchanged", "Those settings are already in effect");
  const expiresAt = (args.now ?? Date.now()) + 10 * 60_000;
  const token = sealSettingsProposal({ purpose: "project-settings-proposal-v1", actor: identity(args.actor), userId: args.actor.userId,
    sessionId: args.sessionId, projectId: args.projectId, orgId: access.orgId, changes,
    rowVersion: proposed.config.rowVersion, fingerprint: proposed.digest, expiresAt });
  return { token, projectId: args.projectId, expiresAt: new Date(expiresAt).toISOString(),
    changes: changed, before: Object.fromEntries(changed.map(c => [c.key, c.before])), after: Object.fromEntries(changed.map(c => [c.key, c.after])),
    impact: proposed.impact, estimate: proposed.config.estimate,
    reprocessAvailable: proposed.config.reindex !== null && proposed.config.targets.length > 0,
    reprocessRequired: proposed.config.reindex === "required" && proposed.config.targets.length > 0 };
}
export async function applySettingsProposal(args: { actor: RequestActor; projectId: string; token: string; reprocessExisting: boolean; now?: number }) {
  assertFirstPartyApp(args.actor);
  const parsed = claimsSchema.safeParse(openSettingsProposal(args.token));
  if (!parsed.success) return fail(403, "settings_proposal_invalid", "Invalid settings proposal");
  const claims = parsed.data;
  if (claims.expiresAt <= (args.now ?? Date.now())) return fail(410, "settings_proposal_expired", "This proposal expired; request a fresh proposal");
  if (claims.actor !== identity(args.actor) || claims.userId !== args.actor.userId || claims.projectId !== args.projectId) return fail(403, "settings_proposal_invalid", "This proposal belongs to another actor or project");
  const access = await authorize(args.actor, args.projectId, claims.sessionId);
  if (access.orgId !== claims.orgId) return fail(403, "settings_proposal_invalid", "Project organization changed");
  const prepared = await plan(args.actor, args.projectId, claims.changes);
  const planned = prepared.config;
  if (planned.rowVersion !== claims.rowVersion || prepared.digest !== claims.fingerprint) return fail(409, "settings_proposal_stale", "Settings or affected work changed; request a fresh proposal");
  if (planned.reindex === "required" && planned.targets.length && !args.reprocessExisting) return fail(409, "reprocess_consent_required", "This change requires explicit consent to reprocess existing documents");
  if (args.reprocessExisting && (!planned.reindex || !planned.targets.length)) return fail(400, "reprocess_unavailable", "This proposal does not include existing-document reprocessing");
  if (!args.reprocessExisting) { planned.input = { ...planned.input, apply: "new-uploads" }; planned.willReindex = false; }
  let applied;
  try {
    applied = await applyProjectChange({ plan: planned, userId: args.actor.userId, maxAttempts: 1,
      authorize: async client => {
        await authorize(args.actor, args.projectId, claims.sessionId, client);
        await client`select project_id from project_search_settings where project_id=${args.projectId} for update`;
        const currentSearch = await getProjectSearchSettings(args.projectId, args.actor.userId, client);
        if (JSON.stringify(currentSearch) !== JSON.stringify(prepared.searchBefore)) return fail(409, "settings_proposal_stale", "Search settings changed; request a fresh proposal");
      },
      afterSave: async client => {
        if (claims.changes.chat || claims.changes.retrieval) await upsertProjectSearchSettings(prepared.searchAfter, client);
        await appendAuditLog({ orgId: claims.orgId, userId: args.actor.userId, projectId: args.projectId,
          action: "project.updated", resourceType: "project", resourceId: args.projectId,
          apiKeyId: args.actor.type === "apiKey" ? args.actor.apiKey.keyId : null,
          metadata: { source: "chat-settings-proposal", sessionId: claims.sessionId, changes: claims.changes, reprocessExisting: args.reprocessExisting } }, client);
      },
      ...(args.reprocessExisting ? { expectedTargetSignature: reindexTargetSignature(planned.targets) } : {}) });
  } catch (error) {
    if (error instanceof ConfigConflictError) return fail(409, "settings_proposal_stale", "Settings or affected work changed; request a fresh proposal");
    throw error;
  }
  if (!applied) return fail(403, "settings_proposal_forbidden", "Project editing permission is required");
  for (const runId of applied.queuedRunIds) {
    try { const run = await getRun(runId, args.actor.userId); if (run) await runLifecycle.start(run); }
    catch { console.warn("[settings-proposal] run start deferred to recovery"); }
  }
  return { applied: true as const, projectId: args.projectId, reprocess: {
    requested: args.reprocessExisting, status: !args.reprocessExisting ? "not-requested" as const
      : applied.queuedRunIds.length ? "queued" as const : "blocked" as const,
    ...(applied.job ? { jobId: applied.job.id } : {}) } };
}
