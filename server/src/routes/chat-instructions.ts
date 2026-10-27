import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { CHAT_INSTRUCTIONS_MAX_CHARS, DEFAULT_SCOPE_DECLINE_THRESHOLD } from "@docslurp/shared";

import { apiErrorResponse } from "../lib/api-error.js";
import { getRequestActor, isFirstPartyAppActor } from "../lib/request-actor.js";
import { consumeFeatureRateLimit } from "../middleware/rate-limit.js";
import { isSpendBlockedError, spendBlockedResponse } from "../services/billing/spend-guard.js";
import { composeSystemMessage, composeSystemMessageSections, defaultChatInstructionsTemplate } from "../services/chat-instructions.js";
import { findCoreRuleConflicts, ImproveUnavailableError, improveChatInstructions, resolveImproveModel } from "../services/chat-instructions-improve.js";
import { loadChatScope } from "../services/chat-scope.js";
import { canEditWorkspace, getWorkspaceAccess } from "../services/organizations.js";
import { getWorkspaceSearchSettings } from "../services/search-controls.js";
import { getWorkspace } from "../services/workspaces.js";
import { resolveScopeDeclineThreshold } from "../search/scope-relevance.js";

/**
 * Workspace chat instructions: the composed system-message preview and the
 * "Improve" suggestion. Both are DocSlurp-app features: undeclared routes are
 * session-only in sessionAuth, and each handler also requires the first-party
 * app actor (isFirstPartyAppActor), so API keys of any type, browser keys,
 * MCP OAuth tokens and capability tokens are refused even when a forwarded
 * request arrives with an actor already set.
 */

const draftSchema = z.object({
  /** The draft instructions; omitted uses the saved instructions. Null or empty previews the default template. */
  instructions: z.string().max(CHAT_INSTRUCTIONS_MAX_CHARS * 2).nullable().optional(),
}).strict();

const previewSchema = draftSchema.extend({
  /** The draft's unsaved answer style and citations; omitted uses the saved settings. */
  answerStyle: z.enum(["concise", "balanced", "detailed"]).optional(),
  citations: z.boolean().optional(),
}).strict();

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

const IMPROVE_WINDOW_MS = 60 * 60 * 1000;

function refuseNonAppActor(c: Parameters<typeof getRequestActor>[0]): Response | null {
  const actor = getRequestActor(c);
  if (isFirstPartyAppActor(actor)) return null;
  return apiErrorResponse(c, 403, "forbidden", "Chat instructions tools are available only in the signed-in DocSlurp app.");
}

export const chatInstructionsRoutes = new Hono()
  .post(
    "/:workspaceId/chat-instructions/preview",
    zValidator("json", previewSchema),
    async (c) => {
      const refused = refuseNonAppActor(c);
      if (refused) return refused;
      const userId = c.get("sessionUser").id;
      const workspaceId = String(c.req.param("workspaceId"));
      const access = await getWorkspaceAccess(workspaceId, userId);
      const workspace = access ? await getWorkspace(workspaceId, userId) : null;
      if (!access || !workspace) return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
      const settings = await getWorkspaceSearchSettings(workspaceId, userId);
      const body = c.req.valid("json");
      const instructions = body.instructions === undefined ? settings.chat.searchInstructions : body.instructions;
      const scope = await loadChatScope(workspaceId, workspace.name);
      const args = {
        ingestInstructions: workspace.systemPrompt,
        searchInstructions: instructions,
        answerStyle: body.answerStyle ?? settings.chat.answerStyle,
        citations: body.citations ?? settings.chat.citations,
        scope,
      };
      return c.json({
        sections: composeSystemMessageSections(args),
        systemMessage: composeSystemMessage(args),
        defaultTemplate: defaultChatInstructionsTemplate(scope),
        conflicts: findCoreRuleConflicts(instructions),
        maxChars: CHAT_INSTRUCTIONS_MAX_CHARS,
        scopeDecline: {
          threshold: resolveScopeDeclineThreshold(settings.chat.scopeDeclineThreshold),
          defaultThreshold: DEFAULT_SCOPE_DECLINE_THRESHOLD,
        },
      });
    },
  )
  .post(
    "/:workspaceId/chat-instructions/improve",
    zValidator("json", draftSchema),
    async (c) => {
      const refused = refuseNonAppActor(c);
      if (refused) return refused;
      const userId = c.get("sessionUser").id;
      const workspaceId = String(c.req.param("workspaceId"));
      const access = await getWorkspaceAccess(workspaceId, userId);
      const workspace = access ? await getWorkspace(workspaceId, userId) : null;
      // Improve suggests settings, so it needs edit access, like saving them.
      if (!access || !workspace || !canEditWorkspace(access, userId)) return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");

      for (const [subject, limit] of [
        [`user:${userId}`, envInt("CHAT_INSTRUCTIONS_IMPROVE_USER_LIMIT_PER_HOUR", 10)],
        [`workspace:${workspaceId}`, envInt("CHAT_INSTRUCTIONS_IMPROVE_WORKSPACE_LIMIT_PER_HOUR", 30)],
      ] as const) {
        const retryAfter = await consumeFeatureRateLimit({ feature: "chat-instructions-improve", subject, limit, windowMs: IMPROVE_WINDOW_MS });
        if (retryAfter !== null) {
          c.header("Retry-After", String(retryAfter));
          return apiErrorResponse(c, 429, "rate_limited", "Too many Improve requests. Try again later.", { retryAfterSeconds: retryAfter });
        }
      }

      const settings = await getWorkspaceSearchSettings(workspaceId, userId);
      const body = c.req.valid("json");
      const scope = await loadChatScope(workspaceId, workspace.name);
      const draft = (body.instructions === undefined ? settings.chat.searchInstructions : body.instructions)?.trim()
        || defaultChatInstructionsTemplate(scope);
      try {
        resolveImproveModel();
        const result = await improveChatInstructions({
          userId, orgId: workspace.orgId, workspaceId, pipeline: workspace.pipeline,
          draft, scope, chat: settings.chat,
        });
        return c.json({ ...result, draft, saved: false });
      } catch (error) {
        if (isSpendBlockedError(error)) return spendBlockedResponse(c, error);
        if (error instanceof ImproveUnavailableError) {
          if (error.reason === "privacy_mode") return apiErrorResponse(c, 409, "privacy_mode_blocked", error.message);
          return apiErrorResponse(c, 503, "unavailable", error.message);
        }
        throw error;
      }
    },
  );
