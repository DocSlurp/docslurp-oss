import { reportPublicError } from "../lib/public-errors.js";
import { PUBLIC_ERROR_MESSAGES, publicErrorForStatus } from "@docslurp/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CHAT_VOICE_MAX_BYTES, CHAT_VOICE_MODEL } from "@docslurp/shared/chat-voice";
import { ChatVoiceError, WorkspaceChatVoice } from "../lib/chat-voice.js";
import { getWorkspace } from "../services/workspaces.js";
import { privacyModeOf } from "../lib/privacy.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";

// Mounted within the authenticated workspace routes, before /chat/:agentId.
export const chatVoiceRoutes = new Hono()
  .post("/:workspaceId/chat/transcribe", bodyLimit({
    maxSize: CHAT_VOICE_MAX_BYTES + 16 * 1024,
    onError: (c) => apiErrorResponse(c, 413, "payload_too_large", "Recording exceeds the 8 MB limit."),
  }), async (c) => {
    const userId = c.get("sessionUser").id;
    const workspace = await getWorkspace(c.req.param("workspaceId"), userId);
    if (!workspace) return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return apiStatusError(c, 400, "Send a multipart form with an audio file.");
    }
    const voice = new WorkspaceChatVoice({
      userId,
      scope: { orgId: workspace.orgId, workspaceId: workspace.id },
    }, privacyModeOf(workspace.pipeline));
    try {
      const text = await voice.listen(form.get("audio"));
      return c.json({ text, model: CHAT_VOICE_MODEL });
    } catch (error) {
      if (error instanceof ChatVoiceError) {
        reportPublicError(error, { operation: "chat-transcription", workspaceId: workspace.id });
        // 415 is actionable for the client (re-encode as WAV), so name it rather than "invalid".
        return apiStatusError(c, error.status, error.status === 415 ? PUBLIC_ERROR_MESSAGES.unsupportedType : publicErrorForStatus(error.status));
      }
      throw error;
    }
  });
