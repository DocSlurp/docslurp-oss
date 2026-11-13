import { emitTelemetryLog } from "@docslurp/shared/observability";
import { reportPublicError } from "../lib/public-errors.js";
import { randomUUID } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import {
  actorHasAnyApiKeyScope,
  apiKeyAllowsProject,
  getRequestActor,
  resolveActorProjectId,
} from "../lib/request-actor.js";
import { authorizeActorProjectSearch } from "../lib/search-access.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { CHAT_CAPACITY_UNAVAILABLE_MESSAGE, createChatConcurrencyLimit } from "../middleware/chat-concurrency.js";
import { assertCanSpend, isSpendBlockedError, type SpendBlockedError } from "../services/billing/spend-guard.js";
import { upgradeLinkHeader, upgradeLinksFor } from "../lib/upgrade-links.js";
import { chatProject, projectChatDisabledBody } from "../services/project-chat.js";
import { listProjects } from "../services/projects.js";
import { ProjectAccessError } from "../services/default-project.js";
import { chatRetrievalOverridesSchema, normalizeExtractedText, type ProjectChatResponse, type ProjectChatTurn } from "@docslurp/shared";
import { authenticatedByRoute } from "../lib/route-auth.js";
import { env } from "../config.js";
import { ChatToolBlockedError } from "../services/chat-tool-error.js";
import { isChatTurnDeadlineError } from "../services/chat-turn-deadline.js";
import { chatModelRefused, ChatModelNotAllowedError } from "../lib/chat-model-policy.js";

const textContent = z.union([
  z.string().max(64_000),
  z.array(z.object({ type: z.literal("text"), text: z.string().max(64_000) }).strict()).min(1).max(16),
]);
const requestSchema = z.object({
  // project:<uuid>, project:<slug> (current or former) or project:default.
  // The inference model is docslurp.model (an llm:// URI), never this field.
  model: z.string().regex(/^project:(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]+(?:-[a-z0-9]+)*)$/i, {
    error: (issue) => typeof issue.input === "string" && /^llm:\/\//i.test(issue.input.trim())
      ? "model selects a project (project:default, project:<slug> or an id from GET /v1/models). Send the llm:// inference model as docslurp.model instead."
      : "model must be project:default, project:<slug> or a project model id from GET /v1/models",
  }),
  messages: z.array(z.object({
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: textContent,
  }).strict()).min(1).max(64),
  stream: z.boolean().default(false),
  stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
  max_completion_tokens: z.number().int().min(1).max(16_384).optional(),
  max_tokens: z.number().int().min(1).max(16_384).optional(),
  n: z.literal(1).optional(),
  user: z.string().max(256).optional(),
  /**
   * "auto" (default): the project agent may call its own tools (search, web)
   * before answering; project settings tools are DocSlurp-app only. "none": answer directly from one retrieval and
   * one model call. Client-defined tools are not supported.
   */
  tool_choice: z.enum(["auto", "none"], { error: 'tool_choice must be "auto" or "none"; DocSlurp runs its own project tools and does not accept client-defined tools' }).optional(),
  /** DocSlurp extension (send it with extra_body in OpenAI SDKs), mirroring the response's `docslurp` field. */
  docslurp: z.object({
    speedBoost: z.boolean().default(false),
    /** Inference model for this request, as `model` on POST /v1/chat: `llm://openrouter/<vendor>/<model>` or the bare id, with an optional `?reasoning=` level. */
    model: z.string().trim().min(1).max(256).optional(),
    /** Per-request retrieval overrides, as `retrieval` on POST /v1/chat. */
    retrieval: chatRetrievalOverridesSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.max_tokens !== undefined && value.max_completion_tokens !== undefined) {
    context.addIssue({ code: "custom", message: "Use either max_tokens or max_completion_tokens", path: ["max_tokens"] });
  }
  if (value.messages.at(-1)?.role !== "user") {
    context.addIssue({ code: "custom", message: "The final message must be from the user", path: ["messages"] });
  }
  const size = value.messages.reduce((total, message) => total + contentText(message.content).length, 0);
  if (size > 128_000) {
    context.addIssue({ code: "custom", message: "Conversation exceeds 128,000 characters", path: ["messages"] });
  }
  if (!contentText(value.messages.at(-1)?.content ?? "").trim()) {
    context.addIssue({ code: "custom", message: "The final user message cannot be empty", path: ["messages"] });
  }
});

