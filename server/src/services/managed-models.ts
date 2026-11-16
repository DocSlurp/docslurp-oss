/**
 * Managed model settings. Callers choose DocSlurp categories (chat tiers, quality, profiles); the concrete backend
 * model behind a category is a managed setting that only platform admins change, per project, in
 * `projects.managed_models` (migration 0158): `chat` (tier -> model) and `pipeline` (explicit pipeline model overrides,
 * managed-pipeline-models.ts). Backend ids are recorded in usage events, traces and logs, and never returned to
 * customers.
 */
import {
  automaticModelCallProblem,
  buildDecisionModelCatalog,
  embeddingModelCatalogByUri,
  findDecisionModel,
  isProhibitedRoutingModelId,
  managedPipelineOverridesSchema,
  parseManagedPipelineOverrides,
  policyModelId,
  resolveAiUsagePricingWithSource,
  resolveManagedPipeline,
  storedManagedPipeline,
  visionModelCatalogByUri,
  type ManagedPipelineOverrides,
  type ProjectChatResponse,
} from "@docslurp/shared";
import { CHAT_TIERS, chatTierForModel, isChatTier, type ChatTier, type ChatTierModelMap } from "@docslurp/shared/project-chat-models";
import { z } from "zod";

import { sql } from "../db.js";
import { managedChatModelProblem } from "../lib/chat-model-policy.js";
import { appendAuditLog } from "./audit-log.js";

/** What platform admins may set. In `chat`, null clears a tier back to the managed default. `pipeline` replaces the overrides (null clears them). */
export const managedModelsUpdateSchema = z.object({
  chat: z.partialRecord(z.enum(CHAT_TIERS), z.string().trim().min(1).max(200).nullable()).optional(),
  pipeline: managedPipelineOverridesSchema.nullable().optional(),
}).strict().refine(value => value.chat !== undefined || value.pipeline !== undefined, "Send chat or pipeline");
export type ManagedModelsUpdate = z.infer<typeof managedModelsUpdateSchema>;

export class ManagedModelError extends Error {
  readonly status = 400 as const;
  constructor(message: string) { super(message); this.name = "ManagedModelError"; }
}

/** Stored mapping, validated on read too: an entry that no longer passes review (repriced, retired, denied) is dropped and logged. */
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

const PRIVATE_ROUTE = /^llm:\/\/private\//i;

/**
 * Why a platform admin may not pin `model` to pipeline field `path`, or null. Never automatic-selection-denied, never
 * Pro/Ultra (normalized) and never priced at or above the cap: an override applies to callers who only chose a
 * category. A private operator route passes (the pipeline schema checks it against the operator registry); a hosted
 * vision or embedding model must be a reviewed catalog entry; any other hosted model needs a verified price.
 */
export function managedPipelineModelProblem(path: string, model: string): string | null {
  const policy = automaticModelCallProblem(model);
  if (policy) return policy;
  if (isProhibitedRoutingModelId(model)) return "prohibited model";
  if (PRIVATE_ROUTE.test(model.trim())) return null;
  if (path.startsWith("vision.")) return visionModelCatalogByUri[model.trim()] ? null : "not a reviewed vision model";
  if (path.startsWith("embedding.")) return embeddingModelCatalogByUri[model.trim()] ? null : "not a reviewed embedding model";
  if (path.startsWith("pageRouter.")) {
    // Router decision models have their own reviewed catalog and per-call prices (not OpenRouter chat prices):
    // admitted there means priced, input-billed, not Pro/Ultra. Availability (API keys) is the deployment's concern.
    const found = findDecisionModel(model.trim());
    if (!found) return "not a reviewed decision model";
    const env = Object.fromEntries(found.availability.requiresEnv.map((key) => [key, true]));
    const rejected = buildDecisionModelCatalog({ env }).rejected.find((entry) => entry.modelId === found.id);
    return rejected ? `decision model refused (${rejected.reason})` : null;
  }
  const { pricingSource } = resolveAiUsagePricingWithSource({ provider: "openrouter", model: policyModelId(model) });
  return pricingSource === "configured-fallback" ? "no verified price" : null;
}

