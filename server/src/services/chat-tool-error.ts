import { PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";
import { HTTPException } from "hono/http-exception";

/** A failed tool blocks this turn; the model cannot decide to ignore or retry it. */
export class ChatToolBlockedError extends HTTPException {
  readonly code = "chat_tool_failed";
  readonly statusCode = 424;
  constructor(readonly toolName: string, readonly toolCode: string) {
    super(424, { message: PUBLIC_ERROR_MESSAGES.chatToolFailed });
    this.name = "ChatToolBlockedError";
  }
}

