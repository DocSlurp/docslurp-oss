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
  describeSearchSettingsForAgent,
  requestsWorkspaceScope,
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
    expect(next.settings.retrievalDefaults).toMatchObject({ resultCount: 6, useMmr: true });
    expect(next.changes).toEqual([
      { field: "resultCount", before: 8, after: 6 },
      { field: "useMmr", before: current.retrievalDefaults.useMmr, after: true },
    ]);
    expect(next.workspaceScopeRequested).toBe(false);
    expect(current.retrievalDefaults.resultCount).toBe(8);
  });

  it("reports before/after for a rerank toggle and the prompt says it is this thread only", async () => {
    mocks.generate.mockResolvedValue({ text: '{"useRerank":true}', usage: { inputTokens: 20, outputTokens: 5 } });
    mocks.sql.mockResolvedValue([{ id: "session" }]);
    const off = { ...current, retrievalDefaults: { ...current.retrievalDefaults, useRerank: false } };
    const outcome = await configureSearchFromChat({ ...args, query: "Please turn on search reranking", current: off });
    expect(outcome.changes).toEqual([{ field: "useRerank", before: false, after: true }]);
    const note = describeSearchSettingsForAgent(outcome.settings, outcome);
    expect(note).toContain("This chat thread's search settings were just changed by the user's request: useRerank false→true (this thread only; workspace defaults unchanged)");
    expect(note).toContain("proposeWorkspaceSettings");
    expect(note).toContain("not that it was already set");
    expect(note).toContain("do not cite them");
  });

  it("changes nothing and saves nothing when the requested value is already in effect", async () => {
    mocks.generate.mockResolvedValue({ text: '{"useRerank":true}', usage: { inputTokens: 20, outputTokens: 5 } });
    const on = { ...current, retrievalDefaults: { ...current.retrievalDefaults, useRerank: true } };
    const outcome = await configureSearchFromChat({ ...args, query: "Turn on search reranking", current: on });
    expect(outcome.changes).toEqual([]);
    expect(outcome.unchanged).toEqual([{ field: "useRerank", before: true, after: true }]);
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(describeSearchSettingsForAgent(outcome.settings, outcome)).toContain("already in effect for this chat, so nothing changed: useRerank true");
  });

  it("does not report a change that failed to save", async () => {
    mocks.generate.mockResolvedValue({ text: '{"resultCount":6}', usage: { inputTokens: 10, outputTokens: 4 } });
    mocks.sql.mockResolvedValue([]);
    const outcome = await configureSearchFromChat(args);
    expect(outcome.changes).toEqual([]);
    expect(outcome.settings).toBe(args.current);
  });

  it("leaves a workspace-wide request to the agent: no thread override, no model call", async () => {
    for (const query of ["Please turn on search reranking for this workspace", "Enable retrieval reranking for everyone", "Turn on search rerank workspace-wide", "Use search rerank by default"]) {
      expect(requestsWorkspaceScope(query)).toBe(true);
    }
    expect(requestsWorkspaceScope("Turn on search reranking for this chat")).toBe(false);
    expect(requestsWorkspaceScope("Set search to use 6 results")).toBe(false);
    const outcome = await configureSearchFromChat({ ...args, query: "Please turn on search reranking for this workspace" });
    expect(outcome).toEqual({ settings: args.current, changes: [], unchanged: [], workspaceScopeRequested: true });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
    const note = describeSearchSettingsForAgent(outcome.settings, outcome);
    expect(note).toContain("whole workspace. Nothing was changed. Do not say it was applied.");
    expect(note).toContain("proposeWorkspaceSettings");
  });

  it("states plainly when a message changed no setting", () => {
    const note = describeSearchSettingsForAgent(current, { settings: current, changes: [], unchanged: [], workspaceScopeRequested: false });
    expect(note).toContain("did not change any search setting");
    expect(describeSearchSettingsForAgent(current)).not.toContain("just changed");
  });
  it("keeps existing settings when the model returns unsafe settings or the thread isn't the caller's", async () => {
    mocks.generate.mockResolvedValue({ text: '{"resultCount":999}', usage: { inputTokens: 10, outputTokens: 4 } });
    expect((await configureSearchFromChat(args)).settings).toBe(args.current);
    expect(mocks.sql).not.toHaveBeenCalled();
    mocks.generate.mockResolvedValue({ text: '{"resultCount":6}', usage: { inputTokens: 10, outputTokens: 4 } });
    mocks.sql.mockResolvedValue([]);
    expect((await configureSearchFromChat(args)).settings).toBe(args.current);
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
