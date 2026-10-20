import {
  CHAT_AGENT_LIMIT_DEFAULTS,
  CHAT_AGENT_LIMIT_MAXIMUMS,
  CHAT_MODEL_PRICES_USD_PER_MTOK,
  MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE,
  isProhibitedRoutingModelId,
  type ChatAgentLimitName,
  type ChatAgentLimits,
  type ChatAgentLimitsInput,
} from "@docslurp/shared";
import {
  DEFAULT_WORKSPACE_CHAT_MODEL,
  isWorkspaceChatModelId,
} from "@docslurp/shared/workspace-chat-models";
import { isPlatformAdminActor, type RequestActor } from "./request-actor.js";

/** An explicit chat `model` the caller may not use. Answered as HTTP 400 `model_not_allowed`. */
export class ChatModelNotAllowedError extends Error {
  readonly status = 400 as const;
  readonly statusCode = 400 as const;
  readonly code = "model_not_allowed" as const;
  constructor() {
    super("That chat model isn’t available for this request. Omit model to use the default.");
    this.name = "ChatModelNotAllowedError";
  }
}

export type ChatEvalModelRejection = { id: string; reason: "invalid-id" | "prohibited-model" | "missing-price" | "output-price-too-high" };

const OPENROUTER_MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?::free)?$/i;

/**
 * DOCSLURP_CHAT_EVAL_MODELS: comma-separated OpenRouter ids that admins may
 * request on /v1/chat in addition to the catalog. Each id must be a plain
 * OpenRouter id (a `:free` suffix is allowed), must not be a Pro/Ultra model,
 * and needs a verified price below the output-price cap in
 * CHAT_MODEL_PRICES_USD_PER_MTOK, so missing pricing never passes as cheap.
 */
export function parseChatEvalModels(csv: string | undefined): { models: string[]; rejected: ChatEvalModelRejection[] } {
  const models: string[] = [];
  const rejected: ChatEvalModelRejection[] = [];
  for (const id of new Set((csv ?? "").split(",").map(item => item.trim()).filter(Boolean))) {
    const price = CHAT_MODEL_PRICES_USD_PER_MTOK[id];
    if (!OPENROUTER_MODEL_ID.test(id)) rejected.push({ id, reason: "invalid-id" });
    else if (isProhibitedRoutingModelId(id)) rejected.push({ id, reason: "prohibited-model" });
    else if (!price) rejected.push({ id, reason: "missing-price" });
    else if (price.output >= MAX_OUTPUT_USD_PER_MTOK_EXCLUSIVE) rejected.push({ id, reason: "output-price-too-high" });
    else models.push(id);
  }
  return { models, rejected };
}

let loaded: { raw: string; models: ReadonlySet<string> } | undefined;

/** Read at first use and again whenever the variable changes; each rejection is logged once and never used. */
export function configuredChatEvalModels(raw = process.env.DOCSLURP_CHAT_EVAL_MODELS ?? ""): ReadonlySet<string> {
  if (loaded?.raw === raw) return loaded.models;
  const { models, rejected } = parseChatEvalModels(raw);
  for (const { id, reason } of rejected) {
    console.warn(`[chat-models] DOCSLURP_CHAT_EVAL_MODELS rejected model=${id.slice(0, 120)} reason=${reason}`);
  }
  loaded = { raw, models: new Set(models) };
  return loaded.models;
}

export type ChatModelSource = "default" | "catalog" | "eval";

/**
 * Omitted model: the default. A catalog model: anyone. An eval allowlist model:
 * admins only. Anything else, including a non-admin naming an eval model, is a
 * 400 rather than a silent fallback, so a comparison never measures the wrong model.
 */
export function resolveChatModelRequest(args: { requested: string | null | undefined; isAdmin: boolean; evalModels?: ReadonlySet<string> }): { model: string; source: ChatModelSource } {
  const requested = args.requested?.trim();
  if (!requested) return { model: DEFAULT_WORKSPACE_CHAT_MODEL, source: "default" };
  if (isWorkspaceChatModelId(requested)) return { model: requested, source: "catalog" };
  const evalModels = args.evalModels ?? configuredChatEvalModels();
  if (args.isAdmin && evalModels.has(requested) && !isProhibitedRoutingModelId(requested)) return { model: requested, source: "eval" };
  throw new ChatModelNotAllowedError();
}

/**
 * Per-request agent budgets. Admins may use the full schema range; everyone
 * else may only lower a limit, and a raised value is clamped to the default
 * and listed in `clamped`.
 */
export function resolveChatAgentLimits(requested: ChatAgentLimitsInput | undefined, isAdmin: boolean): ChatAgentLimits {
  const clamped: ChatAgentLimitName[] = [];
  const pick = (name: ChatAgentLimitName): number => {
    const value = requested?.[name];
    const fallback = CHAT_AGENT_LIMIT_DEFAULTS[name];
    if (value === undefined || !Number.isFinite(value)) return fallback;
    const bounded = Math.min(CHAT_AGENT_LIMIT_MAXIMUMS[name], Math.max(1, Math.trunc(value)));
    if (!isAdmin && bounded > fallback) { clamped.push(name); return fallback; }
    return bounded;
  };
  return { maxSteps: pick("maxSteps"), maxToolCalls: pick("maxToolCalls"), searchConcurrency: pick("searchConcurrency"), clamped };
}

/** True when `model` would be refused for this actor; routes answer 400 before streaming. */
export async function chatModelRefused(actor: RequestActor | undefined, model: string | null | undefined): Promise<boolean> {
  if (!model?.trim()) return false;
  try {
    resolveChatModelRequest({ requested: model, isAdmin: await isPlatformAdminActor(actor) });
    return false;
  } catch (error) {
    if (error instanceof ChatModelNotAllowedError) return true;
    throw error;
  }
}
