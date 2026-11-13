import { quoteStoredDocuments } from "../services/stored-quote.js";
import { SEARCH_SCOPES } from "../lib/search-tiers.js";
import { projectRecommendationVisitsRoutes } from "./project-recommendation-visits.js";
import { ChatToolBlockedError } from "../services/chat-tool-error.js";
import { applyProjectSettingsProposalSchema } from "@docslurp/shared";
import { applySettingsProposal, SettingsProposalError } from "../services/project-settings-proposals.js";
import { reportPublicError } from "../lib/public-errors.js";
import { isCancellation } from "@docslurp/shared/cancellation";
import type { ChatToolActivity } from "../services/chat-mcp-tools.js";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";

import {
  acceptProjectInviteSchema,
  chatRetrievalOverridesSchema,
  chatSearchFiltersSchema,
  createProjectInviteSchema,
  createProjectSchema,
  updateProjectSearchSettingsSchema,
  updateProjectMemberSchema,
  updateProjectSchema,
  projectTemplates,
  projectStateQuerySchema,
  normalizeExtractedText,
  deferredProfilesEnabled,
  indexingModeSchema,
  applyIngestRecommendationSchema,
  ingestReportQuerySchema,
  reprocessIngestRecommendationSchema,
  isProhibitedRoutingModelId,
} from "@docslurp/shared";

import { chatModelRefused, ChatModelNotAllowedError } from "../lib/chat-model-policy.js";
import { actorHasAnyApiKeyScope, getRequestActor, apiKeyCanUseProject, isFirstPartyAppActor, type RequestActor } from "../lib/request-actor.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { isProjectChatAgent } from "../lib/mastra.js";
import { chatVoiceRoutes } from "./chat-voice.js";
import { validationHook } from "../lib/validation.js";
import { appendAuditLog } from "../services/audit-log.js";
import {
  archiveProject,
  cloneProject,
  createProject,
  deleteProject,
  getProject,
  ensurePersonalDefaultProject,
  listProjectBoardRecords,
  getProjectCockpit,
  getProjectTraceFeed,
  listProjectVersions,
  restoreProject,
  listProjects,
  rollbackProjectVersion,
  updateProject,
  ProjectSlugError,
} from "../services/projects.js";
import { listProjectTags } from "../services/project-tags.js";
import { getProjectState } from "../services/project-state.js";
import { ChartExportUnavailableError } from "../services/chart-export-availability.js";
import { applyProjectChange, billingState, ConfigConflictError, estimateProjectChange, planProjectChange } from "../services/config-change.js";
import { mergeProjectSearchSettings } from "../services/search-controls.js";
import { analyzeSearchSettingsChange } from "@docslurp/shared";
import { sql } from "../db.js";
import {
  applyIngestRecommendation,
  IngestReportActionError,
  loadIngestReport,
  reprocessIngestRecommendation,
} from "../services/ingest-report.js";
import { chatProject, projectChatDisabledBody, type ChatSearchActivity } from "../services/project-chat.js";
import { ProjectChatDisabledError } from "../services/project-chat-errors.js";
import { InvalidRetrievalQueryError, parseRetrievalQueryFlags } from "../lib/retrieval-query-flags.js";
import { deleteChatFeedback, upsertChatFeedback } from "../services/chat-feedback.js";
import {
  acceptProjectInvite,
  canEditProject,
  getProjectAccess,
  inviteProjectMember,
  listProjectInvites,
  listProjectMembers,
  OrganizationError,
  removeProjectMember,
  revokeProjectInvite,
  updateProjectMemberRole,
} from "../services/organizations.js";
import {
  getProjectSearchSettingsForUser,
  updateProjectSearchSettingsForUser,
} from "../services/search-controls.js";
import { hybridSearch } from "../services/search.js";
import { parseFilters } from "../search/filters.js";
import { searchHitStatementTimeout } from "../search/timings.js";
import {
  buildProjectChatAuditMetadata,
  createProjectVersionSnapshot,
} from "../services/project-utils.js";
import {
  getMessageText,
  type ProjectChatUIMessage,
} from "@docslurp/shared/project-chat-ui";
import { acceptApiKeys } from "../lib/route-auth.js";
import { authorizeActorProjectSearch } from "../lib/search-access.js";
import { apiKeyCanUpdateContent, CONTENT_UPDATE_SCOPE_MESSAGE } from "../lib/content-update-access.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { indexingModeErrorResponse } from "../lib/indexing-mode-error.js";
import { getRun } from "../services/runs.js";
import { runLifecycle } from "../services/run-lifecycle.js";
import { resolveMaterializationPolicy } from "../services/materialization-policy.js";
import { inlineEstimate, jobMetaFor, jobStatusForMutation, recordJobMeta } from "../services/jobs.js";
import { estimateDocumentReprocess } from "../services/work-estimates.js";
import {
  commitIndexJobs,
  estimateFullIndex,
  estimateModeSwitch,
  IndexingModeError,
  prepareModeSwitchJobs,
  requestFullIndex,
  restoreStoredIndexingMode,
} from "../services/project-indexing-mode.js";

const optionalText = (max: number) => z.string().max(max).nullable().optional();

const chatFeedbackSchema = z.object({
  messageId: z.string().min(1).max(200),
  threadId: optionalText(200),
  rating: z.enum(["up", "down"]),
  comment: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value)),
  question: optionalText(4000),
  answer: optionalText(8000),
  model: optionalText(200),
});

const cloneProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

const rollbackProjectVersionSchema = z.object({
  note: z.string().trim().min(1).max(240).optional(),
});

const projectConfirmationSchema = z.object({
  confirmationText: z.string().trim().min(1).max(240),
});

const PROJECT_SEARCH_STREAM_POLL_MS = 2000;
const PROJECT_SEARCH_STREAM_TIMEOUT_MS = 15000;
const PROJECT_CHAT_STREAM_KEEPALIVE_MS = 10000;

type ProjectChatResponseValue = Awaited<ReturnType<typeof chatProject>>;

type ProjectChatPostBody = {
  speedBoost?: boolean;
  messages?: ProjectChatUIMessage[];
  sessionId?: string;
  model?: string;
  /** Thread retrieval overrides from the composer. */
  retrieval?: unknown;
  /** Composer filters (documents, types, tags, dates). */
  filters?: unknown;
  /** Composer web toggle: web tools for this turn. Default off. */
  webTools?: unknown;
  /** Composer suggestions toggle. Default on for the signed-in app; API keys never get it. */
  suggestions?: unknown;
};

/**
 * Agent modes from the composer toggles. Web tools are off unless the user
 * turns them on. Suggestions mode is on for the signed-in app unless switched
 * off; it is a first-party-app capability, so API keys calling these routes
 * never get it, whatever they send.
 */
function composerAgentModes(body: { webTools?: unknown; suggestions?: unknown }, actor: RequestActor) {
  return {
    web: body.webTools === true,
    suggestions: isFirstPartyAppActor(actor) && body.suggestions !== false,
  };
}

/** Parses the composer's per-thread search scope; undefined when absent, null when invalid. */
function parseChatScope(body: { retrieval?: unknown; filters?: unknown }) {
  const retrieval = body.retrieval === undefined || body.retrieval === null
    ? { success: true as const, data: undefined }
    : chatRetrievalOverridesSchema.safeParse(body.retrieval);
  const filters = body.filters === undefined || body.filters === null
    ? { success: true as const, data: undefined }
    : chatSearchFiltersSchema.safeParse(body.filters);
  if (!retrieval.success || !filters.success) return null;
  return { retrieval: retrieval.data, filters: filters.data };
}

