/**
 * Managed model settings. Callers choose DocSlurp categories (chat tiers, quality, profiles); the concrete backend
 * model behind each category is a managed setting that only platform admins can change, per project, in
 * `projects.managed_models` (migration 0141). Backend ids are recorded in usage events, traces and logs, and never
 * returned to customers.
 */
import { CHAT_TIERS, chatTierForModel, isChatTier, type ChatTier, type ChatTierModelMap } from "@docslurp/shared/project-chat-models";
import { isProhibitedRoutingModelId, pipelineFeaturesSchema, type ProjectChatResponse } from "@docslurp/shared";
import { z } from "zod";

import { sql } from "../db.js";
import { managedChatModelProblem } from "../lib/chat-model-policy.js";

/** What platform admins may set: tier → reviewed chat model. Null clears a tier back to the managed default. */
const modelRef = z.string().trim().min(1).max(220);
/**
 * Managed pipeline fields platform admins may set: backend text, structured-extraction, vision and embedding models,
 * including operator-declared private routes (`llm://private/<alias>/<model>` from DOCSLURP_PRIVATE_MODEL_ENDPOINTS).
 * Null clears a field back to the profile or deployment default.
 */
const managedPipelineUpdateSchema = z.object({
  textGeneration: z.object({ model: modelRef.nullable().optional(), models: z.record(z.string(), modelRef).optional() }).strict().optional(),
  structuredExtraction: z.object({ model: modelRef.nullable().optional() }).strict().optional(),
  vision: z.object({ modelUri: modelRef.nullable().optional(), remoteFallbackModelUri: modelRef.nullable().optional() }).strict().optional(),
  embedding: z.object({ modelUri: modelRef.nullable().optional() }).strict().optional(),
}).strict();

export const managedModelsUpdateSchema = z.object({
  chat: z.partialRecord(z.enum(CHAT_TIERS), z.string().trim().min(1).max(200).nullable()).optional(),
  pipeline: managedPipelineUpdateSchema.optional(),
}).strict().refine(value => value.chat || value.pipeline, "Send chat or pipeline");
export type ManagedModelsUpdate = z.infer<typeof managedModelsUpdateSchema>;

export class ManagedModelError extends Error {
  readonly status = 400 as const;
  constructor(message: string) { super(message); this.name = "ManagedModelError"; }
}

/** Stored mapping, validated on read too: an entry that no longer passes review (repriced, retired) is dropped and logged. */
export function parseStoredChatTierModels(value: unknown, projectId = "?"): ChatTierModelMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const map: ChatTierModelMap = {};
  for (const [tier, model] of Object.entries(value as Record<string, unknown>)) {
    if (!isChatTier(tier) || typeof model !== "string") continue;
    const problem = managedChatModelProblem(model);
    if (problem) {
      console.warn(`[managed-models] dropped project=${projectId} tier=${tier} model=${model.slice(0, 120)} reason=${problem}`);
      continue;
    }
    map[tier] = model;
  }
  return Object.keys(map).length ? map : null;
}

export async function loadProjectChatTierModels(projectId: string): Promise<ChatTierModelMap | null> {
  const [row] = await sql<Array<{ chat: unknown }>>`
    select managed_models -> 'chat' as chat from projects where id = ${projectId}
  `;
  return parseStoredChatTierModels(row?.chat, projectId);
}

/**
 * Platform-admin path only (routes/admin-projects.ts). Validates every model before writing anything: chat models
 * against the reviewed catalog and price cap; pipeline models through the pipeline schema (catalog URIs, operator
 * private routes) and the Pro/Ultra prohibition. An embedding model change is refused once the project has
 * documents, since their vectors would no longer match the query embedding.
 */
