import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { nativeErrorHandler } from "../lib/api-error.js";
import { spendAwareErrorHandler } from "./billing/spend-guard.js";
import { ChatToolBlockedError } from "./chat-tool-error.js";

describe("blocking tool errors at the production native boundary", () => {
  it.each([["http_403", 502], ["tool_timeout", 504], ["deadline", 504]] as const)("preserves %s status without route-specific middleware", async (code, status) => {
    const app = new Hono();
    app.onError(nativeErrorHandler(spendAwareErrorHandler));
    app.post("/v1/workspaces/ws/chat", () => { throw new ChatToolBlockedError("search", code); });
    const response = await app.request("/v1/workspaces/ws/chat", { method: "POST" });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error.code).toBe("chat_tool_failed");
    expect(body.error.message).toContain("blocked");
    expect(body).not.toHaveProperty("answer");
  });
});
