/**
 * Managed model settings. Callers choose DocSlurp categories (chat tiers, quality, profiles); the concrete backend
 * model behind each category is a managed setting that only platform admins can change, per project, in
 * `projects.managed_models` (migration 0141). Backend ids are recorded in usage events, traces and logs, and never
 * returned to customers.
 */
import { CHAT_TIERS, chatTierForModel, isChatTier, type ChatTier, type ChatTierModelMap } from "@docslurp/shared/project-chat-models";
import type { ProjectChatResponse } from "@docslurp/shared";
import { z } from "zod";

import { sql } from "../db.js";
import { managedChatModelProblem } from "../lib/chat-model-policy.js";

/** What platform admins may set: tier → reviewed chat model. Null clears a tier back to the managed default. */
export const managedModelsUpdateSchema = z.object({
  chat: z.partialRecord(z.enum(CHAT_TIERS), z.string().trim().min(1).max(200).nullable()),
}).strict();
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

/** Platform-admin path only (routes/admin-projects.ts). Validates every model before writing anything. */
export async function setProjectManagedModels(projectId: string, update: ManagedModelsUpdate, adminUserId: string): Promise<{ chat: ChatTierModelMap } | null> {
  for (const [tier, model] of Object.entries(update.chat)) {
    if (model === null || model === undefined) continue;
    const problem = managedChatModelProblem(model);
    if (problem) throw new ManagedModelError(`chat.${tier}: ${problem}`);
  }
  const [row] = await sql<Array<{ chat: unknown }>>`
    select managed_models -> 'chat' as chat from projects where id = ${projectId} for update
  `;
  if (!row) return null;
  const current = row.chat && typeof row.chat === "object" && !Array.isArray(row.chat) ? { ...(row.chat as Record<string, string>) } : {};
  for (const [tier, model] of Object.entries(update.chat)) {
    if (model === null) delete current[tier];
    else if (model !== undefined) current[tier] = model;
  }
  await sql`
    update projects
    set managed_models = jsonb_set(coalesce(managed_models, '{}'::jsonb), '{chat}', ${sql.json(current)}::jsonb, true)
    where id = ${projectId}
  `;
  console.info(`[managed-models] set project=${projectId} by=${adminUserId} chat=${JSON.stringify(current)}`);
  return { chat: current };
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
  const tierOf = (model: string | null | undefined): ChatTier | null => model ? chatTierForModel(model, overrides) ?? tier : null;
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