function buildChatRetrievalStatus(response: ProjectChatResponseValue) {
  if (response.ingestReport) {
    return {
      stage: "retrieval" as const,
      status: "success" as const,
      message: "Ingest report built",
      detail: `${response.ingestReport.files.total} files, ${response.ingestReport.pages.total} pages; no model call`,
      resultCount: 0,
    };
  }
  const availability = response.availability;
  const coverage = availability?.coverage;
  const activeRuns =
    (coverage?.queuedRuns ?? 0) + (coverage?.processingRuns ?? 0);

  if (availability?.status === "pending") {
    return {
      stage: "retrieval" as const,
      status: "loading" as const,
      message:
        availability.message ??
        "Documents are still processing; no searchable passages are ready yet.",
      detail: activeRuns
        ? `${activeRuns} active run${activeRuns === 1 ? "" : "s"} still indexing`
        : "Waiting for the first searchable page or chunk",
      resultCount: response.citations.length,
    };
  }

  if (availability?.status === "partial") {
    return {
      stage: "retrieval" as const,
      status: "success" as const,
      message:
        availability.message ??
        "Answer uses the currently indexed portion of the project.",
      detail: `Coverage: ${coverage?.searchableDocuments ?? 0}/${coverage?.totalDocuments ?? 0} docs, ${coverage?.searchablePages ?? 0}/${coverage?.totalPages ?? 0} pages searchable`,
      resultCount: response.citations.length,
    };
  }

  if (availability?.status === "empty") {
    return {
      stage: "retrieval" as const,
      status: "error" as const,
      message:
        availability.message ??
        "No searchable documents are available for this project yet.",
      detail: "Upload PDFs or wait for processing to create searchable content.",
      resultCount: response.citations.length,
    };
  }

  return {
    stage: "retrieval" as const,
    status: "success" as const,
    message: "Project context retrieved",
    detail: response.searchSessionId
      ? `Search session: ${response.searchSessionId}`
      : "Whole project corpus path",
    resultCount: response.citations.length,
  };
}

