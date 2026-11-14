import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { CHAT_INSTRUCTIONS_MAX_CHARS, DEFAULT_SCOPE_DECLINE_THRESHOLD } from "@docslurp/shared";

import { apiErrorResponse } from "../lib/api-error.js";
import { getRequestActor, isFirstPartyAppActor } from "../lib/request-actor.js";
import { consumeFeatureRateLimit } from "../middleware/rate-limit.js";
import { isSpendBlockedError, spendBlockedResponse } from "../services/billing/spend-guard.js";
import { composeAgentProjectInstructions, composeSystemMessage, composeSystemMessageSections, defaultChatInstructionsTemplate } from "../services/chat-instructions.js";
import { findCoreRuleConflicts, ImproveUnavailableError, improveChatInstructions, resolveImproveModel } from "../services/chat-instructions-improve.js";
import { chatScopeFor } from "../services/chat-scope.js";
import { describeSearchSettingsForAgent } from "../services/chat-search-options.js";
import { describeCurrentSearchSettings } from "../services/project-chat.js";
import { canEditProject, getProjectAccess } from "../services/organizations.js";
import { editorRequired } from "../lib/reprocess-access.js";
import { getProjectSearchSettings } from "../services/search-controls.js";
import { getProject } from "../services/projects.js";
import { resolveScopeDeclineThreshold } from "../search/scope-relevance.js";

/**
 * Project chat instructions: the composed system-message preview and the
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
    "/:projectId/chat-instructions/preview",
    zValidator("json", previewSchema),
    async (c) => {
      const refused = refuseNonAppActor(c);
      if (refused) return refused;
      const userId = c.get("sessionUser").id;
      const projectId = String(c.req.param("projectId"));
      const access = await getProjectAccess(projectId, userId);
      const project = access ? await getProject(projectId, userId) : null;
      if (!access || !project) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      const settings = await getProjectSearchSettings(projectId, userId);
      const body = c.req.valid("json");
      const instructions = body.instructions === undefined ? settings.chat.searchInstructions : body.instructions;
      const scope = chatScopeFor(project);
      const chat = { ...settings.chat, answerStyle: body.answerStyle ?? settings.chat.answerStyle, citations: body.citations ?? settings.chat.citations };
      const base = {
        ingestInstructions: project.systemPrompt,
        searchInstructions: instructions,
        answerStyle: chat.answerStyle,
        citations: chat.citations,
        scope,
      };
      // Exactly what each chat path composes: direct answers (one retrieval, one
      // model call) and the search agent (the default in the app and /v1/chat).
      const direct = { ...base, contextNote: describeCurrentSearchSettings({ ...settings, chat }), contextLabel: "project excerpts", autoExecutePlans: true };
      const agent = composeAgentProjectInstructions({ ...base, contextNote: describeSearchSettingsForAgent({ ...settings, chat }) });
      return c.json({
        sections: composeSystemMessageSections(direct),
        systemMessage: composeSystemMessage(direct),
        paths: {
          direct: { label: "Direct answers", sections: composeSystemMessageSections(direct) },
          agent: { label: "Search agent (default in the app)", sections: agent.sections, note: "The agent adds its own tool, grounding and citation rules between the core rules and the project part." },
        },
        defaultTemplate: defaultChatInstructionsTemplate(scope, chat),
        conflicts: findCoreRuleConflicts(instructions),
        ingestConflicts: findCoreRuleConflicts(project.systemPrompt),
        maxChars: CHAT_INSTRUCTIONS_MAX_CHARS,
        scopeDecline: {
          threshold: resolveScopeDeclineThreshold(settings.chat.scopeDeclineThreshold),
          defaultThreshold: DEFAULT_SCOPE_DECLINE_THRESHOLD,
        },
      });
    },
  )
  .post(
    "/:projectId/chat-instructions/improve",
    zValidator("json", draftSchema),
    async (c) => {
      const refused = refuseNonAppActor(c);
      if (refused) return refused;
      const userId = c.get("sessionUser").id;
      const projectId = String(c.req.param("projectId"));
      const access = await getProjectAccess(projectId, userId);
      const project = access ? await getProject(projectId, userId) : null;
      // Improve suggests settings, so it needs edit access, like saving them.
      if (!access || !project) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      if (!canEditProject(access, userId)) return editorRequired(c);

      // The project limit is checked first, so a project refusal never uses up the user's allowance.
      for (const [subject, limit] of [
        [`project:${projectId}`, envInt("CHAT_INSTRUCTIONS_IMPROVE_PROJECT_LIMIT_PER_HOUR", 30)],
        [`user:${userId}`, envInt("CHAT_INSTRUCTIONS_IMPROVE_USER_LIMIT_PER_HOUR", 10)],
      ] as const) {
        const retryAfter = await consumeFeatureRateLimit({ feature: "chat-instructions-improve", subject, limit, windowMs: IMPROVE_WINDOW_MS, requireShared: true });
        if (retryAfter !== null) {
          c.header("Retry-After", String(retryAfter));
          return apiErrorResponse(c, 429, "rate_limited", "Too many Improve requests. Try again later.", { retryAfterSeconds: retryAfter });
        }
      }

      const settings = await getProjectSearchSettings(projectId, userId);
      const body = c.req.valid("json");
      const scope = chatScopeFor(project);
      const draft = (body.instructions === undefined ? settings.chat.searchInstructions : body.instructions)?.trim()
        || defaultChatInstructionsTemplate(scope, settings.chat);
      try {
        resolveImproveModel();
        const result = await improveChatInstructions({
          userId, orgId: project.orgId, projectId, pipeline: project.pipeline,
          draft, scope, chat: settings.chat, signal: c.req.raw.signal,
        });
        return c.json({ ...result, draft, saved: false });
      } catch (error) {
        if (isSpendBlockedError(error)) return spendBlockedResponse(c, error);
        if (error instanceof ImproveUnavailableError) {
          if (error.reason === "privacy_mode") return apiErrorResponse(c, 409, "privacy_mode_blocked", error.message);
          // Model timeouts and provider errors (and a client that left) are 503; nothing was charged.
          return apiErrorResponse(c, 503, "unavailable", error.message);
        }
        throw error;
      }
    },
  );
