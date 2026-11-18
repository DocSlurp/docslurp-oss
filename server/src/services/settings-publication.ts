import { prepareModeSwitchJobs, commitIndexJobs } from "./project-indexing-mode.js";
import { resolveMaterializationPolicy } from "./materialization-policy.js";
import { enforceLiveBudgetCaps } from "./run-creation.js";
import { createHash } from "node:crypto";
import { publishProjectSettingsSchema, applyPrivateModelMode, indexConfigHash, indexConfigOf, privacyModeAllowsHosted, privateServiceModelFor, projectSettingsProjection, managedPipelineModelPaths, type ProjectRecord, type ProjectSearchSettings } from "@docslurp/shared";
import { sql } from "../db.js";
import { searchModeOfScopes } from "../lib/search-tiers.js";
import { env } from "../config.js";
import { appendAuditLog } from "./audit-log.js";
import type { RequestActor } from "../lib/request-actor.js";
import { apiKeyCanUseProject } from "../lib/api-key-project-scope.js";
import { canEditProject, getProjectAccess } from "./organizations.js";
import { getProject } from "./projects.js";
import { applyProjectChange, ConfigConflictError, planProjectChange } from "./config-change.js";
import { getProjectSearchSettings, mergeProjectSearchSettings, upsertProjectSearchSettings } from "./search-controls.js";