function overrideModels(overrides: ManagedPipelineOverrides): Array<[path: string, model: string]> {
  const out: Array<[string, string]> = [];
  for (const [section, fields] of Object.entries(overrides)) {
    for (const [key, value] of Object.entries((fields ?? {}) as Record<string, unknown>)) {
      if (typeof value === "string") out.push([`${section}.${key}`, value]);
      else if (Array.isArray(value)) for (const item of value) out.push([`${section}.${key}`, String(item)]);
      else if (value && typeof value === "object") for (const [task, item] of Object.entries(value)) out.push([`${section}.${key}.${task}`, String(item)]);
    }
  }
  return out;
}

export type ManagedModelsRecord = { chat: Record<string, string>; pipeline: ManagedPipelineOverrides | null };

function chatRecord(value: unknown): Record<string, string> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, string>) } : {};
}

/** The project's managed models as stored (platform-admin read). */
export async function getProjectManagedModels(projectId: string): Promise<ManagedModelsRecord | null> {
  const [row] = await sql<Array<{ chat: unknown; pipeline: unknown }>>`
    select managed_models -> 'chat' as chat, managed_models -> 'pipeline' as pipeline from projects where id = ${projectId}
  `;
  if (!row) return null;
  return { chat: chatRecord(row.chat), pipeline: parseManagedPipelineOverrides(row.pipeline, `project ${projectId}`) };
}

/**
 * Platform-admin path only (routes/admin-projects.ts). Validates every model before writing anything, rewrites the
 * project's stored pipeline (strip managed fields, apply the new overrides, validate), and records an audit row with
 * the before and after values. An override that conflicts with the project's pipeline (privacy mode, catalog) is a 400.
 */
export async function setProjectManagedModels(
  projectId: string,
  update: ManagedModelsUpdate,
  actor: { userId: string; apiKeyId?: string | null; ipAddress?: string | null },
): Promise<ManagedModelsRecord | null> {
  for (const [tier, model] of Object.entries(update.chat ?? {})) {
    if (model === null || model === undefined) continue;
    const problem = managedChatModelProblem(model);
    if (problem) throw new ManagedModelError(`chat.${tier}: ${problem}`);
  }
  for (const [path, model] of overrideModels(update.pipeline ?? {})) {
    const problem = managedPipelineModelProblem(path, model);
    if (problem) throw new ManagedModelError(`pipeline.${path}: ${problem}`);
  }
  return sql.begin(async (tx) => {
    const [row] = await tx<Array<{ org_id: string; chat: unknown; overrides: unknown; pipeline: unknown }>>`
      select org_id, managed_models -> 'chat' as chat, managed_models -> 'pipeline' as overrides, pipeline
      from projects where id = ${projectId} for update
    `;
    if (!row) return null;
    const beforeChat = chatRecord(row.chat);
    const chat = { ...beforeChat };
    for (const [tier, model] of Object.entries(update.chat ?? {})) {
      if (model === null) delete chat[tier];
      else if (model !== undefined) chat[tier] = model;
    }
    const beforeOverrides = parseManagedPipelineOverrides(row.overrides, `project ${projectId}`);
    const overrides = update.pipeline === undefined ? beforeOverrides : (update.pipeline && Object.keys(update.pipeline).length ? update.pipeline : null);
    if (update.pipeline?.embedding?.modelUri !== undefined) {
      const [{ count }] = await tx<Array<{ count: number }>>`select count(*)::int as count from documents where project_id = ${projectId}`;
      if (count > 0) throw new ManagedModelError("pipeline.embedding.modelUri: the project has documents; change the embedding profile and re-index instead");
    }
    const resolved = resolveManagedPipeline(row.pipeline, overrides, `project ${projectId}`);
    if (resolved.dropped.length) throw new ManagedModelError(`pipeline: ${resolved.dropped.join(", ")} conflict with the project's pipeline (privacy mode or catalog)`);
    const stored = storedManagedPipeline(resolved.pipeline, overrides, resolved.applied);
    const managed = { chat, ...(overrides ? { pipeline: overrides } : {}) };
    await tx`update projects set managed_models = ${tx.json(managed as never)}, pipeline = ${tx.json(stored as never)} where id = ${projectId}`;
    await appendAuditLog({
      orgId: row.org_id, userId: actor.userId, projectId, apiKeyId: actor.apiKeyId ?? null,
      action: "project.managed_models.updated", resourceType: "project-managed-models", resourceId: projectId,
      ipAddress: actor.ipAddress ?? null,
      metadata: { before: { chat: beforeChat, pipeline: beforeOverrides }, after: { chat, pipeline: overrides } },
    }, tx as never);
    return { chat, pipeline: overrides };
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
