import { reportPublicError } from "../lib/public-errors.js";
import { PUBLIC_ERROR_MESSAGES, publicErrorForStatus } from "@docslurp/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CHAT_VOICE_MAX_BYTES, CHAT_VOICE_MODEL } from "@docslurp/shared/chat-voice";
import { ChatVoiceError, ProjectChatVoice } from "../lib/chat-voice.js";
import { getProject } from "../services/projects.js";
import { privacyModeOf } from "../lib/privacy.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";

// Mounted within the authenticated project routes, before /chat/:agentId.
export const chatVoiceRoutes = new Hono()
  .post("/:projectId/chat/transcribe", bodyLimit({
    maxSize: CHAT_VOICE_MAX_BYTES + 16 * 1024,
    onError: (c) => apiErrorResponse(c, 413, "payload_too_large", "Recording exceeds the 8 MB limit."),
  }), async (c) => {
    const userId = c.get("sessionUser").id;
    const project = await getProject(c.req.param("projectId"), userId);
    if (!project) return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return apiStatusError(c, 400, "Send a multipart form with an audio file.");
    }
    const voice = new ProjectChatVoice({
      userId,
      scope: { orgId: project.orgId, projectId: project.id },
    }, privacyModeOf(project.pipeline));
    try {
      const text = await voice.listen(form.get("audio"));
      return c.json({ text, model: CHAT_VOICE_MODEL });
    } catch (error) {
      if (error instanceof ChatVoiceError) {
        reportPublicError(error, { operation: "chat-transcription", projectId: project.id });
        // 415 is actionable for the client (re-encode as WAV), so name it rather than "invalid".
        return apiStatusError(c, error.status, error.status === 415 ? PUBLIC_ERROR_MESSAGES.unsupportedType : publicErrorForStatus(error.status));
      }
      throw error;
    }
  });
