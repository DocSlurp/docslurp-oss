import { isAutomaticSelectionDenied } from "@docslurp/shared";
import { isSpeedBoostEligible, speedBoostModel } from "@docslurp/shared";
import { SPEED_BOOST_MODEL_SWAPS } from "@docslurp/shared/project-chat-models";
import {
  CHAT_AGENT_BASE_STEPS,
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
  DEFAULT_CHAT_REASONING,
  DEFAULT_PROJECT_CHAT_MODEL,
  isProjectChatModelId,
  normalizeChatModelRef,
  parseChatModelOptions,
  type ChatReasoningLevel,
} from "@docslurp/shared/project-chat-models";
import { isPlatformAdminActor, type RequestActor } from "./request-actor.js";
import { getProjectAccess } from "../services/organizations.js";

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
 * DOCSLURP_CHAT_EVAL_MODELS: comma-separated OpenRouter ids (bare or
 * `llm://openrouter/<id>`) that admins may request on /v1/chat in addition to
 * the catalog. Each id must be a plain OpenRouter id (a `:free` suffix is allowed), must not be a Pro/Ultra model,
 * and needs a verified price below the output-price cap in
 * CHAT_MODEL_PRICES_USD_PER_MTOK, so missing pricing never passes as cheap.
 */
export function parseChatEvalModels(csv: string | undefined): { models: string[]; rejected: ChatEvalModelRejection[] } {
  const models: string[] = [];
  const rejected: ChatEvalModelRejection[] = [];
  for (const id of new Set((csv ?? "").split(",").map(item => normalizeChatModelRef(item)).filter(Boolean))) {
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

/** DOCSLURP_CHAT_EVAL_ORG_IDS: organizations whose projects may run eval models and the admin limit range. */
export function configuredChatEvalOrgIds(raw = process.env.DOCSLURP_CHAT_EVAL_ORG_IDS ?? ""): ReadonlySet<string> {
  return new Set(raw.split(",").map(id => id.trim()).filter(Boolean));
}

/**
 * Eval access for one chat turn: eval models and the full agent limit range,
 * and nothing else. Platform admins have it everywhere. Otherwise the turn's
 * project must be owned by an org in DOCSLURP_CHAT_EVAL_ORG_IDS (the owning
 * org, not the caller's memberships), and an API key must be a server key.
 */
export async function chatEvalAccess(actor: RequestActor | undefined, projectId: string | undefined): Promise<boolean> {
  if (!actor) return false;
  if (await isPlatformAdminActor(actor)) return true;
  const orgIds = configuredChatEvalOrgIds();
  if (!orgIds.size || !projectId) return false;
  if (actor.type === "apiKey" && actor.apiKey.keyType !== "server") return false;
  // Access row only (owning org, membership, key allowlist): no project stats on the chat hot path.
  const access = await getProjectAccess(projectId, actor.userId);
  return Boolean(access && orgIds.has(access.orgId));
}

/**
 * True only when the turn asks for something eval access decides: an explicit
 * model outside the catalog, or an agent limit above its default. Default and
 * catalog requests skip the admin and project lookups entirely.
 */
export function chatTurnNeedsEvalAccess(model: string | null | undefined, agent?: ChatAgentLimitsInput): boolean {
  const requested = model ? normalizeChatModelRef(model) : undefined;
  if (requested && !isProjectChatModelId(requested)) return true;
  return (Object.keys(CHAT_AGENT_LIMIT_DEFAULTS) as ChatAgentLimitName[])
    .some(name => typeof agent?.[name] === "number" && Math.trunc(agent[name]!) > CHAT_AGENT_LIMIT_DEFAULTS[name]);
}

export type ChatModelSource = "default" | "catalog" | "eval";

/**
 * `model` may be a bare OpenRouter id or its `llm://openrouter/<id>` URI; both resolve to the bare id.
 * Omitted model: the default. A catalog model: anyone. An eval allowlist model:
 * callers with eval access only (`isAdmin`: see chatEvalAccess). Anything else, including a non-admin naming an eval model, is a
 * 400 rather than a silent fallback, so a comparison never measures the wrong model.
 */
export function resolveChatModelRequest(args: { requested: string | null | undefined; isAdmin: boolean; evalModels?: ReadonlySet<string> }): { model: string; source: ChatModelSource; reasoning: ChatReasoningLevel } {
  // `?reasoning=` (or the native `reasoning_effort` / `effort`) sets the turn's reasoning; any other option, or a
  // level DocSlurp does not know, refuses the model rather than ignoring the option.
  const options = args.requested?.trim() ? parseChatModelOptions(args.requested) : { model: "" };
  if (!options) throw new ChatModelNotAllowedError();
  const reasoning = options.reasoning ?? DEFAULT_CHAT_REASONING;
  const requested = options.model ? normalizeChatModelRef(options.model) : undefined;
  if (!requested) return { model: DEFAULT_PROJECT_CHAT_MODEL, source: "default", reasoning };
  if (isProjectChatModelId(requested)) return { model: requested, source: "catalog", reasoning };
  const evalModels = args.evalModels ?? configuredChatEvalModels();
  if (args.isAdmin && evalModels.has(requested) && !isProhibitedRoutingModelId(requested)) return { model: requested, source: "eval", reasoning };
  throw new ChatModelNotAllowedError();
}

/**
 * Per-request agent budgets. Callers with eval access (platform admins or an
 * eval org's project) may use the full schema range; everyone else may only lower a limit, and a raised value is clamped to the default
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
  const maxSteps = pick("maxSteps");
  // An explicit maxSteps is a fixed budget; otherwise the turn earns steps past the base by finding new evidence.
  const baseSteps = requested?.maxSteps !== undefined ? maxSteps : Math.min(CHAT_AGENT_BASE_STEPS, maxSteps);
  return { maxSteps, baseSteps, maxToolCalls: pick("maxToolCalls"), searchConcurrency: pick("searchConcurrency"), clamped };
}

/** True when `model` would be refused for this actor and project; routes answer 400 before streaming. */
export async function chatModelRefused(actor: RequestActor | undefined, model: string | null | undefined, projectId?: string): Promise<boolean> {
  if (!chatTurnNeedsEvalAccess(model)) return false;
  try {
    resolveChatModelRequest({ requested: model, isAdmin: await chatEvalAccess(actor, projectId) });
    return false;
  } catch (error) {
    if (error instanceof ChatModelNotAllowedError) return true;
    throw error;
  }
}

/**
 * A Nitro model cannot bypass explicit credit opt-in. Unsupported routes fail before spending.
 * Speed boost answers with the chosen model on Nitro, or its SPEED_BOOST_MODEL_SWAPS target (none today). A swap is an
 * automatic selection, so a swap target that is never selected automatically is ignored. An explicit `:nitro` id is
 * honoured as named.
 */
export function resolveSpeedBoostChatModel(model: string, enabled: boolean = false): string {
  if ((model.endsWith(":nitro") && !enabled) || (enabled && !isSpeedBoostEligible(model))) throw new ChatModelNotAllowedError();
  const swap = enabled ? SPEED_BOOST_MODEL_SWAPS[model] : undefined;
  return (swap && !isAutomaticSelectionDenied(swap) ? swap : undefined) ?? speedBoostModel(model, enabled);
}
