import { HTTPException } from "hono/http-exception";

/** A failed tool blocks this turn; the model cannot decide to ignore or retry it. */
export class ChatToolBlockedError extends HTTPException {
  readonly code = "chat_tool_failed";
  readonly statusCode: 502 | 504;
  constructor(readonly toolName: string, readonly toolCode: string) {
    const status = toolCode === "tool_timeout" || toolCode === "deadline" ? 504 : 502;
    super(status, { message: "A required tool failed. The task is blocked; no successful answer or action has been confirmed." });
    this.name = "ChatToolBlockedError";
    this.statusCode = status;
  }
}

