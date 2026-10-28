import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: vi.fn() }));
const { ClientSurfaceRecorder, classifyClientSurface, parseClientHeader } = await import("../services/client-surface.js");

const session = { type: "session", userId: "u1", sessionId: "s1", user: { id: "u1", email: "", name: "" } } as const;
const key = (keyType: "server" | "client", oauth?: "api" | "mcp") =>
  ({ type: "apiKey", userId: "u1", apiKey: { keyId: "k", userId: "u1", keyType, ...(oauth ? { oauth: { audience: oauth } } : {}) } }) as never;

describe("client header parsing", () => {
  it("accepts known products with or without a version", () => {
    expect(parseClientHeader("sdk")).toEqual({ surface: "sdk", client: "sdk" });
    expect(parseClientHeader("cli/0.3.0")).toEqual({ surface: "cli", client: "cli/0.3.0" });
    expect(parseClientHeader("mcp-stdio")).toEqual({ surface: "mcp_stdio", client: "mcp-stdio" });
  });
  it.each([null, "", "web", "SDK", "sdk/<script>", "sdk/1.0 extra", "x".repeat(65), "sdk\r\nX-Evil: 1", "__proto__", "constructor"])(
    "ignores unknown or malformed value %j", (value) => {
      expect(parseClientHeader(value)).toBeNull();
    });
});

describe("surface classification", () => {
  it("labels sessions as web even when a client header claims otherwise", () => {
    expect(classifyClientSurface({ path: "/v1/search", actor: session as never, clientHeader: "cli/1.0.0" })?.surface).toBe("web");
  });
  it("labels MCP by route or token audience, never by header", () => {
    expect(classifyClientSurface({ path: "/v1/mcp", actor: key("server"), clientHeader: "sdk" })?.surface).toBe("mcp");
    expect(classifyClientSurface({ path: "/v1/search", actor: key("server", "mcp") })?.surface).toBe("mcp");
  });
  it("labels CLI OAuth tokens as CLI unless the stdio MCP server tagged them", () => {
    expect(classifyClientSurface({ path: "/v1/search", actor: key("server", "api"), clientHeader: "sdk" })).toEqual({ surface: "cli", client: null });
    expect(classifyClientSurface({ path: "/v1/search", actor: key("server", "api"), clientHeader: "mcp-stdio" })?.surface).toBe("mcp_stdio");
  });
  it("falls back to path and key type for untagged API keys", () => {
    expect(classifyClientSurface({ path: "/v1/search", actor: key("server"), clientHeader: "sdk" })?.surface).toBe("sdk");
    expect(classifyClientSurface({ path: "/compat/algolia/1/indexes/x/query", actor: key("client") })?.surface).toBe("search_compat");
    expect(classifyClientSurface({ path: "/v1/chat/completions", actor: key("server") })?.surface).toBe("openai_compat");
    expect(classifyClientSurface({ path: "/v1/search", actor: key("client") })?.surface).toBe("browser_key");
    expect(classifyClientSurface({ path: "/v1/search", actor: key("server") })?.surface).toBe("api");
  });
  it("records nothing without an authenticated actor", () => {
    expect(classifyClientSurface({ path: "/v1/search", actor: undefined, clientHeader: "sdk" })).toBeNull();
  });
});

describe("surface recorder", () => {
  it("coalesces hits per user and surface into one upsert", async () => {
    const calls: unknown[][] = [];
    const db = Object.assign((...args: unknown[]) => { calls.push(args); return Promise.resolve([]); }, { json: (value: unknown) => value });
    const recorder = new ClientSurfaceRecorder(() => db as never, 60_000);
    recorder.record("u1", "sdk", "sdk", new Date("2026-10-01T00:00:00Z"));
    recorder.record("u1", "sdk", null, new Date("2026-10-01T00:01:00Z"));
    recorder.record("u2", "cli", "cli/0.3.0");
    await recorder.flush();
    expect(calls).toHaveLength(1);
    const batch = calls[0]![1] as { user_id: string; count: number; last_client: string | null }[];
    expect(batch).toHaveLength(2);
    expect(batch.find(row => row.user_id === "u1")).toMatchObject({ count: 2, last_client: "sdk" });
    await recorder.flush();
    expect(calls).toHaveLength(1);
  });
  it("bounds pending entries and survives a failed flush", async () => {
    const db = Object.assign(() => Promise.reject(new Error("db down")), { json: (value: unknown) => value });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recorder = new ClientSurfaceRecorder(() => db as never, 60_000, 2);
    recorder.record("a", "api", null); recorder.record("b", "api", null); recorder.record("c", "api", null);
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
