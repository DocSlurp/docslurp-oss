import { reportPublicError } from "../lib/public-errors.js";
import type { ChatToolActivity } from "../services/chat-mcp-tools.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";

import {
  acceptWorkspaceInviteSchema,
  chatRetrievalOverridesSchema,
  chatSearchFiltersSchema,
  createWorkspaceInviteSchema,
  createWorkspaceSchema,
  updateWorkspaceSearchSettingsSchema,
  updateWorkspaceMemberSchema,
  updateWorkspaceSchema,
  workspaceTemplates,
  workspaceStateQuerySchema,
  normalizeExtractedText,
  deferredProfilesEnabled,
  indexingModeSchema,
  applyIngestRecommendationSchema,
  ingestReportQuerySchema,
  reprocessIngestRecommendationSchema,
} from "@docslurp/shared";

import { chatModelRefused, ChatModelNotAllowedError } from "../lib/chat-model-policy.js";
import { actorHasAnyApiKeyScope, getRequestActor, apiKeyCanUseWorkspace } from "../lib/request-actor.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { isWorkspaceChatAgent } from "../lib/mastra.js";
import { chatVoiceRoutes } from "./chat-voice.js";
import { validationHook } from "../lib/validation.js";
import { appendAuditLog } from "../services/audit-log.js";
import {
  archiveWorkspace,
  cloneWorkspace,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  ensurePersonalDefaultWorkspace,
  listWorkspaceBoardRecords,
  getWorkspaceCockpit,
  getWorkspaceTraceFeed,
  listWorkspaceVersions,
  restoreWorkspace,
  listWorkspaces,
  rollbackWorkspaceVersion,
  updateWorkspace,
  WorkspaceSlugError,
} from "../services/workspaces.js";
import { listWorkspaceTags } from "../services/workspace-tags.js";
import { getWorkspaceState } from "../services/workspace-state.js";
import {
  applyIngestRecommendation,
  IngestReportActionError,
  loadIngestReport,
  reprocessIngestRecommendation,
} from "../services/ingest-report.js";
import { chatWorkspace, workspaceChatDisabledBody, type ChatSearchActivity } from "../services/workspace-chat.js";
import { InvalidRetrievalQueryError, parseRetrievalQueryFlags } from "../lib/retrieval-query-flags.js";
import { deleteChatFeedback, upsertChatFeedback } from "../services/chat-feedback.js";
import {
  acceptWorkspaceInvite,
  canEditWorkspace,
  getWorkspaceAccess,
  inviteWorkspaceMember,
  listWorkspaceInvites,
  listWorkspaceMembers,
  removeWorkspaceMember,
  revokeWorkspaceInvite,
  updateWorkspaceMemberRole,
} from "../services/organizations.js";
import {
  getWorkspaceSearchSettingsForUser,
  updateWorkspaceSearchSettingsForUser,
} from "../services/search-controls.js";
import { hybridSearch } from "../services/search.js";
import { parseFilters } from "../search/filters.js";
import {
  buildWorkspaceChatAuditMetadata,
  createWorkspaceVersionSnapshot,
} from "../services/workspace-utils.js";
import {
  getMessageText,
  type WorkspaceChatUIMessage,
} from "@docslurp/shared/workspace-chat-ui";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { indexingModeErrorResponse } from "../lib/indexing-mode-error.js";
import { getRun } from "../services/runs.js";
import { runLifecycle } from "../services/run-lifecycle.js";
import { resolveMaterializationPolicy } from "../services/materialization-policy.js";
import {
  commitIndexJobs,
  estimateModeSwitch,
  IndexingModeError,
  prepareModeSwitchJobs,
  requestFullIndex,
  restoreStoredIndexingMode,
} from "../services/workspace-indexing-mode.js";

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

const cloneWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

const rollbackWorkspaceVersionSchema = z.object({
  note: z.string().trim().min(1).max(240).optional(),
});

const workspaceConfirmationSchema = z.object({
  confirmationText: z.string().trim().min(1).max(240),
});

const WORKSPACE_SEARCH_STREAM_POLL_MS = 2000;
const WORKSPACE_SEARCH_STREAM_TIMEOUT_MS = 15000;
const WORKSPACE_CHAT_STREAM_KEEPALIVE_MS = 10000;

type WorkspaceChatResponseValue = Awaited<ReturnType<typeof chatWorkspace>>;

type WorkspaceChatPostBody = {
  messages?: WorkspaceChatUIMessage[];
  sessionId?: string;
  model?: string;
  /** Thread retrieval overrides from the composer. */
  retrieval?: unknown;
  /** Composer filters (documents, types, tags, dates). */
  filters?: unknown;
};

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

