import { describe, expect, it, vi, beforeEach } from "vitest";
import { defaultWorkspaceSearchSettings, type WorkspaceSearchSettings } from "@docslurp/shared";
const mocks = vi.hoisted(() => ({ generate: vi.fn(), persist: vi.fn(), sql: vi.fn(), updateWorkspace: vi.fn() }));
vi.mock("../lib/ai.js", () => ({ resolveOpenRouterApiKey: () => "test", generateOpenRouterText: mocks.generate }));
vi.mock("../lib/ai-usage.js", () => ({ recordUsageEvent: mocks.persist }));
vi.mock("../db.js", () => ({ sql: Object.assign(mocks.sql, { json: (value: unknown) => value }) }));
// Thread-scoped changes must never reach the workspace defaults.
vi.mock("../services/search-controls.js", () => ({ updateWorkspaceSearchSettingsForUser: mocks.updateWorkspace }));
import {
  configureSearchFromChat,
  conversationalSearchOptionsSchema,
  loadChatSessionSearchOverrides,
  requestsSearchConfiguration,
  withThreadRetrieval,
} from "../services/chat-search-options.js";
const current = defaultWorkspaceSearchSettings as WorkspaceSearchSettings;
const args = { workspaceId: "ws", orgId: "org", userId: "user", sessionId: "session", model: "z-ai/glm-5.3-flash" as never, current, query: "Set search to use 6 results and diversify", apiKey: "test", privacyMode: "standard" as const };
describe("conversational search configuration", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects expensive, unrecognized, and unbounded settings", () => {
    expect(conversationalSearchOptionsSchema.safeParse({ resultCount: 100 }).success).toBe(false);
    expect(conversationalSearchOptionsSchema.safeParse({ enableGraphExpansion: true }).success).toBe(false);
    expect(requestsSearchConfiguration("Explain the warranty")).toBe(false);
  });
  it("logs actual usage and saves safe settings on the chat thread, not the workspace", async () => {
    mocks.generate.mockResolvedValue({ text: '{"resultCount":6,"useMmr":true}', usage: { inputTokens: 51, outputTokens: 17 } });
    mocks.sql.mockResolvedValue([{ id: "session" }]);
    const next = await configureSearchFromChat({ ...args, threadOverrides: { useRerank: false } });
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({
      scope: { workspaceId: "ws", orgId: "org" },
      usage: expect.objectContaining({ inputTokens: 51, outputTokens: 17 }),
    }));
    const [strings, overrides, sessionId, workspaceId, userId] = mocks.sql.mock.calls[0];
    expect(strings.join("?")).toContain("update chat_sessions");
    expect(overrides).toEqual({ useRerank: false, resultCount: 6, useMmr: true });
    expect([sessionId, workspaceId, userId]).toEqual(["session", "ws", "user"]);
    expect(mocks.updateWorkspace).not.toHaveBeenCalled();
    expect(next.retrievalDefaults).toMatchObject({ resultCount: 6, useMmr: true });
    expect(current.retrievalDefaults.resultCount).toBe(8);
  });
  it("keeps existing settings when the model returns unsafe settings or the thread isn't the caller's", async () => {
    mocks.generate.mockResolvedValue({ text: '{"resultCount":999}', usage: { inputTokens: 10, outputTokens: 4 } });
    expect(await configureSearchFromChat(args)).toBe(args.current);
    expect(mocks.sql).not.toHaveBeenCalled();
    mocks.generate.mockResolvedValue({ text: '{"resultCount":6}', usage: { inputTokens: 10, outputTokens: 4 } });
    mocks.sql.mockResolvedValue([]);
    expect(await configureSearchFromChat(args)).toBe(args.current);
  });
  it("layers thread and request overrides over workspace defaults", () => {
    const merged = withThreadRetrieval(current, { resultCount: 4 }, { resultCount: 10, useRerank: false, useHyDE: undefined });
    expect(merged.retrievalDefaults).toMatchObject({ resultCount: 10, useRerank: false, useHyDE: false });
    expect(merged.chat.mode).toBe("retrieval");
    expect(withThreadRetrieval(current, {}, undefined)).toBe(current);
  });
  it("reads saved thread overrides and ignores invalid stored values", async () => {
    mocks.sql.mockResolvedValueOnce([{ search_overrides: { resultCount: 5 } }]);
    expect(await loadChatSessionSearchOverrides("session")).toEqual({ resultCount: 5 });
    mocks.sql.mockResolvedValueOnce([{ search_overrides: { resultCount: 500 } }]);
    expect(await loadChatSessionSearchOverrides("session")).toEqual({});
  });
});