export async function setProjectManagedModels(projectId: string, update: ManagedModelsUpdate, adminUserId: string): Promise<{ chat: ChatTierModelMap; pipeline?: Record<string, unknown> } | null> {
  for (const [tier, model] of Object.entries(update.chat ?? {})) {
    if (model === null || model === undefined) continue;
    const problem = managedChatModelProblem(model);
    if (problem) throw new ManagedModelError(`chat.${tier}: ${problem}`);
  }
  for (const value of JSON.stringify(update.pipeline ?? {}).match(/"([^"]+)"/g) ?? []) {
    if (isProhibitedRoutingModelId(value.slice(1, -1).replace(/^llm:\/\/openrouter\//, ""))) throw new ManagedModelError("pipeline: prohibited model");
  }
  return sql.begin(async (tx) => {
    const [row] = await tx<Array<{ chat: unknown; pipeline: unknown }>>`
      select managed_models -> 'chat' as chat, pipeline from projects where id = ${projectId} for update
    `;
    if (!row) return null;
    const current = row.chat && typeof row.chat === "object" && !Array.isArray(row.chat) ? { ...(row.chat as Record<string, string>) } : {};
    for (const [tier, model] of Object.entries(update.chat ?? {})) {
      if (model === null) delete current[tier];
      else if (model !== undefined) current[tier] = model;
    }
    let pipeline: Record<string, unknown> | undefined;
    if (update.pipeline) {
      if (update.pipeline.embedding?.modelUri !== undefined) {
        const [{ count }] = await tx<Array<{ count: number }>>`select count(*)::int as count from documents where project_id = ${projectId}`;
        if (count > 0) throw new ManagedModelError("pipeline.embedding.modelUri: the project has documents; change the embedding profile and re-index instead");
      }
      const stored = (row.pipeline && typeof row.pipeline === "object" ? row.pipeline : {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...stored };
      for (const [section, fields] of Object.entries(update.pipeline)) {
        const next = { ...((stored[section] as Record<string, unknown> | undefined) ?? {}) };
        for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
          if (value === null && key !== "model" && key !== "remoteFallbackModelUri") delete next[key];
          else if (value !== undefined) next[key] = value;
        }
        merged[section] = next;
      }
      const parsed = pipelineFeaturesSchema.safeParse(merged);
      if (!parsed.success) throw new ManagedModelError(`pipeline: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
      pipeline = JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>;
    }
    await tx`
      update projects
      set managed_models = jsonb_set(coalesce(managed_models, '{}'::jsonb), '{chat}', ${tx.json(current)}::jsonb, true)
        ${pipeline ? tx`, pipeline = ${tx.json(pipeline as never)}` : tx``}
      where id = ${projectId}
    `;
    console.info(`[managed-models] set project=${projectId} by=${adminUserId} chat=${JSON.stringify(current)} pipeline=${JSON.stringify(update.pipeline ?? null)}`);
    return { chat: current, ...(pipeline ? { pipeline: update.pipeline as Record<string, unknown> } : {}) };
  });
}

/**
 * A chat response as customers see it: the debug block names the tier that answered (a failover model reads as its
 * own tier), never a backend model, build or upstream provider. The raw values were already logged, traced and
 * recorded in usage events.
 */
export function customerChatResponse<T extends Pick<ProjectChatResponse, "debug">>(
  response: T,
  tier: ChatTier | null,
  overrides?: ChatTierModelMap | null,
): T {
  const debug = response.debug;
  if (!debug) return response;
  const tierOf = (model: string | null | undefined): ChatTier | null => model ? chatTierForModel(model, overrides, tier) ?? tier : null;
  const { resolvedModel: _model, resolvedProvider: _provider, ...rest } = debug;
  return {
    ...response,
    debug: {
      ...rest,
      model: tierOf(debug.model),
      ...(debug.requestedModel !== undefined ? { requestedModel: tier } : {}),
      ...(debug.stepUsage ? { stepUsage: debug.stepUsage.map(step => ({ ...step, model: tierOf(step.model) })) } : {}),
    },
  };
}
