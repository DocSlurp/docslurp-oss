import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();
vi.mock("../db.js", () => ({ sql: sqlMock }));
vi.mock("../services/organizations.js", () => ({ getWorkspaceAccess: vi.fn(async () => ({ workspaceId: "ws-1" })) }));

const { readWorkspaceSuggestions } = await import("../services/workspace-suggestions.js");

describe("workspace suggestions prefix matching", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });

  it.each([
    ["100%", "100\\%%"],
    ["a_b", "a\\_b%"],
    ["back\\slash", "back\\\\slash%"],
    ["plain", "plain%"],
  ])("escapes LIKE wildcards in %j", async (typed, pattern) => {
    await readWorkspaceSuggestions("user-1", "ws-1", { q: typed });
    const patterns = sqlMock.mock.calls.flatMap(([, ...values]) => values).filter((value) => typeof value === "string" && value.endsWith("%"));
    expect(patterns.length).toBeGreaterThan(0);
    expect(new Set(patterns)).toEqual(new Set([pattern]));
  });

  it("matches everything only when nothing was typed", async () => {
    await readWorkspaceSuggestions("user-1", "ws-1", { q: "  " });
    expect(sqlMock.mock.calls.flatMap(([, ...values]) => values)).toContain("%");
  });
});
