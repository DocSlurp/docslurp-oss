import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { nativeErrorHandler } from "../lib/api-error.js";
import { spendAwareErrorHandler } from "./billing/spend-guard.js";
import { ChatTurnDeadlineError } from "./chat-turn-deadline.js";
import { ChatToolBlockedError } from "./chat-tool-error.js";

describe("blocking tool errors at the production native boundary", () => {
  it.each([["http_403", 424], ["tool_timeout", 424], ["deadline", 424]] as const)("preserves %s status without route-specific middleware", async (code, status) => {
    const app = new Hono();
    app.onError(nativeErrorHandler(spendAwareErrorHandler));
    app.use("*", async (c, next) => { c.header("X-Request-ID", "blocked-request"); await next(); });
    app.post("/v1/workspaces/ws/chat", () => { throw new ChatToolBlockedError("search", code); });
    const response = await app.request("/v1/workspaces/ws/chat", { method: "POST" });
    expect(response.status).toBe(status);
    expect(response.headers.get("X-Request-ID")).toBe("blocked-request");
    const body = await response.json();
    expect(body.error.code).toBe("chat_tool_failed");
    expect(body.error.message).toContain("blocked");
    expect(body).not.toHaveProperty("answer");
  });
});


it("uses 424 for application deadlines and retains 500 for unexpected infrastructure failures", async () => {
  const app = new Hono();
  app.onError(nativeErrorHandler(spendAwareErrorHandler));
  app.get("/v1/deadline", () => { throw new ChatTurnDeadlineError(1000); });
  app.get("/v1/infrastructure", () => { throw new Error("unavailable backend"); });
  expect((await app.request("/v1/deadline")).status).toBe(424);
  expect((await app.request("/v1/infrastructure")).status).toBe(500);
});