function contentText(content: z.infer<typeof textContent>): string {
  return typeof content === "string" ? content : content.map((part) => part.text).join("\n");
}

function errorBody(message: string, type = "invalid_request_error", code: string | null = null, param: string | null = null) {
  return { error: { message, type, param, code } };
}

/** OpenAI-shaped 402 for a blocked spend; `error.links` says where to buy credits or turn on auto top-up. */
function spendBlockedBody(c: Context, error: SpendBlockedError) {
  const links = upgradeLinksFor(error.code, { autoTopUpOn: error.autoTopUpOn });
  const header = upgradeLinkHeader(links);
  if (header) c.header("Link", header);
  const body = errorBody(reportPublicError(error), "service_unavailable", error.code);
  return links ? { error: { ...body.error, links } } : body;
}

function completionFinishReason(response: ProjectChatResponse): "stop" | "length" | "content_filter" {
  return response.finishReason === "length" ? "length" : response.finishReason === "content-filter" ? "content_filter" : "stop";
}

function completionUsage(response: ProjectChatResponse) {
  return {
    prompt_tokens: response.usage.inputTokens,
    completion_tokens: response.usage.outputTokens,
    total_tokens: response.usage.totalTokens,
  };
}

/** Plain clients retain clickable source provenance; richer clients can read the extension. */
function sourceList(response: ProjectChatResponse): string {
  if (!response.citations.length) return "";
  return "\n\nSources:\n" + response.citations.map((result, index) => {
    const citation = result.citation;
    const pages = citation.pageNumbers?.join(", ") || citation.pageNumber;
    const name = citation.filename.replace(/[\[\]\\\r\n]/g, " ");
    return `[${index + 1}] ${name}${pages ? `, page ${pages}` : ""}`;
  }).join("\n");
}

const compatibleChatAuth: MiddlewareHandler = async (c, next) => {
  const denied = await apiKeyAuth(c, async () => {});
  if (denied instanceof Response) {
    if (denied.status === 429) {
      const retryAfter = denied.headers.get("Retry-After");
      if (retryAfter) c.header("Retry-After", retryAfter);
      return c.json(errorBody("Request rate limit exceeded. Retry later.", "rate_limit_error", "rate_limit_exceeded"), 429);
    }
    // A browser key refused for a fixable reason (no project allowlist, a website it
    // doesn't allow) is a permission error with its own code, not an unknown key.
    const policy = c.get("apiKeyPolicyRefusal");
    if (policy) return c.json(errorBody(policy.message, "permission_error", policy.code), 403);
    // A missing or unknown key is a 401 here (OpenAI clients raise AuthenticationError),
    // even though the native API answers an unknown key with 403.
    c.header("WWW-Authenticate", 'Bearer realm="docslurp"');
    return c.json(errorBody("A valid DocSlurp API key is required", "authentication_error", "invalid_api_key"), 401);
  }
  // Project models generate answers: the key needs `chat`, not just `search`.
  if (!actorHasAnyApiKeyScope(getRequestActor(c), ["chat"])) {
    return c.json(errorBody("API key needs chat access", "permission_error", "insufficient_scope"), 403);
  }
  await next();
};

