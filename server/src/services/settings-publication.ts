import { createHash } from "node:crypto";
import { publishProjectSettingsSchema, managedPipelineModelPaths, type ProjectRecord, type ProjectSearchSettings } from "@docslurp/shared";
import { sql } from "../db.js";
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
export type SettingsSnapshot = { project: ProjectRecord; settings: ProjectSearchSettings; revision: { project: string; search: string } };
export async function readSettingsSnapshot(actor: RequestActor, projectId: string): Promise<SettingsSnapshot> {
  return sql.begin(async tx => {
    const client = tx as unknown as typeof sql;
    await client`select pg_advisory_xact_lock(hashtextextended(${`config-change:${projectId}`}, 0))`;
    await authorize(actor, projectId, client);
    return { project: (await getProject(projectId, actor.userId, client))!, settings: await getProjectSearchSettings(projectId, actor.userId, client), revision: await settingsRevisions(projectId, client) };
  }) as Promise<SettingsSnapshot>;
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
    if (row && row.request_hash !== hash) throw new SettingsPublicationError(409, "idempotency_conflict", "This request ID was already used for different settings.");
    return row?.result ?? null;
  }
  const prior = await receipt();
  if (prior) return { ...prior, replayed: true, job: null, queuedRunIds: [] as string[] };
  const { pipeline, ...project } = input.project;
  // Execution-only controls and deferred materialization have dedicated, authorized operations.
  if (pipeline && ["restartFromStage", "stageSubset", "indexingMode", "summaryTree"].some(k => Object.hasOwn(pipeline, k))) {
    throw new SettingsPublicationError(400, "dedicated_operation_required", "Change execution, indexing mode and section summaries through their dedicated controls.");
  }
  const plan = await planProjectChange({ projectId: args.projectId, userId: args.actor.userId, input: project, pipelineOverrides: pipeline, origin: args.origin });
  if (!plan) throw new SettingsPublicationError(404, "project_not_found", "Project not found");
  if (plan.rowVersion !== input.expected.project) {
    const retry = await receipt(); if (retry) return { ...retry, replayed: true, job: null, queuedRunIds: [] as string[] };
    throw conflict();
  }
  let result: Receipt | undefined;
  try {
    const applied = await applyProjectChange({ plan, userId: args.actor.userId, maxAttempts: 1,
      authorize: async client => {
        await authorize(args.actor, args.projectId, client);
        const revisions = await settingsRevisions(args.projectId, client);
        if (revisions.project !== input.expected.project || revisions.search !== input.expected.search) throw conflict();
      },
      afterSave: async client => {
        const before = await getProjectSearchSettings(args.projectId, args.actor.userId, client);
        const settings = mergeProjectSearchSettings(before, input.search);
        await upsertProjectSearchSettings(settings, client);
        result = { requestId: input.requestId, snapshot: { project: (await getProject(args.projectId, args.actor.userId, client))!, settings, revision: await settingsRevisions(args.projectId, client) } };
        await appendAuditLog({ orgId: result.snapshot.project.orgId, userId: args.actor.userId, projectId: args.projectId,
          apiKeyId: args.actor.type === "apiKey" ? args.actor.apiKey.keyId : null,
          action: "project.settings.published", resourceType: "project", resourceId: args.projectId,
          metadata: { requestId: input.requestId, before: input.expected, after: result.snapshot.revision } }, client);
        await client`insert into project_settings_publications(project_id,actor_id,request_id,request_hash,result) values (${args.projectId},${actorId},${input.requestId},${hash},${client.json(JSON.parse(JSON.stringify(result)))})`;
      },
    });
    if (!applied || !result) throw new SettingsPublicationError(403, "editor_required", "Project editing permission is required");
    return { ...result, replayed: false, job: applied.job, queuedRunIds: applied.queuedRunIds };
  } catch (error) {
    if (error instanceof ConfigConflictError || (error instanceof SettingsPublicationError && error.status === 409)) {
      await authorize(args.actor, args.projectId);
      const retry = await receipt(); if (retry) return { ...retry, replayed: true, job: null, queuedRunIds: [] as string[] };
      throw conflict();
    }
    throw error;
  }
}
