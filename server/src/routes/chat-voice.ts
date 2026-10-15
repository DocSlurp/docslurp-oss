import { reportPublicError } from "../lib/public-errors.js";
import { publicErrorForStatus } from "@docslurp/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CHAT_VOICE_MAX_BYTES, CHAT_VOICE_MODEL } from "@docslurp/shared/chat-voice";
import { ChatVoiceError, WorkspaceChatVoice } from "../lib/chat-voice.js";
import { getWorkspace } from "../services/workspaces.js";
import { privacyModeOf } from "../lib/privacy.js";

// Mounted within the authenticated workspace routes, before /chat/:agentId.
export const chatVoiceRoutes = new Hono()
  .post("/:workspaceId/chat/transcribe", bodyLimit({
    maxSize: CHAT_VOICE_MAX_BYTES + 16 * 1024,
    onError: (c) => c.json({ error: "Recording exceeds the 8 MB limit." }, 413),
  }), async (c) => {
    const userId = c.get("sessionUser").id;
    const workspace = await getWorkspace(c.req.param("workspaceId"), userId);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "Send a multipart form with an audio file." }, 400);
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
        return c.json({ error: publicErrorForStatus(error.status) }, error.status);
      }
      throw error;
    }
  });