export class SettingsPublicationError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) { super(message); }
}
const conflict = () => new SettingsPublicationError(409, "settings_stale", "Project or search settings changed. Reload settings before saving.");
const identity = (actor: RequestActor) => actor.type === "session" ? `user:${actor.userId}` : `key:${actor.apiKey.keyId}`;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k, stable(v)]));
  return value;
}
async function authorize(actor: RequestActor, projectId: string, client = sql) {
  const access = await getProjectAccess(projectId, actor.userId, client);
  if (!access || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, { id: projectId, orgId: access.orgId }))) {
    throw new SettingsPublicationError(404, "project_not_found", "Project not found");
  }
  if (!canEditProject(access, actor.userId) || (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || actor.apiKey.oauth || !actor.apiKey.scopes.includes("projects:manage")))) {
    throw new SettingsPublicationError(403, "editor_required", "Project settings require editor access and a server key with projects:manage scope.");
  }
  if (actor.type === "apiKey") {
    const [key] = await client`select id from api_keys where id=${actor.apiKey.keyId} and user_id=${actor.userId} and org_id=${access.orgId}
      and key_type='server' and revoked_at is null and (expires_at is null or expires_at > now())
      and 'projects:manage'=any(scopes) and (cardinality(project_ids)=0 or ${projectId}=any(project_ids)) for share`;
    if (!key) throw new SettingsPublicationError(403, "key_unavailable", "The API key is no longer authorized.");
  }
  return access;
}
export async function settingsRevisions(projectId: string, client = sql) {
  const [row] = await client<{ project: string; search: string }[]>`
    select p.updated_at::text as project, coalesce(s.updated_at::text, 'absent') as search
    from projects p left join project_search_settings s on s.project_id=p.id where p.id=${projectId}`;
  if (!row) throw new SettingsPublicationError(404, "project_not_found", "Project not found");
  return row;
}
export type SettingsSnapshot = { explanations?: ReturnType<typeof projectSettingsProjection>; legacyIndexes?: { documents: number; documentIds: string[] }; project: ProjectRecord; settings: ProjectSearchSettings; revision: { project: string; search: string } };
export async function readSettingsSnapshot(actor: RequestActor, projectId: string): Promise<SettingsSnapshot> {
  return sql.begin(async tx => {
    const client = tx as unknown as typeof sql;
    await client`select pg_advisory_xact_lock(hashtextextended(${`config-change:${projectId}`}, 0))`;
    await authorize(actor, projectId, client);
    return loadSettingsSnapshot(actor, projectId, client);
  }) as Promise<SettingsSnapshot>;
}
async function loadSettingsSnapshot(actor: RequestActor, projectId: string, client: typeof sql): Promise<SettingsSnapshot> {
    const project = (await getProject(projectId, actor.userId, client))!;
    const settings = await getProjectSearchSettings(projectId, actor.userId, client);
    const revision = await settingsRevisions(projectId, client);
    const [org] = await client`select allow_china_providers, monthly_budget_cents from organizations where id=${project.orgId}`;
    const legacy = await client<{ id: string }[]>`select d.id from documents d join projects p on p.id=d.project_id
      where d.project_id=${projectId} and d.org_id=${project.orgId} and d.status='completed' and d.superseded_at is null and d.purged_at is null and d.archived_at is null
      and exists(select 1 from vector_indexes v where v.document_id=d.id)
      and d.index_config_hash is distinct from ${indexConfigHash(indexConfigOf(applyPrivateModelMode(project.pipeline)))}
      and (d.index_config_hash is null or jsonb_typeof(p.index_configs -> d.index_config_hash -> 'normalize') is distinct from 'boolean')
      order by d.id limit 101`;
    return { project, settings, revision, explanations: projectSettingsProjection({ project, settings, searchStored: revision.search !== "absent", organizationMonthlyBudgetCents: org?.monthly_budget_cents ?? null, ...(actor.type === "apiKey" ? { keyCeiling: { searchMode: searchModeOfScopes(actor.apiKey.scopes), maxOutputTokens: actor.apiKey.maxOutputTokens ?? null } } : {}), capabilities: { webEnabled: env.web.enabled && Object.values(env.web.keys).some(Boolean), webChatEnabled: env.web.chatEnabled, organizationAllowsChina: org?.allow_china_providers !== false } }), legacyIndexes: { documents: legacy.length, documentIds: legacy.slice(0,100).map(d => d.id) } };
}
/** One transaction owns the pipeline, search defaults, reservations, jobs, and retry receipt. */
export async function publishSettings(args: { actor: RequestActor; projectId: string; input: unknown; origin?: "app" | "machine" }) {
  await authorize(args.actor, args.projectId);
  const input = publishProjectSettingsSchema.parse(args.input);
  if (managedPipelineModelPaths(input.project.pipeline).length) throw new SettingsPublicationError(400, "model_not_allowed", "Model bindings are managed. Use a supported profile.");
  const actorId = identity(args.actor);
  const hash = createHash("sha256").update(JSON.stringify(stable(input))).digest("hex");
  type Receipt = { snapshot: SettingsSnapshot; requestId: string };
  async function receipt(client = sql): Promise<Receipt | null> {
    const [row] = await client<{ request_hash: string; result: Receipt }[]>`select request_hash, result from project_settings_publications where project_id=${args.projectId} and actor_id=${actorId} and request_id=${input.requestId}`;
    if (row && row.request_hash !== hash) throw new SettingsPublicationError(409, "settings_idempotency_conflict", "This request ID was already used for different settings.");
    return row?.result ?? null;
  }
  const prior = await receipt();
  if (prior) return { ...prior, replayed: true, job: null, queuedRunIds: [] as string[] };
  const { pipeline, ...project } = input.project;
  const indexingMode = pipeline?.indexingMode;
  // Execution-only controls and deferred materialization have dedicated, authorized operations.
  if (pipeline && ["restartFromStage", "stageSubset", "summaryTree"].some(k => Object.hasOwn(pipeline, k))) {
    throw new SettingsPublicationError(400, "dedicated_operation_required", "Change execution, indexing mode and section summaries through their dedicated controls.");
  }
  const plan = await planProjectChange({ projectId: args.projectId, userId: args.actor.userId, input: project, pipelineOverrides: pipeline, clearOutputSchema: input.clearOutputSchema, indexingMode, origin: args.origin });
  if (!plan) throw new SettingsPublicationError(404, "project_not_found", "Project not found");
  if (plan.rowVersion !== input.expected.project) {
    const retry = await receipt(); if (retry) return { ...retry, replayed: true, job: null, queuedRunIds: [] as string[] };
    throw conflict();
  }
  let prepared: Awaited<ReturnType<typeof prepareModeSwitchJobs>> | undefined;
  if (indexingMode && indexingMode !== plan.project.pipeline.indexingMode) {
    const resolved = await resolveMaterializationPolicy({ projectPipeline: plan.nextPipeline, apiKey: args.actor.type === "apiKey" ? args.actor.apiKey : null, projectId: args.projectId });
    if (!("policy" in resolved)) throw new SettingsPublicationError(403, "forbidden", "Materialization policy is unavailable.");
    await enforceLiveBudgetCaps(args.projectId, plan.project.orgId);
    prepared = await prepareModeSwitchJobs({ project: { ...plan.project, pipeline: { ...plan.nextPipeline, indexingMode: plan.project.pipeline.indexingMode } }, to: indexingMode, indexAll: false, actor: args.actor, policy: resolved.policy, speedBoost: project.speedBoost });
  }
  if (prepared?.batches.length && project.apply !== "reindex") throw new SettingsPublicationError(409, "settings_reprocess_consent_required", "This mode change queues existing-document work. Estimate it and explicitly confirm reprocessing.");
  let modeRunIds: string[] = [];
  let result: Receipt | undefined;
  try {
    const applied = await applyProjectChange({ plan, userId: args.actor.userId, maxAttempts: 1, updateOptions: indexingMode ? { indexingMode } : undefined,
      authorize: async client => {
        await authorize(args.actor, args.projectId, client);
        const revisions = await settingsRevisions(args.projectId, client);
        if (revisions.project !== input.expected.project || revisions.search !== input.expected.search) throw conflict();
      },
      afterSave: async client => {
        if (prepared) modeRunIds = (await commitIndexJobs(prepared, args.actor.userId, args.origin ?? "machine", client as unknown as Parameters<typeof commitIndexJobs>[3])).runIds;
        const before = await getProjectSearchSettings(args.projectId, args.actor.userId, client);
        const settings = mergeProjectSearchSettings(before, input.search);
        if (settings.retrievalDefaults.candidateDepth !== undefined && settings.retrievalDefaults.candidateDepth < settings.retrievalDefaults.resultCount) throw new SettingsPublicationError(400, "unsupported_search_settings", "Candidate depth must cover the requested result count.");
        if (!privacyModeAllowsHosted(plan.nextPipeline.privacyMode) && !privateServiceModelFor("rerank", plan.nextPipeline.privacyMode) && settings.retrievalDefaults.rerankProvider === "deepinfra") throw new SettingsPublicationError(400, "privacy_mode_violation", "Hosted model reranking is unavailable under this project's privacy policy.");
        await upsertProjectSearchSettings(settings, client);
        result = { requestId: input.requestId, snapshot: await loadSettingsSnapshot(args.actor, args.projectId, client) };
        await appendAuditLog({ orgId: result.snapshot.project.orgId, userId: args.actor.userId, projectId: args.projectId,
          apiKeyId: args.actor.type === "apiKey" ? args.actor.apiKey.keyId : null,
          action: "project.settings.published", resourceType: "project", resourceId: args.projectId,
          metadata: { requestId: input.requestId, before: input.expected, after: result.snapshot.revision } }, client);
        await client`insert into project_settings_publications(project_id,actor_id,request_id,request_hash,result) values (${args.projectId},${actorId},${input.requestId},${hash},${client.json(JSON.parse(JSON.stringify(result)))})`;
      },
    });
    if (!applied || !result) throw new SettingsPublicationError(403, "editor_required", "Project editing permission is required");
    return { ...result, replayed: false, job: applied.job, queuedRunIds: [...applied.queuedRunIds, ...modeRunIds] };
  } catch (error) {
    if (error instanceof ConfigConflictError || (error instanceof SettingsPublicationError && error.status === 409)) {
      await authorize(args.actor, args.projectId);
      const retry = await receipt(); if (retry) return { ...retry, replayed: true, job: null, queuedRunIds: [] as string[] };
      throw conflict();
    }
    throw error;
  }
}