function buildChatRetrievalStatus(response: WorkspaceChatResponseValue) {
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
        "Answer uses the currently indexed portion of the workspace.",
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
        "No searchable documents are available for this workspace yet.",
      detail: "Upload PDFs or wait for processing to create searchable content.",
      resultCount: response.citations.length,
    };
  }

  return {
    stage: "retrieval" as const,
    status: "success" as const,
    message: "Workspace context retrieved",
    detail: response.searchSessionId
      ? `Search session: ${response.searchSessionId}`
      : "Whole workspace corpus path",
    resultCount: response.citations.length,
  };
}

async function createWorkspaceAgentChatResponse(c: Context) {
  const userId = c.get("sessionUser").id;
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    return apiStatusError(c, 400, "Missing workspaceId");
  }

  const body = await c.req.json<WorkspaceChatPostBody>();
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

  const workspace = await getWorkspace(workspaceId, userId);
  if (!workspace) {
    return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
  }
  const chatDisabled = await workspaceChatDisabledBody(workspace.id, userId);
  if (chatDisabled) return apiErrorResponse(c, 403, "chat_disabled", chatDisabled.error);
  if (await chatModelRefused(getRequestActor(c), body.model, workspace.id)) {
    return apiErrorResponse(c, 400, "model_not_allowed", new ChatModelNotAllowedError().message);
  }

  return createUIMessageStreamResponse({
    headers: {
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
    stream: createUIMessageStream<WorkspaceChatUIMessage>({
      originalMessages: messages,
      async execute({ writer }) {
        const textPartId = `workspace-chat-${randomUUID()}`;
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
            type: "data-workspaceStatus",
            id: "workspace-status",
            data: {
              stage: "generation", subject: query.slice(0, 100), searches: [...searches.values()], tools: [...tools.values()],
              status: "loading",
              message: args.message,
              detail: args.detail,
            },
          });
        };

        const writeCitations = (citations: WorkspaceChatResponseValue["citations"]) => {
          writer.write({
            type: "data-workspaceCitations",
            id: "workspace-citations",
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
          type: "data-workspaceStatus",
          id: "workspace-status",
          data: {
            stage: "retrieval",
            status: "loading",
            message: "Retrieving workspace context",
          },
        });

        let keepaliveCount = 0;
        const keepaliveTimer = setInterval(() => {
          keepaliveCount += 1;
          const elapsedSeconds =
            (keepaliveCount * WORKSPACE_CHAT_STREAM_KEEPALIVE_MS) / 1000;
          writer.write({
            type: "data-workspaceStatus",
            id: "workspace-status",
            data: {
              subject: query.slice(0, 100), searches: [...searches.values()], tools: [...tools.values()],
              stage: generationStatusWritten ? "generation" : "retrieval",
              status: "loading",
              message: generationStatusWritten ? "Writing grounded answer" : "Searching workspace",
              detail: `Workspace answer is still running (${elapsedSeconds}s)`,
            },
          });
        }, WORKSPACE_CHAT_STREAM_KEEPALIVE_MS);

        let response: WorkspaceChatResponseValue;
        try {
          response = await chatWorkspace({
            workspaceId,
            userId,
            query,
            actor: getRequestActor(c), signal: c.req.raw.signal,
            answerIngestReport: getRequestActor(c).type === "session",
            onToolActivity: (activity) => {
              tools.set(activity.id, activity);
              writer.write({ type: "data-workspaceStatus", id: "workspace-status", data: {
                stage: "generation", status: "loading", message: `Using ${activity.name}`,
                subject: query.slice(0, 100), tools: [...tools.values()], searches: [...searches.values()],
              } });
            },
            sessionId: body.sessionId,
            model: body.model,
            ...(scope.retrieval ? { retrieval: scope.retrieval } : {}),
            ...(scope.filters ? { filters: scope.filters } : {}),
            onSearchActivity: (activity) => {
              searches.set(activity.id, activity);
              writer.write({ type: "data-workspaceStatus", id: "workspace-status", data: {
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
          orgId: workspace.orgId,
          userId,
          workspaceId: workspace.id,
          action: "workspace.chat.requested",
          resourceType: "workspace-chat",
          resourceId: response.id,
          ipAddress: requestIp(c),
          metadata: {
            ...buildWorkspaceChatAuditMetadata({
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
          type: "data-workspaceStatus",
          id: "workspace-status",
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
          type: "data-workspaceMeta",
          id: "workspace-meta",
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
          },
        });
        writer.write({
          type: "data-workspaceStatus",
          id: "workspace-status",
          data: {
            stage: "complete",
            tools: [...tools.values()],
            status:
              response.availability?.status === "empty" ? "error" : "success",
            message:
              response.availability?.status === "pending" ||
              response.availability?.status === "partial"
                ? (response.availability.message ??
                  "Workspace answer uses the currently indexed content.")
                : response.ingestReport
                  ? "Ingest report ready"
                  : response.debug.fallback
                    ? "Retrieved fallback answer ready"
                    : "Workspace answer ready",
            detail: retrievalStatus.detail,
            resultCount: response.citations.length,
          },
        });
      },
      onError: (error) => {
        console.error("Chat stream error:", error);
        return reportPublicError(error);
      },
    }),
  });
}

/** Failed workspace mutations: expected access errors keep their status, anything else is a 400. */
function workspaceMutationError(c: Context, error: unknown): Response {
  const message = reportPublicError(error);
  const originalMessage = error instanceof Error ? error.message : "";
  if (originalMessage === "Workspace not found") return apiErrorResponse(c, 404, "workspace_not_found", message);
  return apiStatusError(c, originalMessage === "Forbidden" ? 403 : 400, message);
}

export const workspacesRoutes = new Hono()
  .route("/", chatVoiceRoutes)
  .post(
    "/invites/:token/accept",
    zValidator("json", acceptWorkspaceInviteSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const member = await acceptWorkspaceInvite(
          c.req.param("token"),
          userId,
        );
        await appendAuditLog({
          userId,
          workspaceId: member.workspaceId,
          action: "workspace.invite.accepted",
          resourceType: "workspace-member",
          resourceId: `${member.workspaceId}:${member.userId}`,
          ipAddress: requestIp(c),
          metadata: {
            role: member.role,
            userAgent: requestUserAgent(c),
          },
        });
        return c.json(member);
      } catch (error) {
        return apiStatusError(c, 400, reportPublicError(error));
      }
    },
  )
  .get("/templates", async (c) => {
    return c.json({ templates: workspaceTemplates });
  })
  .get("/", async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts", "workspaces:manage"])) {
      return apiStatusError(c, 403, "Forbidden");
    }
    if (actor.type === "session") await ensurePersonalDefaultWorkspace(userId);
    const workspaces = await listWorkspaces(userId);
    return c.json({ workspaces: actor.type === "apiKey"
      ? workspaces.filter((workspace) => apiKeyCanUseWorkspace(actor.apiKey, workspace))
      : workspaces });
  })
  .get("/board", async (c) => {
    const userId = c.get("sessionUser").id;
    // A dashboard-only user always sees a default workspace to drop files on.
    if (getRequestActor(c).type === "session") await ensurePersonalDefaultWorkspace(userId);
    const records = await listWorkspaceBoardRecords(userId);
    return c.json({ records });
  })
  .get("/:workspaceId/cockpit", async (c) => {
    const userId = c.get("sessionUser").id;
    try {
      const cockpit = await getWorkspaceCockpit(
        c.req.param("workspaceId"),
        userId,
      );
      return c.json(cockpit);
    } catch (error) {
      return apiStatusError(c, 404, reportPublicError(error));
    }
  })
  .get("/:workspaceId/traces", async (c) => {
    const userId = c.get("sessionUser").id;
    const limit = Number(c.req.query("limit") ?? "12");
    try {
      const traces = await getWorkspaceTraceFeed(
        c.req.param("workspaceId"),
        userId,
        Number.isFinite(limit) ? limit : 12,
      );
      return c.json(traces);
    } catch (error) {
      return apiStatusError(c, 404, reportPublicError(error));
    }
  })
  .get("/:workspaceId/versions", async (c) => {
    const userId = c.get("sessionUser").id;
    try {
      const versions = await listWorkspaceVersions(
        c.req.param("workspaceId"),
        userId,
      );
      return c.json({ versions });
    } catch (error) {
      return apiStatusError(c, 404, reportPublicError(error));
    }
  })
  .get("/:workspaceId/tags", async (c) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts", "workspaces:manage"])) {
      return apiStatusError(c, 403, "Forbidden");
    }
    const workspace = await getWorkspace(c.req.param("workspaceId"), actor.userId);
    if (!workspace || (actor.type === "apiKey" && !apiKeyCanUseWorkspace(actor.apiKey, workspace))) {
      return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    }
    return c.json({ tags: await listWorkspaceTags(workspace.id) });
  })
  .get("/:workspaceId/state", zValidator("query", workspaceStateQuerySchema, validationHook), async (c) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts", "workspaces:manage"]))) {
      return apiStatusError(c, 403, "Forbidden");
    }
    const workspace = await getWorkspace(c.req.param("workspaceId"), actor.userId);
    if (!workspace || (actor.type === "apiKey" && !apiKeyCanUseWorkspace(actor.apiKey, workspace))) {
      return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    }
    return c.json(await getWorkspaceState({
      workspaceId: workspace.id,
      orgId: workspace.orgId,
      recentWindowHours: c.req.valid("query").recentWindowHours,
    }));
  })
  .get("/:workspaceId/ingest-report", zValidator("query", ingestReportQuerySchema, validationHook), async (c) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts", "workspaces:manage"]))) {
      return apiStatusError(c, 403, "Forbidden");
    }
    const workspace = await getWorkspace(c.req.param("workspaceId"), actor.userId);
    if (!workspace || (actor.type === "apiKey" && !apiKeyCanUseWorkspace(actor.apiKey, workspace))) {
      return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    }
    const query = c.req.valid("query");
    const access = actor.type === "apiKey" ? null : await getWorkspaceAccess(workspace.id, actor.userId);
    return c.json(await loadIngestReport({
      workspace,
      canEdit: Boolean(access && canEditWorkspace(access, actor.userId)),
      runId: query.runId ?? null,
      documentIds: query.documentIds ?? null,
    }));
  })
  .post("/:workspaceId/ingest-report/apply", zValidator("json", applyIngestRecommendationSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const workspace = await getWorkspace(c.req.param("workspaceId"), userId);
    if (!workspace) return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    const body = c.req.valid("json");
    try {
      const result = await applyIngestRecommendation({ workspace, userId, recommendationId: body.recommendationId, runId: body.runId ?? null, documentIds: body.documentIds ?? null });
      await appendAuditLog({
        orgId: workspace.orgId,
        userId,
        workspaceId: workspace.id,
        action: "workspace.updated",
        resourceType: "workspace",
        resourceId: workspace.id,
        ipAddress: requestIp(c),
        metadata: {
          source: "ingest-report",
          recommendationId: body.recommendationId,
          patch: result.recommendation.patch,
          snapshot: createWorkspaceVersionSnapshot(result.workspace),
          userAgent: requestUserAgent(c),
        },
      });
      return c.json({ recommendationId: body.recommendationId, patch: result.recommendation.patch, pipeline: result.pipeline });
    } catch (error) {
      if (error instanceof IngestReportActionError) return apiStatusError(c, error.status, error.message);
      throw error;
    }
  })
  .post("/:workspaceId/ingest-report/reprocess", zValidator("json", reprocessIngestRecommendationSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const workspace = await getWorkspace(c.req.param("workspaceId"), userId);
    if (!workspace) return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    const body = c.req.valid("json");
    try {
      const result = await reprocessIngestRecommendation({ workspace, userId, recommendationId: body.recommendationId, runId: body.runId ?? null, documentIds: body.documentIds ?? null });
      await appendAuditLog({
        orgId: workspace.orgId,
        userId,
        workspaceId: workspace.id,
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
  .get("/:workspaceId", async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts", "workspaces:manage"])) {
      return apiStatusError(c, 403, "Forbidden");
    }
    const workspace = await getWorkspace(c.req.param("workspaceId"), userId);

    if (!workspace || (actor.type === "apiKey" && !apiKeyCanUseWorkspace(actor.apiKey, workspace))) {
      return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    }

    return c.json(workspace);
  })
  .get("/:workspaceId/search-settings", async (c) => {
    const userId = c.get("sessionUser").id;
    const settings = await getWorkspaceSearchSettingsForUser(
      c.req.param("workspaceId"),
      userId,
    );

    if (!settings) {
      return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    }

    return c.json(settings);
  })
  .get("/:workspaceId/search/stream", async (c) => {
    const query = c.req.query("q");
    const userId = c.get("sessionUser").id;
    if (!query) {
      return apiStatusError(c, 400, "Missing q");
    }

    const workspace = await getWorkspace(c.req.param("workspaceId"), userId);
    if (!workspace) {
      return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    }

    const runId = c.req.query("runId");
    const limit = c.req.query("limit");
    const variant = c.req.query("variant");
    // Omitted flags stay undefined so the workspace's retrieval defaults apply
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
      workspaceId: c.req.param("workspaceId"),
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
          message: "Running workspace search",
        }),
      });

      const deadline = Date.now() + WORKSPACE_SEARCH_STREAM_TIMEOUT_MS;
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
        });

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
          activeRunCount === 0
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
            pollMs: WORKSPACE_SEARCH_STREAM_POLL_MS,
          }),
        });

        await stream.sleep(WORKSPACE_SEARCH_STREAM_POLL_MS);
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
  .post("/:workspaceId/chat/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    if (!agentId || !isWorkspaceChatAgent(agentId)) {
      return apiStatusError(c, 404, "Agent not found");
    }

    return createWorkspaceAgentChatResponse(c);
  })
  .put(
    "/:workspaceId/chat/feedback",
    zValidator("json", chatFeedbackSchema, validationHook),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const workspaceId = c.req.param("workspaceId");
      const workspace = await getWorkspace(workspaceId, userId);
      if (!workspace) {
        return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
      }

      const feedback = await upsertChatFeedback({ ...c.req.valid("json"), workspaceId, userId });
      return c.json({ feedback });
    },
  )
  .delete("/:workspaceId/chat/feedback/:messageId", async (c) => {
    const userId = c.get("sessionUser").id;
    const workspaceId = c.req.param("workspaceId");
    const workspace = await getWorkspace(workspaceId, userId);
    if (!workspace) {
      return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    }

    await deleteChatFeedback({ workspaceId, userId, messageId: c.req.param("messageId") });
    return c.json({ ok: true });
  })
  .get("/:workspaceId/members", async (c) => {
    const userId = c.get("sessionUser").id;
    try {
      const members = await listWorkspaceMembers(
        c.req.param("workspaceId"),
        userId,
      );
      return c.json({ members });
    } catch (error) {
      return apiStatusError(c, 404, reportPublicError(error));
    }
  })
  .get("/:workspaceId/invites", async (c) => {
    const userId = c.get("sessionUser").id;
    try {
      const invites = await listWorkspaceInvites(
        c.req.param("workspaceId"),
        userId,
      );
      return c.json({ invites });
    } catch (error) {
      return apiStatusError(c, 404, reportPublicError(error));
    }
  })
  .post("/", zValidator("json", createWorkspaceSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const valid = c.req.valid("json");
    // The schema defaults a missing pipeline.indexingMode to "full"; only an explicit
    // mode in the raw body may override the plan default.
    const raw = await c.req.json().catch(() => null) as { pipeline?: { indexingMode?: unknown } } | null;
    const explicit = indexingModeSchema.safeParse(raw?.pipeline?.indexingMode).success;
    const { indexingMode: _defaulted, ...pipelineWithoutMode } = valid.pipeline ?? ({} as NonNullable<typeof valid.pipeline>);
    const input = {
      ...valid,
      userId,
      ...(valid.pipeline && !explicit ? { pipeline: pipelineWithoutMode as NonNullable<typeof valid.pipeline> } : {}),
    };
    let workspace;
    try {
      workspace = await createWorkspace(input);
    } catch (error) {
      if (error instanceof IndexingModeError) return indexingModeErrorResponse(c, error);
      throw error;
    }
    await appendAuditLog({
      orgId: workspace.orgId,
      userId,
      workspaceId: workspace.id,
      action: "workspace.created",
      resourceType: "workspace",
      resourceId: workspace.id,
      ipAddress: requestIp(c),
      metadata: {
        templateKey: workspace.templateKey,
        snapshot: createWorkspaceVersionSnapshot(workspace),
        userAgent: requestUserAgent(c),
      },
    });
    return c.json(workspace, 201);
  })
  .post(
    "/:workspaceId/clone",
    zValidator("json", cloneWorkspaceSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const input = c.req.valid("json");
        const source = await getWorkspace(c.req.param("workspaceId"), userId);
        if (!source) {
          return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
        }

        const workspace = await cloneWorkspace(
          c.req.param("workspaceId"),
          userId,
          input.name,
        );
        await appendAuditLog({
          orgId: workspace.orgId,
          userId,
          workspaceId: workspace.id,
          action: "workspace.cloned",
          resourceType: "workspace",
          resourceId: workspace.id,
          ipAddress: requestIp(c),
          metadata: {
            note: `Cloned from ${source.name}`,
            sourceWorkspaceId: source.id,
            snapshot: createWorkspaceVersionSnapshot(workspace),
            userAgent: requestUserAgent(c),
          },
        });
        return c.json(workspace, 201);
      } catch (error) {
        return apiStatusError(c, 400, reportPublicError(error));
      }
    },
  )
  .post(
    "/:workspaceId/archive",
    zValidator("json", workspaceConfirmationSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const workspace = await archiveWorkspace(
          c.req.param("workspaceId"),
          userId,
          c.req.valid("json").confirmationText,
        );

        await appendAuditLog({
          orgId: workspace.orgId,
          userId,
          workspaceId: workspace.id,
          action: "workspace.archived",
          resourceType: "workspace",
          resourceId: workspace.id,
          ipAddress: requestIp(c),
          metadata: {
            snapshot: createWorkspaceVersionSnapshot(workspace),
            archivedAt: workspace.archivedAt,
            userAgent: requestUserAgent(c),
          },
        });

        return c.json(workspace);
      } catch (error) {
        return workspaceMutationError(c, error);
      }
    },
  )
  .post(
    "/:workspaceId/restore",
    zValidator("json", workspaceConfirmationSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const workspace = await restoreWorkspace(
          c.req.param("workspaceId"),
          userId,
          c.req.valid("json").confirmationText,
        );

        await appendAuditLog({
          orgId: workspace.orgId,
          userId,
          workspaceId: workspace.id,
          action: "workspace.restored",
          resourceType: "workspace",
          resourceId: workspace.id,
          ipAddress: requestIp(c),
          metadata: {
            snapshot: createWorkspaceVersionSnapshot(workspace),
            userAgent: requestUserAgent(c),
          },
        });

        return c.json(workspace);
      } catch (error) {
        return workspaceMutationError(c, error);
      }
    },
  )
  .post(
    "/:workspaceId/invites",
    zValidator("json", createWorkspaceInviteSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const inviteInput = { ...c.req.valid("json"), userId };
        const invite = await inviteWorkspaceMember(
          c.req.param("workspaceId"),
          inviteInput,
        );
        await appendAuditLog({
          orgId: invite.orgId,
          userId,
          workspaceId: invite.workspaceId,
          action: "workspace.invite.sent",
          resourceType: "workspace-invite",
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
  .delete("/:workspaceId/invites/:inviteId", async (c) => {
    try {
      const userId = c.get("sessionUser").id;
      const invite = await revokeWorkspaceInvite({
        workspaceId: c.req.param("workspaceId"),
        userId,
        inviteId: c.req.param("inviteId"),
      });

      await appendAuditLog({
        orgId: invite.orgId,
        userId,
        workspaceId: invite.workspaceId,
        action: "workspace.invite.revoked",
        resourceType: "workspace-invite",
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
    "/:workspaceId/members/:memberUserId",
    zValidator("json", updateWorkspaceMemberSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const member = await updateWorkspaceMemberRole({
          workspaceId: c.req.param("workspaceId"),
          userId,
          memberUserId: c.req.param("memberUserId"),
          role: c.req.valid("json").role,
        });
        await appendAuditLog({
          userId,
          workspaceId: member.workspaceId,
          action: "workspace.member.updated",
          resourceType: "workspace-member",
          resourceId: `${member.workspaceId}:${member.userId}`,
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
  .delete("/:workspaceId/members/:memberUserId", async (c) => {
    try {
      const userId = c.get("sessionUser").id;
      const removed = await removeWorkspaceMember({
        workspaceId: c.req.param("workspaceId"),
        userId,
        memberUserId: c.req.param("memberUserId"),
      });

      if (!removed) {
        return apiStatusError(c, 404, "Workspace membership not found");
      }

      await appendAuditLog({
        userId,
        workspaceId: c.req.param("workspaceId"),
        action: "workspace.member.removed",
        resourceType: "workspace-member",
        resourceId: `${c.req.param("workspaceId")}:${c.req.param("memberUserId")}`,
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
  .post("/:workspaceId/chat", async (c) => {
    const body = await c.req.json<{
      q?: string;
      sessionId?: string;
      model?: string;
      retrievalOnly?: boolean;
      retrieval?: unknown;
      filters?: unknown;
    }>();
    if (!body.q) {
      return apiStatusError(c, 400, "Missing q");
    }
    const scope = parseChatScope(body);
    if (!scope) return apiStatusError(c, 400, "Invalid retrieval or filters");

    const userId = c.get("sessionUser").id;
    const workspace = await getWorkspace(c.req.param("workspaceId"), userId);
    if (!workspace) {
      return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    }
    const chatDisabled = await workspaceChatDisabledBody(workspace.id, userId);
    if (chatDisabled) return apiErrorResponse(c, 403, "chat_disabled", chatDisabled.error);

    let response: Awaited<ReturnType<typeof chatWorkspace>>;
    try {
      response = await chatWorkspace({
        workspaceId: c.req.param("workspaceId"),
        userId,
        query: body.q,
        actor: body.retrievalOnly === true ? undefined : getRequestActor(c), signal: c.req.raw.signal,
        allowConfiguration: body.retrievalOnly === true ? false : undefined,
        answerIngestReport: getRequestActor(c).type === "session",
        sessionId: body.sessionId,
        model: body.model,
        ...(scope.retrieval ? { retrieval: scope.retrieval } : {}),
        ...(scope.filters ? { filters: scope.filters } : {}),
      });
    } catch (error) {
      if (error instanceof ChatModelNotAllowedError) return apiErrorResponse(c, 400, "model_not_allowed", error.message);
      throw error;
    }

    await appendAuditLog({
      orgId: workspace.orgId,
      userId,
      workspaceId: workspace.id,
      action: "workspace.chat.requested",
      resourceType: "workspace-chat",
      resourceId: response.id,
      ipAddress: requestIp(c),
      metadata: {
        ...buildWorkspaceChatAuditMetadata({
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
    "/:workspaceId/versions/:versionId/rollback",
    zValidator("json", rollbackWorkspaceVersionSchema, validationHook),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const input = c.req.valid("json");
      try {
        const workspace = await rollbackWorkspaceVersion(
          c.req.param("workspaceId"),
          userId,
          c.req.param("versionId"),
        );

        await appendAuditLog({
          orgId: workspace.orgId,
          userId,
          workspaceId: workspace.id,
          action: "workspace.rollback",
          resourceType: "workspace",
          resourceId: workspace.id,
          ipAddress: requestIp(c),
          metadata: {
            note:
              input.note ??
              `Rolled back to version ${c.req.param("versionId").slice(0, 8)}`,
            sourceVersionId: c.req.param("versionId"),
            snapshot: createWorkspaceVersionSnapshot(workspace),
            userAgent: requestUserAgent(c),
          },
        });

        return c.json(workspace);
      } catch (error) {
        return apiStatusError(c, 400, reportPublicError(error));
      }
    },
  )
  .patch(
    "/:workspaceId/search-settings",
    zValidator("json", updateWorkspaceSearchSettingsSchema, validationHook),
    async (c) => {
      const workspaceId = String(c.req.param("workspaceId"));
      const userId = c.get("sessionUser").id;
      const settings = await updateWorkspaceSearchSettingsForUser({
        workspaceId,
        userId,
        input: c.req.valid("json"),
      });

      if (!settings) {
        return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
      }

      await appendAuditLog({
        userId,
        workspaceId,
        action: "workspace.search-settings.updated",
        resourceType: "workspace-search-settings",
        resourceId: workspaceId,
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
    "/:workspaceId",
    zValidator("json", updateWorkspaceSchema, validationHook),
    async (c) => {
      const workspaceId = String(c.req.param("workspaceId"));
      const userId = c.get("sessionUser").id;
      const actor = getRequestActor(c);
      if (actor.type === "apiKey") {
        // Opt-in server-key scope, bound to the key's organization; the key
        // owner's workspace role still decides what may change.
        if (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["workspaces:manage"])) {
          return apiStatusError(c, 403, "This endpoint requires a server API key with the workspaces:manage scope");
        }
        const current = await getWorkspace(workspaceId, userId);
        if (!current || !apiKeyCanUseWorkspace(actor.apiKey, current)) {
          return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
        }
      }
      // The schema defaults a missing pipeline.indexingMode to "full", so read the raw body
      // to tell an explicit mode change (and `indexAll`) from an unrelated pipeline edit.
      const raw = deferredProfilesEnabled() ? await c.req.json().catch(() => null) as Record<string, unknown> | null : null;
      const rawPipeline = raw?.pipeline as { indexingMode?: unknown } | undefined;
      const requestedMode = indexingModeSchema.safeParse(rawPipeline?.indexingMode);
      const before = requestedMode.success ? await getWorkspace(workspaceId, userId) : null;
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
            workspacePipeline: modeChange.pipeline,
            apiKey: actor.type === "apiKey" ? actor.apiKey : null,
            workspaceId: modeChange.id,
          });
          if ("policy" in resolved) {
            prepared = await prepareModeSwitchJobs({
              workspace: modeChange, to: requestedMode.data, indexAll: raw?.indexAll === true, actor, policy: resolved.policy,
            });
          }
        } catch (error) {
          return fail(error);
        }
      }

      let workspace;
      try {
        workspace = requestedMode.success
          ? await updateWorkspace(workspaceId, userId, c.req.valid("json"), { indexingMode: requestedMode.data })
          : await updateWorkspace(workspaceId, userId, c.req.valid("json"));
      } catch (error) {
        if (error instanceof WorkspaceSlugError) return apiStatusError(c, error.status, error.message);
        return fail(error);
      }

      if (!workspace) {
        return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
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
          await restoreStoredIndexingMode(workspace.id, modeChange.pipeline.indexingMode);
          return fail(error);
        }
      }

      await appendAuditLog({
        orgId: workspace.orgId,
        userId,
        workspaceId: workspace.id,
        action: "workspace.updated",
        resourceType: "workspace",
        resourceId: workspace.id,
        apiKeyId: actor.type === "apiKey" ? actor.apiKey.keyId : null,
        ipAddress: requestIp(c),
        metadata: {
          snapshot: createWorkspaceVersionSnapshot(workspace),
          userAgent: requestUserAgent(c),
        },
      });

      return c.json(indexingJob ? { ...workspace, indexingJob } : workspace);
    },
  )
  .post(
    "/:workspaceId/indexing-mode/estimate",
    zValidator("json", z.object({ mode: indexingModeSchema })),
    async (c) => {
      if (!deferredProfilesEnabled()) return apiErrorResponse(c, 404, "not_found", "Not found");
      const userId = c.get("sessionUser").id;
      const workspace = await getWorkspace(c.req.param("workspaceId"), userId);
      if (!workspace) return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
      const actor = getRequestActor(c);
      if (actor.type === "apiKey" && !apiKeyCanUseWorkspace(actor.apiKey, workspace)) {
        return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
      }
      return c.json(await estimateModeSwitch(workspace.id, c.req.valid("json").mode));
    },
  )
  .post(
    "/:workspaceId/full-index",
    zValidator("json", z.object({ documentIds: z.array(z.string().min(1)).max(500).optional() }).default({})),
    async (c) => {
      if (!deferredProfilesEnabled()) return apiErrorResponse(c, 404, "not_found", "Not found");
      const userId = c.get("sessionUser").id;
      const actor = getRequestActor(c);
      const workspace = await getWorkspace(c.req.param("workspaceId"), userId);
      if (!workspace || (actor.type === "apiKey" && !apiKeyCanUseWorkspace(actor.apiKey, workspace))) {
        return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
      }
      if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest"])) {
        return apiErrorResponse(c, 403, "forbidden", "Forbidden");
      }
      const access = await getWorkspaceAccess(workspace.id, userId);
      if (!access || !canEditWorkspace(access, userId)) return apiErrorResponse(c, 403, "forbidden", "Forbidden");
      const resolved = await resolveMaterializationPolicy({
        workspacePipeline: workspace.pipeline,
        apiKey: actor.type === "apiKey" ? actor.apiKey : null,
        capabilityHeader: c.req.header("X-DocSlurp-Capability"),
        origin: c.req.header("Origin"),
        workspaceId: workspace.id,
      });
      if ("error" in resolved) return apiErrorResponse(c, 403, "forbidden", "Invalid capability", { category: resolved.error });
      try {
        const result = await requestFullIndex({
          orgId: workspace.orgId,
          workspaceId: workspace.id,
          documentIds: c.req.valid("json").documentIds,
          actor,
          policy: resolved.policy,
        });
        const run = await getRun(result.runId, userId);
        if (run) await runLifecycle.start(run);
        return c.json({ runId: result.runId, pages: result.pages, estimatedCredits: result.estimatedCredits, billing: result.billing }, 202);
      } catch (error) {
        if (error instanceof IndexingModeError) return indexingModeErrorResponse(c, error);
        throw error;
      }
    },
  )
  .delete(
    "/:workspaceId",
    zValidator("json", workspaceConfirmationSchema, validationHook),
    async (c) => {
      try {
        const userId = c.get("sessionUser").id;
        const deleted = await deleteWorkspace(
          c.req.param("workspaceId"),
          userId,
          c.req.valid("json").confirmationText,
        );

        await appendAuditLog({
          orgId: deleted.orgId,
          userId,
          workspaceId: null,
          action: "workspace.deleted",
          resourceType: "workspace",
          resourceId: deleted.id,
          ipAddress: requestIp(c),
          metadata: {
            workspaceName: deleted.name,
            archivedAt: deleted.archivedAt,
            userAgent: requestUserAgent(c),
          },
        });

        return c.json({
          ok: true,
          workspaceId: deleted.id,
          workspaceName: deleted.name,
        });
      } catch (error) {
        return workspaceMutationError(c, error);
      }
    },
  );

// Workspace reads and rename/settings updates (the PATCH requires workspaces:manage).
acceptApiKeys(workspacesRoutes, ["GET /", "GET /:workspaceId", "GET /:workspaceId/tags", "GET /:workspaceId/state", "GET /:workspaceId/ingest-report", "PATCH /:workspaceId", "POST /:workspaceId/full-index", "POST /:workspaceId/indexing-mode/estimate"]);