async function createProjectAgentChatResponse(c: Context) {
  const userId = c.get("sessionUser").id;
  const projectId = c.req.param("projectId");
  if (!projectId) {
    return apiStatusError(c, 400, "Missing projectId");
  }

  const body = await c.req.json<ProjectChatPostBody>();
  if (body.speedBoost !== undefined && typeof body.speedBoost !== "boolean") return apiStatusError(c, 400, "speedBoost must be a boolean");
  const scope = parseChatScope(body);
  if (!scope) return apiStatusError(c, 400, "Invalid retrieval or filters");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const query = lastUserMessage ? getMessageText(lastUserMessage).trim() : "";

  if (!query) {
    return apiStatusError(c, 400, "Missing query");
  }

  // One access read (no dashboard-sized project record): it also yields the explicit search access scope.
  const authorized = await authorizeActorProjectSearch(getRequestActor(c), projectId, "chat");
  if (!authorized.ok) {
    return apiErrorResponse(c, 404, "project_not_found", "Project not found");
  }
  const project = { id: authorized.access.projectId, orgId: authorized.access.orgId };
  const chatDisabled = await projectChatDisabledBody(project.id, userId);
  if (chatDisabled) return apiErrorResponse(c, 403, "chat_disabled", chatDisabled.error);
  if (await chatModelRefused(getRequestActor(c), body.model, project.id)) {
    return apiErrorResponse(c, 400, "model_not_allowed", new ChatModelNotAllowedError().message);
  }

  return createUIMessageStreamResponse({
    headers: {
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
    stream: createUIMessageStream<ProjectChatUIMessage>({
      originalMessages: messages,
      async execute({ writer }) {
        const textPartId = `project-chat-${randomUUID()}`;
        let streamedAnswer = "";
        let textStarted = false;
        let generationStatusWritten = false;
        const searches = new Map<string, ChatSearchActivity>();
        const tools = new Map<string, ChatToolActivity>();

        const writeGenerationStatus = (args: {
          message: string;
          detail?: string;
        }) => {
          generationStatusWritten = true;
          writer.write({
            type: "data-projectStatus",
            id: "project-status",
            data: {
              stage: "generation", subject: query.slice(0, 100), searches: [...searches.values()], tools: [...tools.values()],
              status: "loading",
              message: args.message,
              detail: args.detail,
            },
          });
        };

        const writeCitations = (citations: ProjectChatResponseValue["citations"]) => {
          writer.write({
            type: "data-projectCitations",
            id: "project-citations",
            data: {
              citations: citations.map((citation) => ({
                id: `${citation.citation.documentId}:${citation.citation.chunkIndex}:${citation.citation.pageNumber ?? "na"}`,
                documentId: citation.citation.documentId,
                chunkIndex: citation.citation.chunkIndex,
                filename: citation.citation.filename,
                pageNumber: citation.citation.pageNumber ?? null,
                score: citation.score,
                text: normalizeExtractedText(citation.text),
                headingPath: citation.citation.headingPath,
                locator: citation.citation.locator ?? null,
              })),
            },
          });
        };

        const ensureGenerationStream = () => {
          if (!generationStatusWritten) {
            writeGenerationStatus({
              message: "Streaming grounded answer",
            });
          }
          if (!textStarted) {
            textStarted = true;
            writer.write({
              type: "text-start",
              id: textPartId,
            });
          }
        };

        writer.write({
          type: "data-projectStatus",
          id: "project-status",
          data: {
            stage: "retrieval",
            status: "loading",
            message: "Retrieving project context",
          },
        });

        let keepaliveCount = 0;
        const keepaliveTimer = setInterval(() => {
          keepaliveCount += 1;
          const elapsedSeconds =
            (keepaliveCount * PROJECT_CHAT_STREAM_KEEPALIVE_MS) / 1000;
          writer.write({
            type: "data-projectStatus",
            id: "project-status",
            data: {
              subject: query.slice(0, 100), searches: [...searches.values()], tools: [...tools.values()],
              stage: generationStatusWritten ? "generation" : "retrieval",
              status: "loading",
              message: generationStatusWritten ? "Writing grounded answer" : "Searching project",
              detail: `Project answer is still running (${elapsedSeconds}s)`,
            },
          });
        }, PROJECT_CHAT_STREAM_KEEPALIVE_MS);

        let response: ProjectChatResponseValue;
        try {
          response = await chatProject({
            projectId,
            userId,
            scope: authorized.scope,
            query,
            actor: getRequestActor(c), signal: c.req.raw.signal,
            answerIngestReport: getRequestActor(c).type === "session",
            agent: composerAgentModes(body, getRequestActor(c)),
            onToolActivity: (activity) => {
              tools.set(activity.id, activity);
              writer.write({ type: "data-projectStatus", id: "project-status", data: {
                stage: "generation", status: "loading", message: `Using ${activity.name}`,
                subject: query.slice(0, 100), tools: [...tools.values()], searches: [...searches.values()],
              } });
            },
            sessionId: body.sessionId,
            model: body.model, speedBoost: body.speedBoost === true,
            ...(scope.retrieval ? { retrieval: scope.retrieval } : {}),
            ...(scope.filters ? { filters: scope.filters } : {}),
            onSearchActivity: (activity) => {
              searches.set(activity.id, activity);
              writer.write({ type: "data-projectStatus", id: "project-status", data: {
                stage: "retrieval", status: "loading", message: "Searching documents",
                subject: query.slice(0, 100), searches: [...searches.values()], tools: [...tools.values()],
              } });
            },
            onEvidence: (citations) => {
              writeCitations(citations);
              writeGenerationStatus({
                message: citations.length ? "Writing document-backed answer" : "Checking search coverage",
                detail: `${citations.length} source passages retrieved`,
              });
            },
            onTextDelta: (delta) => {
              if (!delta) {
                return;
              }

              ensureGenerationStream();
              streamedAnswer += delta;
              writer.write({
                type: "text-delta",
                id: textPartId,
                delta,
              });
            },
          });
        } finally {
          clearInterval(keepaliveTimer);
        }

        await appendAuditLog({
          orgId: project.orgId,
          userId,
          projectId: project.id,
          action: "project.chat.requested",
          resourceType: "project-chat",
          resourceId: response.id,
          ipAddress: requestIp(c),
          metadata: {
            ...buildProjectChatAuditMetadata({
              query,
              searchSessionId: response.searchSessionId,
              model: response.debug.model,
              fallback: response.debug.fallback,
              citations: response.citations,
            }),
            toolCalls: response.debug.toolCalls,
            agentId: c.req.param("agentId"),
            sessionId: response.sessionId,
            userAgent: requestUserAgent(c),
          },
        });

        const retrievalStatus = buildChatRetrievalStatus(response);
        const modelDetail = response.debug.model
          ? `Model: ${response.debug.model}`
          : "Retrieved fallback answer";
        const streamedText = normalizeExtractedText(streamedAnswer.trim());
        const remainingAnswer = !streamedText
          ? response.answer
          : response.answer.startsWith(streamedText)
            ? response.answer.slice(streamedText.length)
            : "";

        writer.write({
          type: "data-projectStatus",
          id: "project-status",
          data: retrievalStatus,
        });
        writeGenerationStatus({
          message: streamedText
            ? "Finalizing grounded answer"
            : "Generating grounded answer",
          detail: modelDetail,
        });
        ensureGenerationStream();
        if (remainingAnswer) {
          writer.write({
            type: "text-delta",
            id: textPartId,
            delta: remainingAnswer,
          });
        }
        writer.write({
          type: "text-end",
          id: textPartId,
        });
        writeCitations(response.citations);
        if (response.ingestReport) {
          writer.write({ type: "data-ingestReport", id: "ingest-report", data: { report: response.ingestReport } });
        }
        writer.write({
          type: "data-projectMeta",
          id: "project-meta",
          data: {
            sessionId: response.sessionId,
            searchSessionId: response.searchSessionId,
            model: response.debug.model,
            mode: response.ingestReport ? "ingest-report" : response.debug.mode,
            fallback: response.debug.fallback,
            citations: response.citations.length,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            totalTokens: response.usage.totalTokens,
            costCents: response.usage.costCents,
            costSource: response.usage.costSource,
            runtimeMs: response.runtime.totalMs,
            startedAt: response.runtime.startedAt,
            completedAt: response.runtime.completedAt,
            availability: response.availability,
            ...(response.debug.modes ? { modes: response.debug.modes } : {}),
          },
        });
        writer.write({
          type: "data-projectStatus",
          id: "project-status",
          data: {
            stage: "complete",
            tools: [...tools.values()],
            status:
              response.availability?.status === "empty" ? "error" : "success",
            message:
              response.availability?.status === "pending" ||
              response.availability?.status === "partial"
                ? (response.availability.message ??
                  "Project answer uses the currently indexed content.")
                : response.ingestReport
                  ? "Ingest report ready"
                  : response.debug.fallback
                    ? "Retrieved fallback answer ready"
                    : "Project answer ready",
            detail: retrievalStatus.detail,
            resultCount: response.citations.length,
          },
        });
      },
      onError: (error) => {
        // A Stop press or disconnect aborts the turn: log it as a cancel, not an error.
        if (isCancellation(error, c.req.raw.signal)) console.info("Chat stream cancelled by caller");
        else console.error("Chat stream error:", error);
        const message = reportPublicError(error, {}, c.req.raw.signal);
        return error instanceof ChatToolBlockedError ? error.message : message;
      },
    }),
  });
}

/** Failed project mutations: expected access errors keep their status, anything else is a 400. */
function projectMutationError(c: Context, error: unknown): Response {
  const message = reportPublicError(error);
  const originalMessage = error instanceof Error ? error.message : "";
  if (originalMessage === "Project not found") return apiErrorResponse(c, 404, "project_not_found", message);
  return apiStatusError(c, originalMessage === "Forbidden" ? 403 : 400, message);
}

/**
 * Reject pipeline model selections the project prohibits (Pro/Ultra ids and
 * models priced at or above the output-token ceiling). The chat model path
 * enforces this in lib/chat-model-policy.ts; the project pipeline write path
 * must too, or an operator/client can pin a prohibited model to a stage.
 * Security finding SEC-2026-10-ROUND4-01.
 */
function findProhibitedModelId(value: unknown): string | null {
  if (typeof value === "string") return isProhibitedRoutingModelId(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProhibitedModelId(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = findProhibitedModelId(item);
      if (found) return found;
    }
  }
  return null;
}

/**
 * API-key gate for the search-settings mutation and its estimate, the same as
 * PATCH /:projectId: a server key with the opt-in projects:manage scope
 * (403 otherwise), bound to the project's organization and allowlist (404
 * otherwise). Delegated OAuth tokens are refused outright; their scopes never
 * map to projects:manage, and this keeps that true if the mapping changes.
 * The key owner's edit access is checked by the caller.
 */
async function denySearchSettingsApiKey(
  c: Context,
  actor: Extract<RequestActor, { type: "apiKey" }>,
  projectId: string,
): Promise<Response | null> {
  if (actor.apiKey.keyType !== "server" || actor.apiKey.oauth || !actorHasAnyApiKeyScope(actor, ["projects:manage"])) {
    return apiErrorResponse(c, 403, "forbidden", "This endpoint requires a server API key with the projects:manage scope");
  }
  const project = await getProject(projectId, actor.userId);
  if (!project || !apiKeyCanUseProject(actor.apiKey, project)) {
    return apiErrorResponse(c, 404, "project_not_found", "Project not found");
  }
  return null;
}

/** Runs the search-settings key gate before body validation, so a refused key gets 403/404, never a schema 400. */
const searchSettingsKeyGate: MiddlewareHandler = async (c, next) => {
  const actor = getRequestActor(c);
  if (actor.type === "apiKey") {
    const denied = await denySearchSettingsApiKey(c, actor, String(c.req.param("projectId")));
    if (denied) return denied;
  }
  await next();
};

export const projectsRoutes = new Hono()
  .route("/", projectRecommendationVisitsRoutes)
  .post("/:projectId/settings-proposals/apply", zValidator("json", applyProjectSettingsProposalSchema, validationHook), async c => {
    try {
      const result = await applySettingsProposal({ actor: getRequestActor(c), projectId: String(c.req.param("projectId")), ...c.req.valid("json") });
      return c.json(result);
    } catch (error) {
      if (error instanceof SettingsProposalError) return apiStatusError(c, error.status, error.message, { details: { category: error.category } });
      throw error;
    }
  })
  .route("/", chatVoiceRoutes)
  .post(
    "/invites/:token/accept",
    zValidator("json", acceptProjectInviteSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const member = await acceptProjectInvite(
          c.req.param("token"),
          userId,
        );
        await appendAuditLog({
          userId,
          projectId: member.projectId,
          action: "project.invite.accepted",
          resourceType: "project-member",
          resourceId: `${member.projectId}:${member.userId}`,
          ipAddress: requestIp(c),
          metadata: {
            role: member.role,
            userAgent: requestUserAgent(c),
          },
        });
        return c.json(member);
      } catch (error) {
        // Joining the project's organization would exceed the one-organization-per-user policy.
        if (error instanceof OrganizationError && error.code === "user_already_in_org") {
          return apiStatusError(c, 409, error.message, { code: error.code });
        }
        return apiStatusError(c, 400, reportPublicError(error));
      }
    },
  )
  .get("/templates", async (c) => {
    return c.json({ templates: projectTemplates });
  })
  .get("/", async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    // The project list exposes org internals (pipeline config, budgets,
    // systemPrompt), so a browser/client key must not read it even though it is
    // scope-compatible. Security finding SEC-2026-10-ROUND3-01.
    if (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["ingest", ...SEARCH_SCOPES, "artifacts", "projects:manage"]))) {
      return apiStatusError(c, 403, "Forbidden");
    }
    if (actor.type === "session") await ensurePersonalDefaultProject(userId);
    const projects = await listProjects(userId);
    return c.json({ projects: actor.type === "apiKey"
      ? projects.filter((project) => apiKeyCanUseProject(actor.apiKey, project))
      : projects });
  })
  .get("/board", async (c) => {
    const userId = c.get("sessionUser").id;
    // A dashboard-only user always sees a default project to drop files on.
    if (getRequestActor(c).type === "session") await ensurePersonalDefaultProject(userId);
    const records = await listProjectBoardRecords(userId);
    return c.json({ records });
  })
  .get("/:projectId/cockpit", async (c) => {
    const userId = c.get("sessionUser").id;
    try {
      const cockpit = await getProjectCockpit(
        c.req.param("projectId"),
        userId,
      );
      return c.json(cockpit);
    } catch (error) {
      return apiStatusError(c, 404, reportPublicError(error));
    }
  })
  .get("/:projectId/traces", async (c) => {
    const userId = c.get("sessionUser").id;
    const limit = Number(c.req.query("limit") ?? "12");
    try {
      const traces = await getProjectTraceFeed(
        c.req.param("projectId"),
        userId,
        Number.isFinite(limit) ? limit : 12,
      );
      return c.json(traces);
    } catch (error) {
      return apiStatusError(c, 404, reportPublicError(error));
    }
  })
  .get("/:projectId/versions", async (c) => {
    const userId = c.get("sessionUser").id;
    try {
      const versions = await listProjectVersions(
        c.req.param("projectId"),
        userId,
      );
      return c.json({ versions });
    } catch (error) {
      return apiStatusError(c, 404, reportPublicError(error));
    }
  })
  .get("/:projectId/tags", async (c) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["ingest", ...SEARCH_SCOPES, "artifacts", "projects:manage"]))) {
      return apiStatusError(c, 403, "Forbidden");
    }
    const project = await getProject(c.req.param("projectId"), actor.userId);
    if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) {
      return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    }
    return c.json({ tags: await listProjectTags(project.id) });
  })
  .get("/:projectId/state", zValidator("query", projectStateQuerySchema, validationHook), async (c) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["ingest", ...SEARCH_SCOPES, "artifacts", "projects:manage"]))) {
      return apiStatusError(c, 403, "Forbidden");
    }
    const project = await getProject(c.req.param("projectId"), actor.userId);
    if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) {
      return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    }
    return c.json(await getProjectState({
      projectId: project.id,
      orgId: project.orgId,
      recentWindowHours: c.req.valid("query").recentWindowHours,
    }));
  })
  .get("/:projectId/ingest-report", zValidator("query", ingestReportQuerySchema, validationHook), async (c) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["ingest", ...SEARCH_SCOPES, "artifacts", "projects:manage"]))) {
      return apiStatusError(c, 403, "Forbidden");
    }
    const project = await getProject(c.req.param("projectId"), actor.userId);
    if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) {
      return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    }
    const query = c.req.valid("query");
    const access = await getProjectAccess(project.id, actor.userId);
    // A key can act on findings when it could call the matching action endpoints.
    const keyCanAct = actor.type !== "apiKey" || apiKeyCanUpdateContent(actor.apiKey) || actorHasAnyApiKeyScope(actor, ["projects:manage"]);
    return c.json(await loadIngestReport({
      project,
      canEdit: Boolean(keyCanAct && access && canEditProject(access, actor.userId)),
      runId: query.runId ?? null,
      documentIds: query.documentIds ?? null,
    }));
  })
  .post("/:projectId/ingest-report/apply", zValidator("json", applyIngestRecommendationSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    // Applying a finding changes project settings, so keys need the same scope as PATCH /:projectId.
    if (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["projects:manage"]))) {
      return apiStatusError(c, 403, "This endpoint requires a server API key with the projects:manage scope");
    }
    const project = await getProject(c.req.param("projectId"), userId);
    if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    const body = c.req.valid("json");
    try {
      const result = await applyIngestRecommendation({ project, userId, recommendationId: body.recommendationId, runId: body.runId ?? null, documentIds: body.documentIds ?? null });
      await appendAuditLog({
        orgId: project.orgId,
        userId,
        projectId: project.id,
        apiKeyId: actor.type === "apiKey" ? actor.apiKey.keyId : null,
        action: "project.updated",
        resourceType: "project",
        resourceId: project.id,
        ipAddress: requestIp(c),
        metadata: {
          source: "ingest-report",
          recommendationId: body.recommendationId,
          patch: result.recommendation.patch,
          snapshot: createProjectVersionSnapshot(result.project),
          userAgent: requestUserAgent(c),
        },
      });
      return c.json({ recommendationId: body.recommendationId, patch: result.recommendation.patch, pipeline: result.pipeline });
    } catch (error) {
      if (error instanceof IngestReportActionError) return apiStatusError(c, error.status, error.message);
      throw error;
    }
  })
  .post("/:projectId/ingest-report/reprocess", zValidator("json", reprocessIngestRecommendationSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !apiKeyCanUpdateContent(actor.apiKey)) return apiStatusError(c, 403, CONTENT_UPDATE_SCOPE_MESSAGE);
    const project = await getProject(c.req.param("projectId"), userId);
    if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    const body = c.req.valid("json");
    try {
      const result = await reprocessIngestRecommendation({ project, userId, speedBoost: body.speedBoost === true, recommendationId: body.recommendationId, runId: body.runId ?? null, documentIds: body.documentIds ?? null });
      await appendAuditLog({
        orgId: project.orgId,
        userId,
        projectId: project.id,
        apiKeyId: actor.type === "apiKey" ? actor.apiKey.keyId : null,
        action: "documents.bulk_reprocessed",
        resourceType: "document-bulk",
        resourceId: result.documentIds.join(","),
        ipAddress: requestIp(c),
        metadata: {
          source: "ingest-report",
          recommendationId: body.recommendationId,
          count: result.documentIds.length,
          runs: result.runs.map((run) => run.id),
          estimatedCents: result.estimatedCents,
          userAgent: requestUserAgent(c),
        },
      });
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof IngestReportActionError) return apiStatusError(c, error.status, error.message);
      throw error;
    }
  })
  .get("/:projectId", async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["ingest", ...SEARCH_SCOPES, "artifacts", "projects:manage"]))) {
      return apiStatusError(c, 403, "Forbidden");
    }
    const project = await getProject(c.req.param("projectId"), userId);

    if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) {
      return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    }

    return c.json(project);
  })
  .get("/:projectId/search-settings", async (c) => {
    const userId = c.get("sessionUser").id;
    const settings = await getProjectSearchSettingsForUser(
      c.req.param("projectId"),
      userId,
    );

    if (!settings) {
      return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    }

    return c.json(settings);
  })
  .get("/:projectId/search/stream", async (c) => {
    const query = c.req.query("q");
    const userId = c.get("sessionUser").id;
    if (!query) {
      return apiStatusError(c, 400, "Missing q");
    }

    const authorized = await authorizeActorProjectSearch(getRequestActor(c), c.req.param("projectId"), "search");
    if (!authorized.ok) {
      return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    }

    const runId = c.req.query("runId");
    const limit = c.req.query("limit");
    const variant = c.req.query("variant");
    // Omitted flags stay undefined so the project's retrieval defaults apply
    // (they used to become false); graph and multi-hop flags are honoured too.
    let flags: ReturnType<typeof parseRetrievalQueryFlags>;
    try {
      flags = parseRetrievalQueryFlags((name) => c.req.query(name));
    } catch (error) {
      if (error instanceof InvalidRetrievalQueryError) return apiStatusError(c, 400, error.message);
      throw error;
    }
    const rootSessionId = c.req.query("sessionId") ?? randomUUID();

    const filters = parseFilters({
      documentId: c.req.query("documentId") ?? "",
      runId: runId ?? "",
      projectId: c.req.param("projectId"),
      filenameContains: c.req.query("filenameContains") ?? "",
      mimeTypes: c.req.query("mimeTypes") ?? "",
      tags: c.req.query("tags") ?? "",
      pageFrom: c.req.query("pageFrom") ?? "",
      pageTo: c.req.query("pageTo") ?? "",
      language: c.req.query("language") ?? "",
      heading: c.req.query("heading") ?? "",
      dateFrom: c.req.query("dateFrom") ?? "",
      dateTo: c.req.query("dateTo") ?? "",
    });

    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "status",
        data: JSON.stringify({
          stage: "retrieval",
          message: "Running project search",
        }),
      });

      const deadline = Date.now() + PROJECT_SEARCH_STREAM_TIMEOUT_MS;
      let latestResponse: Awaited<ReturnType<typeof hybridSearch>> | null =
        null;

      while (Date.now() < deadline && !stream.aborted) {
        latestResponse = await hybridSearch(query, userId, {
          runId: runId || undefined,
          limit: limit ? Number(limit) : undefined,
          ...flags,
          filters,
          variant: variant || undefined,
          rootSessionId,
        }, authorized.scope);

        await stream.writeSSE({
          event: "results",
          data: JSON.stringify({
            results: latestResponse.results,
            sessionId: latestResponse.sessionId,
            availability: latestResponse.availability,
          }),
        });

        const activeRunCount =
          (latestResponse.availability?.coverage.queuedRuns ?? 0) +
          (latestResponse.availability?.coverage.processingRuns ?? 0);
        if (
          latestResponse.availability?.status === "complete" ||
          latestResponse.availability?.status === "empty" ||
          activeRunCount === 0 ||
          // A statement that hit SEARCH_STATEMENT_TIMEOUT_MS would time out again on the next poll.
          searchHitStatementTimeout(latestResponse)
        ) {
          break;
        }

        await stream.writeSSE({
          event: "status",
          data: JSON.stringify({
            stage: "indexing",
            message:
              latestResponse.availability?.message ??
              "Waiting for more searchable content",
            availability: latestResponse.availability,
            pollMs: PROJECT_SEARCH_STREAM_POLL_MS,
          }),
        });

        await stream.sleep(PROJECT_SEARCH_STREAM_POLL_MS);
      }

      // The latest snapshot is already persisted and delivered. Finalization
      // must not repeat retrieval (or incur another embedding/model call).
      if (!latestResponse || stream.aborted) return;

      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          sessionId: latestResponse.sessionId,
          resultCount: latestResponse.results.length,
          availability: latestResponse.availability,
        }),
      });
    });
  })
  .post("/:projectId/chat/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    if (!agentId || !isProjectChatAgent(agentId)) {
      return apiStatusError(c, 404, "Agent not found");
    }

    return createProjectAgentChatResponse(c);
  })
  .put(
    "/:projectId/chat/feedback",
    zValidator("json", chatFeedbackSchema, validationHook),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const projectId = c.req.param("projectId");
      const project = await getProject(projectId, userId);
      if (!project) {
        return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      }

      const feedback = await upsertChatFeedback({ ...c.req.valid("json"), projectId, userId });
      return c.json({ feedback });
    },
  )
  .delete("/:projectId/chat/feedback/:messageId", async (c) => {
    const userId = c.get("sessionUser").id;
    const projectId = c.req.param("projectId");
    const project = await getProject(projectId, userId);
    if (!project) {
      return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    }

    await deleteChatFeedback({ projectId, userId, messageId: c.req.param("messageId") });
    return c.json({ ok: true });
  })
  .get("/:projectId/members", async (c) => {
    const userId = c.get("sessionUser").id;
    try {
      const members = await listProjectMembers(
        c.req.param("projectId"),
        userId,
      );
      return c.json({ members });
    } catch (error) {
      return apiStatusError(c, 404, reportPublicError(error));
    }
  })
  .get("/:projectId/invites", async (c) => {
    const userId = c.get("sessionUser").id;
    try {
      const invites = await listProjectInvites(
        c.req.param("projectId"),
        userId,
      );
      return c.json({ invites });
    } catch (error) {
      return apiStatusError(c, 404, reportPublicError(error));
    }
  })
  .post("/", zValidator("json", createProjectSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const valid = c.req.valid("json");
    const prohibitedModel = findProhibitedModelId(valid.pipeline);
    if (prohibitedModel) {
      return apiErrorResponse(c, 400, "invalid_request", `Model "${prohibitedModel}" is not permitted in pipeline configuration`);
    }
    // The schema defaults a missing pipeline.indexingMode to "full"; only an explicit
    // mode in the raw body may override the organization default.
    const raw = await c.req.json().catch(() => null) as { pipeline?: { indexingMode?: unknown } } | null;
    const explicit = indexingModeSchema.safeParse(raw?.pipeline?.indexingMode).success;
    const { indexingMode: _defaulted, ...pipelineWithoutMode } = valid.pipeline ?? ({} as NonNullable<typeof valid.pipeline>);
    const input = {
      ...valid,
      userId,
      ...(valid.pipeline && !explicit ? { pipeline: pipelineWithoutMode as NonNullable<typeof valid.pipeline> } : {}),
    };
    let project;
    try {
      project = await createProject(input);
    } catch (error) {
      if (error instanceof IndexingModeError) return indexingModeErrorResponse(c, error);
      throw error;
    }
    await appendAuditLog({
      orgId: project.orgId,
      userId,
      projectId: project.id,
      action: "project.created",
      resourceType: "project",
      resourceId: project.id,
      ipAddress: requestIp(c),
      metadata: {
        templateKey: project.templateKey,
        snapshot: createProjectVersionSnapshot(project),
        userAgent: requestUserAgent(c),
      },
    });
    return c.json(project, 201);
  })
  .post(
    "/:projectId/clone",
    zValidator("json", cloneProjectSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const input = c.req.valid("json");
        const source = await getProject(c.req.param("projectId"), userId);
        if (!source) {
          return apiErrorResponse(c, 404, "project_not_found", "Project not found");
        }

        const project = await cloneProject(
          c.req.param("projectId"),
          userId,
          input.name,
        );
        await appendAuditLog({
          orgId: project.orgId,
          userId,
          projectId: project.id,
          action: "project.cloned",
          resourceType: "project",
          resourceId: project.id,
          ipAddress: requestIp(c),
          metadata: {
            note: `Cloned from ${source.name}`,
            sourceProjectId: source.id,
            snapshot: createProjectVersionSnapshot(project),
            userAgent: requestUserAgent(c),
          },
        });
        return c.json(project, 201);
      } catch (error) {
        return apiStatusError(c, 400, reportPublicError(error));
      }
    },
  )
  .post(
    "/:projectId/archive",
    zValidator("json", projectConfirmationSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const project = await archiveProject(
          c.req.param("projectId"),
          userId,
          c.req.valid("json").confirmationText,
        );

        await appendAuditLog({
          orgId: project.orgId,
          userId,
          projectId: project.id,
          action: "project.archived",
          resourceType: "project",
          resourceId: project.id,
          ipAddress: requestIp(c),
          metadata: {
            snapshot: createProjectVersionSnapshot(project),
            archivedAt: project.archivedAt,
            userAgent: requestUserAgent(c),
          },
        });

        return c.json(project);
      } catch (error) {
        return projectMutationError(c, error);
      }
    },
  )
  .post(
    "/:projectId/restore",
    zValidator("json", projectConfirmationSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const project = await restoreProject(
          c.req.param("projectId"),
          userId,
          c.req.valid("json").confirmationText,
        );

        await appendAuditLog({
          orgId: project.orgId,
          userId,
          projectId: project.id,
          action: "project.restored",
          resourceType: "project",
          resourceId: project.id,
          ipAddress: requestIp(c),
          metadata: {
            snapshot: createProjectVersionSnapshot(project),
            userAgent: requestUserAgent(c),
          },
        });

        return c.json(project);
      } catch (error) {
        return projectMutationError(c, error);
      }
    },
  )
  .post(
    "/:projectId/invites",
    zValidator("json", createProjectInviteSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const inviteInput = { ...c.req.valid("json"), userId };
        const invite = await inviteProjectMember(
          c.req.param("projectId"),
          inviteInput,
        );
        await appendAuditLog({
          orgId: invite.orgId,
          userId,
          projectId: invite.projectId,
          action: "project.invite.sent",
          resourceType: "project-invite",
          resourceId: invite.id,
          ipAddress: requestIp(c),
          metadata: {
            email: invite.email,
            role: invite.role,
            userAgent: requestUserAgent(c),
          },
        });
        return c.json(invite, 201);
      } catch (error) {
        return apiStatusError(c, 400, reportPublicError(error));
      }
    },
  )
  .delete("/:projectId/invites/:inviteId", async (c) => {
    try {
      const userId = c.get("sessionUser").id;
      const invite = await revokeProjectInvite({
        projectId: c.req.param("projectId"),
        userId,
        inviteId: c.req.param("inviteId"),
      });

      await appendAuditLog({
        orgId: invite.orgId,
        userId,
        projectId: invite.projectId,
        action: "project.invite.revoked",
        resourceType: "project-invite",
        resourceId: invite.id,
        ipAddress: requestIp(c),
        metadata: {
          email: invite.email,
          role: invite.role,
          status: invite.status,
          userAgent: requestUserAgent(c),
        },
      });
      return c.json(invite);
    } catch (error) {
      return apiStatusError(c, 400, reportPublicError(error));
    }
  })
  .patch(
    "/:projectId/members/:memberUserId",
    zValidator("json", updateProjectMemberSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const member = await updateProjectMemberRole({
          projectId: c.req.param("projectId"),
          userId,
          memberUserId: c.req.param("memberUserId"),
          role: c.req.valid("json").role,
        });
        await appendAuditLog({
          userId,
          projectId: member.projectId,
          action: "project.member.updated",
          resourceType: "project-member",
          resourceId: `${member.projectId}:${member.userId}`,
          ipAddress: requestIp(c),
          metadata: {
            role: member.role,
            targetUserId: member.userId,
            userAgent: requestUserAgent(c),
          },
        });
        return c.json(member);
      } catch (error) {
        return apiStatusError(c, 400, reportPublicError(error));
      }
    },
  )
  .delete("/:projectId/members/:memberUserId", async (c) => {
    try {
      const userId = c.get("sessionUser").id;
      const removed = await removeProjectMember({
        projectId: c.req.param("projectId"),
        userId,
        memberUserId: c.req.param("memberUserId"),
      });

      if (!removed) {
        return apiStatusError(c, 404, "Project membership not found");
      }

      await appendAuditLog({
        userId,
        projectId: c.req.param("projectId"),
        action: "project.member.removed",
        resourceType: "project-member",
        resourceId: `${c.req.param("projectId")}:${c.req.param("memberUserId")}`,
        ipAddress: requestIp(c),
        metadata: {
          targetUserId: c.req.param("memberUserId"),
          userAgent: requestUserAgent(c),
        },
      });
      return c.json({ ok: true });
    } catch (error) {
      return apiStatusError(c, 400, reportPublicError(error));
    }
  })
  .post("/:projectId/chat", async (c) => {
    const body = await c.req.json<{
      q?: string;
      speedBoost?: boolean;
      sessionId?: string;
      model?: string;
      retrievalOnly?: boolean;
      retrieval?: unknown;
      filters?: unknown;
      webTools?: unknown;
      suggestions?: unknown;
    }>();
    if (!body.q) {
      return apiStatusError(c, 400, "Missing q");
    }
    if (body.speedBoost !== undefined && typeof body.speedBoost !== "boolean") return apiStatusError(c, 400, "speedBoost must be a boolean");
    const scope = parseChatScope(body);
    if (!scope) return apiStatusError(c, 400, "Invalid retrieval or filters");

    const userId = c.get("sessionUser").id;
    const authorized = await authorizeActorProjectSearch(getRequestActor(c), c.req.param("projectId"), "chat");
    if (!authorized.ok) {
      return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    }
    const project = { id: authorized.access.projectId, orgId: authorized.access.orgId };

    let response: Awaited<ReturnType<typeof chatProject>>;
    try {
      response = await chatProject({
        projectId: c.req.param("projectId"),
        userId,
        scope: authorized.scope,
        query: body.q,
        actor: body.retrievalOnly === true ? undefined : getRequestActor(c), signal: c.req.raw.signal,
        allowConfiguration: body.retrievalOnly === true ? false : undefined,
        answerIngestReport: getRequestActor(c).type === "session",
        agent: composerAgentModes(body, getRequestActor(c)),
        sessionId: body.sessionId,
        model: body.model, speedBoost: body.speedBoost === true,
        ...(scope.retrieval ? { retrieval: scope.retrieval } : {}),
        ...(scope.filters ? { filters: scope.filters } : {}),
      });
    } catch (error) {
      if (error instanceof ChatModelNotAllowedError) return apiErrorResponse(c, 400, "model_not_allowed", error.message);
      if (error instanceof ProjectChatDisabledError) return apiErrorResponse(c, 403, "chat_disabled", error.message);
      throw error;
    }

    await appendAuditLog({
      orgId: project.orgId,
      userId,
      projectId: project.id,
      action: "project.chat.requested",
      resourceType: "project-chat",
      resourceId: response.id,
      ipAddress: requestIp(c),
      metadata: {
        ...buildProjectChatAuditMetadata({
          query: body.q,
          searchSessionId: response.searchSessionId,
          model: response.debug.model,
          fallback: response.debug.fallback,
          citations: response.citations,
        }),
        sessionId: response.sessionId,
        userAgent: requestUserAgent(c),
      },
    });

    return c.json(response);
  })
  .post(
    "/:projectId/versions/:versionId/rollback",
    zValidator("json", rollbackProjectVersionSchema, validationHook),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const input = c.req.valid("json");
      try {
        const project = await rollbackProjectVersion(
          c.req.param("projectId"),
          userId,
          c.req.param("versionId"),
        );

        await appendAuditLog({
          orgId: project.orgId,
          userId,
          projectId: project.id,
          action: "project.rollback",
          resourceType: "project",
          resourceId: project.id,
          ipAddress: requestIp(c),
          metadata: {
            note:
              input.note ??
              `Rolled back to version ${c.req.param("versionId").slice(0, 8)}`,
            sourceVersionId: c.req.param("versionId"),
            snapshot: createProjectVersionSnapshot(project),
            userAgent: requestUserAgent(c),
          },
        });

        return c.json(project);
      } catch (error) {
        return apiStatusError(c, 400, reportPublicError(error));
      }
    },
  )
  .patch(
    "/:projectId/search-settings",
    searchSettingsKeyGate,
    zValidator("json", updateProjectSearchSettingsSchema, validationHook),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const actor = getRequestActor(c);
      const project = await getProject(String(c.req.param("projectId")), userId);
      if (!project) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      const settings = await updateProjectSearchSettingsForUser({
        projectId: project.id,
        userId,
        input: c.req.valid("json"),
      });

      if (!settings) {
        return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      }

      await appendAuditLog({
        orgId: project.orgId,
        userId,
        projectId: project.id,
        action: "project.search-settings.updated",
        resourceType: "project-search-settings",
        resourceId: project.id,
        apiKeyId: actor.type === "apiKey" ? actor.apiKey.keyId : null,
        ipAddress: requestIp(c),
        metadata: {
          retrievalDefaults: settings.retrievalDefaults,
          chat: settings.chat,
          userAgent: requestUserAgent(c),
        },
      });

      return c.json(settings);
    },
  )
  .patch(
    "/:projectId",
    zValidator("json", updateProjectSchema, validationHook),
    async (c) => {
      const projectId = String(c.req.param("projectId"));
      const userId = c.get("sessionUser").id;
      const actor = getRequestActor(c);
      if (actor.type === "apiKey") {
        // Opt-in server-key scope, bound to the key's organization; the key
        // owner's project role still decides what may change.
        if (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["projects:manage"])) {
          return apiStatusError(c, 403, "This endpoint requires a server API key with the projects:manage scope");
        }
        const current = await getProject(projectId, userId);
        if (!current || !apiKeyCanUseProject(actor.apiKey, current)) {
          return apiErrorResponse(c, 404, "project_not_found", "Project not found");
        }
      }
      const prohibitedModel = findProhibitedModelId(c.req.valid("json").pipeline);
      if (prohibitedModel) {
        return apiErrorResponse(c, 400, "invalid_request", `Model "${prohibitedModel}" is not permitted in pipeline configuration`);
      }
      // The schema defaults a missing pipeline.indexingMode to "full", so read the raw body
      // to tell an explicit mode change (and `indexAll`) from an unrelated pipeline edit.
      const raw = deferredProfilesEnabled() ? await c.req.json().catch(() => null) as Record<string, unknown> | null : null;
      const rawPipeline = raw?.pipeline as { indexingMode?: unknown } | undefined;
      const requestedMode = indexingModeSchema.safeParse(rawPipeline?.indexingMode);
      const before = requestedMode.success ? await getProject(projectId, userId) : null;
      const modeChange = before && before.pipeline.indexingMode !== requestedMode.data ? before : null;
      const fail = (error: unknown) => {
        if (error instanceof IndexingModeError) return indexingModeErrorResponse(c, error);
        throw error;
      };

      // Validate the jobs this change implies before saving it, so a rejected switch leaves the mode alone.
      let prepared: Awaited<ReturnType<typeof prepareModeSwitchJobs>> | null = null;
      if (modeChange && requestedMode.success) {
        try {
          const resolved = await resolveMaterializationPolicy({
            projectPipeline: modeChange.pipeline,
            apiKey: actor.type === "apiKey" ? actor.apiKey : null,
            projectId: modeChange.id,
          });
          if ("policy" in resolved) {
            prepared = await prepareModeSwitchJobs({
              project: modeChange, speedBoost: raw?.speedBoost === true, to: requestedMode.data, indexAll: raw?.indexAll === true, actor, policy: resolved.policy,
            });
          }
        } catch (error) {
          return fail(error);
        }
      }

      const input = c.req.valid("json");
      let applied: Awaited<ReturnType<typeof applyProjectChange>>;
      try {
        const plan = await planProjectChange({
          projectId, userId, input, indexingMode: requestedMode.success ? requestedMode.data : undefined,
        });
        applied = plan
          ? await applyProjectChange({ plan, userId, updateOptions: requestedMode.success ? { indexingMode: requestedMode.data } : undefined })
          : null;
      } catch (error) {
        if (error instanceof ProjectSlugError) return apiStatusError(c, error.status, error.message);
        if (error instanceof ConfigConflictError) return apiStatusError(c, error.status, error.message, { details: { category: error.code } });
        if (error instanceof ChartExportUnavailableError) return apiStatusError(c, error.status, error.message, { details: { category: error.code } });
        return fail(error);
      }

      if (!applied) {
        return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      }
      const project = applied.project;
      for (const runId of applied.queuedRunIds) {
        try {
          const run = await getRun(runId, userId);
          if (run) await runLifecycle.start(run);
        } catch (error) {
          // The run-start recovery sweeper starts runs whose workflow start was never confirmed.
          console.warn(`[config-change] run=${runId} start deferred: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      let indexingJob: { runIds: string[] } | undefined;
      if (modeChange && prepared && prepared.batches.length > 0) {
        try {
          const started = await commitIndexJobs(prepared, userId);
          for (const runId of started.runIds) {
            const run = await getRun(runId, userId);
            if (run) await runLifecycle.start(run);
          }
          if (started.runIds.length > 0) indexingJob = { runIds: started.runIds };
        } catch (error) {
          // Jobs could not be admitted (credits, budget, races): do not leave the mode switched.
          await restoreStoredIndexingMode(project.id, modeChange.pipeline.indexingMode);
          return fail(error);
        }
      }

      await appendAuditLog({
        orgId: project.orgId,
        userId,
        projectId: project.id,
        action: "project.updated",
        resourceType: "project",
        resourceId: project.id,
        apiKeyId: actor.type === "apiKey" ? actor.apiKey.keyId : null,
        ipAddress: requestIp(c),
        metadata: {
          snapshot: createProjectVersionSnapshot(project),
          userAgent: requestUserAgent(c),
        },
      });

      return c.json({ ...project, ...(indexingJob ? { indexingJob } : {}), ...(applied.job ? { job: applied.job } : {}) });
    },
  )
  .post(
    "/:projectId/estimate",
    zValidator("json", updateProjectSchema, validationHook),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const project = await getProject(c.req.param("projectId"), userId);
      if (!project) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      const actor = getRequestActor(c);
      // Same gates as PATCH /:projectId: a server key with projects:manage, bound to its organization,
      // and a caller who could edit the project.
      if (actor.type === "apiKey") {
        if (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["projects:manage"])) {
          return apiErrorResponse(c, 403, "forbidden", "This endpoint requires a server API key with the projects:manage scope");
        }
        if (!apiKeyCanUseProject(actor.apiKey, project)) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      }
      const access = await getProjectAccess(project.id, userId);
      if (!access || !canEditProject(access, userId)) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      const result = await estimateProjectChange({ projectId: project.id, userId, input: c.req.valid("json") });
      if (!result) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      return c.json(result);
    },
  )
  .post(
    "/:projectId/search-settings/estimate",
    // Same gates as the PATCH. The MCP in-process forward bypasses sessionAuth, so they run here.
    searchSettingsKeyGate,
    zValidator("json", updateProjectSearchSettingsSchema, validationHook),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const projectId = String(c.req.param("projectId"));
      const before = await getProjectSearchSettingsForUser(projectId, userId);
      const access = before ? await getProjectAccess(projectId, userId) : null;
      if (!before || !access || !canEditProject(access, userId)) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      const after = mergeProjectSearchSettings(before, c.req.valid("json"));
      return c.json({ impact: analyzeSearchSettingsChange(before, after), estimate: null, billing: billingState() });
    },
  )
  .post(
    "/:projectId/indexing-mode/estimate",
    zValidator("json", z.object({ mode: indexingModeSchema, speedBoost: z.boolean().optional() }), validationHook),
    async (c) => {
      if (!deferredProfilesEnabled()) return apiErrorResponse(c, 404, "not_found", "Not found");
      const userId = c.get("sessionUser").id;
      const project = await getProject(c.req.param("projectId"), userId);
      if (!project) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      const actor = getRequestActor(c);
      if (actor.type === "apiKey") {
        // Switching the indexing mode is a project PATCH, so its estimate needs the PATCH's key gate.
        if (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["projects:manage"])) {
          return apiErrorResponse(c, 403, "forbidden", "This endpoint requires a server API key with the projects:manage scope");
        }
        if (!apiKeyCanUseProject(actor.apiKey, project)) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      }
      return c.json(await estimateModeSwitch(project.id, c.req.valid("json").mode, c.req.valid("json").speedBoost === true));
    },
  )
  .post(
    "/:projectId/full-index",
    zValidator("json", z.object({ speedBoost: z.boolean().optional(), documentIds: z.array(z.string().min(1)).max(500).optional() }).default({}), validationHook),
    async (c) => {
      if (!deferredProfilesEnabled()) return apiErrorResponse(c, 404, "not_found", "Not found");
      const userId = c.get("sessionUser").id;
      const actor = getRequestActor(c);
      const project = await getProject(c.req.param("projectId"), userId);
      if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) {
        return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      }
      if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest"])) {
        return apiErrorResponse(c, 403, "forbidden", "Forbidden");
      }
      const access = await getProjectAccess(project.id, userId);
      if (!access || !canEditProject(access, userId)) return apiErrorResponse(c, 403, "forbidden", "Forbidden");
      const resolved = await resolveMaterializationPolicy({
        projectPipeline: project.pipeline,
        apiKey: actor.type === "apiKey" ? actor.apiKey : null,
        capabilityHeader: c.req.header("X-DocSlurp-Capability"),
        origin: c.req.header("Origin"),
        projectId: project.id,
      });
      if ("error" in resolved) return apiErrorResponse(c, 403, "forbidden", "Invalid capability", { category: resolved.error });
      try {
        const inline = await inlineEstimate(
          () => estimateFullIndex({ speedBoost: c.req.valid("json").speedBoost === true, projectId: project.id, orgId: project.orgId, documentIds: c.req.valid("json").documentIds }),
          `/v1/projects/${project.id}/full-index/estimate`,
        );
        const result = await requestFullIndex({
          speedBoost: c.req.valid("json").speedBoost === true,
          orgId: project.orgId,
          projectId: project.id,
          documentIds: c.req.valid("json").documentIds,
          actor,
          policy: resolved.policy,
        });
        const meta = jobMetaFor(result.runId, "full-index", inline);
        await recordJobMeta([result.runId], meta);
        const run = await getRun(result.runId, userId);
        if (run) await runLifecycle.start(run);
        const job = await jobStatusForMutation(meta, [result.runId], userId);
        return c.json({ runId: result.runId, pages: result.pages, estimatedCredits: result.estimatedCredits, billing: result.billing, job }, 202);
      } catch (error) {
        if (error instanceof IndexingModeError) return indexingModeErrorResponse(c, error);
        throw error;
      }
    },
  )
  .post(
    "/:projectId/full-index/estimate",
    zValidator("json", z.object({ speedBoost: z.boolean().optional(), documentIds: z.array(z.string().min(1)).max(500).optional() }).default({})),
    async (c) => {
      if (!deferredProfilesEnabled()) return apiErrorResponse(c, 404, "not_found", "Not found");
      const userId = c.get("sessionUser").id;
      const actor = getRequestActor(c);
      const project = await getProject(c.req.param("projectId"), userId);
      if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) {
        return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      }
      // Same gates as the mutation: ingest scope, edit access and a policy that allows a full-index request.
      if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest"])) {
        return apiErrorResponse(c, 403, "forbidden", "Forbidden");
      }
      const access = await getProjectAccess(project.id, userId);
      if (!access || !canEditProject(access, userId)) return apiErrorResponse(c, 403, "forbidden", "Forbidden");
      const resolved = await resolveMaterializationPolicy({
        projectPipeline: project.pipeline,
        apiKey: actor.type === "apiKey" ? actor.apiKey : null,
        capabilityHeader: c.req.header("X-DocSlurp-Capability"),
        origin: c.req.header("Origin"),
        projectId: project.id,
      });
      if ("error" in resolved) return apiErrorResponse(c, 403, "forbidden", "Invalid capability", { category: resolved.error });
      if (!resolved.policy.allowFullIndexRequest) {
        return apiErrorResponse(c, 403, "forbidden", "This key or capability may not request a full index.", { category: "full_index_not_allowed" });
      }
      const documentIds = c.req.valid("json").documentIds;
      const estimate = await estimateFullIndex({ speedBoost: c.req.valid("json").speedBoost === true, projectId: project.id, orgId: project.orgId, documentIds });
      const quote = estimate
        ? await quoteStoredDocuments({ scope: { orgId: project.orgId, projectId: project.id, ...(documentIds ? { documentIds } : {}) }, pipeline: project.pipeline, estimate, settings: { indexing: "full" } })
        : null;
      return c.json({ estimate, quote, billing: billingState() });
    },
  )
  .post(
    "/:projectId/documents/bulk/estimate",
    zValidator("json", z.object({
      speedBoost: z.boolean().optional(),
      action: z.enum(["reprocess", "export-artifacts", "apply-tags", "remove-tags", "delete"]),
      documentIds: z.array(z.string()).min(1),
      tags: z.array(z.string()).optional(),
    })),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const actor = getRequestActor(c);
      if (actor.type === "apiKey" && !apiKeyCanUpdateContent(actor.apiKey)) return apiStatusError(c, 403, CONTENT_UPDATE_SCOPE_MESSAGE);
      const project = await getProject(c.req.param("projectId"), userId);
      if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      const body = c.req.valid("json");
      const estimate = body.action === "reprocess"
        ? await estimateDocumentReprocess({ speedBoost: body.speedBoost === true, documentIds: body.documentIds, userId, projectId: project.id })
        : null;
      // Scoped to this project's documents: estimateDocumentReprocess already dropped any the caller cannot edit.
      const quote = estimate
        ? await quoteStoredDocuments({ scope: { orgId: project.orgId, projectId: project.id, documentIds: body.documentIds }, pipeline: project.pipeline, estimate, settings: { speedBoost: body.speedBoost === true } })
        : null;
      return c.json({ estimate, quote, billing: billingState() });
    },
  )
  .delete(
    "/:projectId",
    zValidator("json", projectConfirmationSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const deleted = await deleteProject(
          c.req.param("projectId"),
          userId,
          c.req.valid("json").confirmationText,
        );

        await appendAuditLog({
          orgId: deleted.orgId,
          userId,
          projectId: null,
          action: "project.deleted",
          resourceType: "project",
          resourceId: deleted.id,
          ipAddress: requestIp(c),
          metadata: {
            projectName: deleted.name,
            archivedAt: deleted.archivedAt,
            userAgent: requestUserAgent(c),
          },
        });

        return c.json({
          ok: true,
          projectId: deleted.id,
          projectName: deleted.name,
        });
      } catch (error) {
        return projectMutationError(c, error);
      }
    },
  );

// Project reads and rename/settings updates (the PATCHes and their estimates require projects:manage).
acceptApiKeys(projectsRoutes, ["PATCH /:projectId/search-settings", "POST /:projectId/search-settings/estimate", "GET /", "GET /:projectId", "GET /:projectId/tags", "GET /:projectId/state", "GET /:projectId/ingest-report", "POST /:projectId/ingest-report/apply", "POST /:projectId/ingest-report/reprocess", "POST /:projectId/documents/bulk/estimate", "PATCH /:projectId", "POST /:projectId/estimate", "POST /:projectId/full-index", "POST /:projectId/full-index/estimate", "POST /:projectId/indexing-mode/estimate"]);