export const chatCompletionsRoutes = new Hono()
  .use("/models", compatibleChatAuth)
  .use("/chat/completions", compatibleChatAuth)
  .use("/chat/completions", createChatConcurrencyLimit((c, reason) => reason === "full"
    ? c.json(errorBody("Too many chat requests in progress for this key. Retry later.", "rate_limit_error", "rate_limit_exceeded"), 429)
    : c.json(errorBody(CHAT_CAPACITY_UNAVAILABLE_MESSAGE, "server_error", "chat_capacity_unavailable"), 503)))
  .get("/models", async (c) => {
    const actor = getRequestActor(c);
    const projects = await listProjects(actor.userId);
    const orgId = actor.type === "apiKey" ? actor.apiKey.orgId : null;
    return c.json({
      object: "list",
      data: projects.filter((project) => !project.archivedAt && (!orgId || project.orgId === orgId)
        && (actor.type !== "apiKey" || apiKeyAllowsProject(actor.apiKey, project.id))).map((project) => ({
        id: `project:${project.id}`,
        object: "model",
        created: Math.floor(new Date(project.createdAt).getTime() / 1000),
        owned_by: "docslurp",
        name: project.name,
      })),
    });
  })
  .post("/chat/completions", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("Request body must be valid JSON"), 400);
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      // Name the offending field, as OpenAI does, rather than the enclosing object.
      const key = issue.code === "unrecognized_keys" ? issue.keys[0] : undefined;
      const param = [...issue.path, ...(key ? [key] : [])].join(".");
      const message = issue.path.length === 0 && (key === "tools" || key === "functions")
        ? `Unsupported parameter: ${key}. DocSlurp runs its own project tools; use tool_choice "none" for a direct answer without them.`
        : issue.message;
      return c.json(errorBody(message, "invalid_request_error", key ? "unsupported_parameter" : null, param || null), 400);
    }
    const input = parsed.data;
    const actor = getRequestActor(c);
    // The same resolver as every `project` field: UUID, current or former slug, or "default".
    const projectId = await resolveActorProjectId(actor, input.model.slice("project:".length)).catch((error: unknown) => {
      if (error instanceof ProjectAccessError) return null;
      throw error;
    });
    // One access read, which also yields the explicit search access scope chatProject requires.
    const authorized = projectId ? await authorizeActorProjectSearch(actor, projectId, "chat") : null;
    if (!projectId || !authorized?.ok) {
      return c.json(errorBody("Project model not found", "invalid_request_error", "model_not_found", "model"), 404);
    }
    const chatDisabled = await projectChatDisabledBody(projectId, actor.userId);
    if (chatDisabled) {
      return c.json(errorBody(chatDisabled.error, "permission_error", chatDisabled.code, "model"), 403);
    }
    // Refused before any streaming starts, as on POST /v1/chat.
    if (input.docslurp?.model && await chatModelRefused(actor, input.docslurp.model, projectId)) {
      return c.json(errorBody(new ChatModelNotAllowedError().message, "invalid_request_error", "model_not_allowed", "docslurp.model"), 400);
    }
    // A browser (client) key is public: anyone who reads the page can send any
    // messages. Its callers' system/developer messages would sit beside the
    // project instructions with system authority, so they are dropped; only
    // server keys may set system instructions.
    const systemAllowed = actor.type !== "apiKey" || actor.apiKey.keyType === "server";
    if (!systemAllowed) {
      const systemCount = input.messages.filter(message => message.role === "system").length;
      const developerCount = input.messages.filter(message => message.role === "developer").length;
      if (systemCount + developerCount > 0) emitTelemetryLog({
        eventName: "docslurp.chat.denied_instructions",
        severityText: "warn",
        body: "Discarded browser-key privileged instructions",
        attributes: { "docslurp.projectId": projectId, "docslurp.denied.system_count": systemCount,
          "docslurp.denied.developer_count": developerCount },
      });
    }
    const history: Array<Pick<ProjectChatTurn, "role" | "content">> = input.messages.slice(0, -1)
      .filter((message) => systemAllowed || (message.role !== "system" && message.role !== "developer"))
      .map((message) => ({
        role: message.role === "developer" ? "system" : message.role,
        content: contentText(message.content),
      }));
    const args = {
      projectId,
      scope: authorized.scope,
      speedBoost: input.docslurp?.speedBoost === true,
      userId: actor.userId,
      actor, allowAgentTools: env.publicChatAgentEnabled && input.tool_choice !== "none", signal: c.req.raw.signal,
      ...(input.docslurp?.retrieval ? { retrieval: input.docslurp.retrieval } : {}),
      ...(input.docslurp?.model ? { model: input.docslurp.model } : {}),
      query: contentText(input.messages.at(-1)!.content),
      history,
      maxOutputTokens: input.max_completion_tokens ?? input.max_tokens,
      allowConfiguration: false,
    };
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const base = { id, created, model: input.model };
    if (!input.stream) {
      try {
        const response = await chatProject(args);
        return c.json({
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: response.answer + sourceList(response), refusal: null }, finish_reason: completionFinishReason(response), logprobs: null }],
          usage: completionUsage(response),
          docslurp: { citations: response.citations, availability: response.availability },
        });
      } catch (error) {
        if (isSpendBlockedError(error)) return c.json(spendBlockedBody(c, error), 402);
        if (error instanceof ChatModelNotAllowedError) return c.json(errorBody(error.message, "invalid_request_error", error.code, "docslurp.model"), 400);
        if (error instanceof ChatToolBlockedError) return c.json(errorBody(error.message, "server_error", error.code), error.statusCode);
        if (isChatTurnDeadlineError(error)) return c.json(errorBody(error.message, "timeout_error", error.code), error.statusCode);
        reportPublicError(error, { operation: "chat-completions" }, c.req.raw.signal);
        return c.json(errorBody("Project answer failed. Try again.", "server_error"), 500);
      }
    }
    // Refuse before the stream opens, so a blocked spend is a 402, not an SSE error.
    try {
      // Pre-check only: chatProject takes the interactive hold.
      await assertCanSpend(authorized.scope.orgId, projectId, { kind: "interactive", hold: false });
    } catch (error) {
      if (isSpendBlockedError(error)) return c.json(spendBlockedBody(c, error), 402);
      throw error;
    }
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const chunk = (delta: Record<string, string>, finishReason: "stop" | "length" | "content_filter" | null = null) => ({
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
        ...(input.stream_options?.include_usage ? { usage: null } : {}),
      });
      let emittedText = "";
      let disconnected = false;
      stream.onAbort(() => { disconnected = true; });
      try {
        await stream.writeSSE({ data: JSON.stringify(chunk({ role: "assistant", content: "" })) });
        const response = await chatProject({
          ...args,
          onTextDelta: async (text) => {
            if (disconnected) return;
            emittedText += text;
            await stream.writeSSE({ data: JSON.stringify(chunk({ content: text })) });
          },
        });
        if (disconnected) return;
        // A provider failover/fallback after partial output cannot be represented as a successful stream.
        if (emittedText && normalizeExtractedText(emittedText.trim()) !== normalizeExtractedText(response.answer.trim())) {
          throw new Error("Generated answer changed after streaming began");
        }
        const tail = (emittedText ? "" : response.answer) + sourceList(response);
        if (tail) await stream.writeSSE({ data: JSON.stringify(chunk({ content: tail })) });
        await stream.writeSSE({ data: JSON.stringify({ ...chunk({}, completionFinishReason(response)), docslurp: { citations: response.citations, availability: response.availability } }) });
        if (input.stream_options?.include_usage) {
          await stream.writeSSE({ data: JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage: completionUsage(response) }) });
        }
        await stream.writeSSE({ data: "[DONE]" });
      } catch (error) {
        reportPublicError(error, { operation: "chat-completions-stream" }, c.req.raw.signal);
        if (!disconnected) await stream.writeSSE({ data: JSON.stringify(error instanceof ChatToolBlockedError
          ? errorBody(error.message, "server_error", error.code)
          : isChatTurnDeadlineError(error) ? errorBody(error.message, "timeout_error", error.code)
          : errorBody("Project stream failed. Retry without streaming.", "server_error")) });
      }
    });
  });

// OpenAI-compatible surface: the routes resolve their own bearer key.
authenticatedByRoute(chatCompletionsRoutes);
