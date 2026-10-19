import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultWorkspaceSearchSettings, normalizePipelineFeatures, validateDeepInfraEmbedding } from "@docslurp/shared";

const mocks = vi.hoisted(() => ({ sql: Object.assign(vi.fn(), { begin: vi.fn(), array: vi.fn((v: unknown) => v) }), embed: vi.fn(), report: vi.fn() }));
vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("../lib/ai.js", () => ({ embedConfiguredText: mocks.embed }));
vi.mock("../lib/public-errors.js", () => ({ reportPublicError: mocks.report }));
const { runSearchSession } = await import("../search/session-runner.js");
const { createSearchSessionJournal } = await import("../search/session.js");

function fixture() {
  const session = createSearchSessionJournal({ rootSessionId: "failed-search", scope: { workspaceId: "workspace", orgId: "organization" } });
  const adapters = { buildAvailability: vi.fn(), completedPageSearch: vi.fn(), progressivePageSearch: vi.fn(), vectorSearch: vi.fn(), textSearch: vi.fn(), graphNeighborSearch: vi.fn(), communitySummarySearch: vi.fn(), runSearch: vi.fn(), wholeCorpusFallback: vi.fn() };
  const setup = { session, normalizedScope: { workspaceId: "workspace", orgId: "organization" }, workspaceSettings: defaultWorkspaceSearchSettings, openRouterApiKey: undefined, availabilityRow: undefined, resolvedOptions: {}, workspacePipeline: normalizePipelineFeatures({ embedding: { profile: "cheapest-hosted", target: "hosted", modelUri: "llm://deepinfra/BAAI/bge-m3" } }), privacyMode: "standard" as const };
  return { query: "Generic evidence question", userId: "user", options: {}, setup, adapters };
}
const usageWrites = () => mocks.sql.mock.calls.filter(([parts]) => Array.isArray(parts) && parts.join(" ").includes("insert into usage_events"));

describe("failed paid search accounting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockResolvedValue([]);
    mocks.sql.begin.mockImplementation(async (run) => run(mocks.sql));
    vi.stubEnv("DEEPINFRA_API_KEY", "test-only");
    mocks.embed.mockImplementation(async ({ onUsage }) => {
      await onUsage({ inputTokens: 7 });
      return { embedding: validateDeepInfraEmbedding([1, 2]), usage: { inputTokens: 7 } };
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([false, true])("persists paid vector failures without duplicate flushes (suppressed result logging: %s)", async (suppressSessionLog) => {
    const args = { ...fixture(), options: { suppressSessionLog } };
    await expect(runSearchSession(args)).rejects.toThrow("exactly 1024");
    expect(usageWrites()).toHaveLength(1);
    const write = usageWrites()[0]!;
    expect(write).toContain("user"); expect(write).toContain("deepinfra"); expect(write).toContain("BAAI/bge-m3"); expect(write).toContain(7);
    expect(write.some(value => typeof value === "string" && value.includes('"workspaceId":"workspace"') && value.includes('"orgId":"organization"') && value.includes('"sessionId":"failed-search"'))).toBe(true);
    expect(args.adapters.vectorSearch).not.toHaveBeenCalled();
    await args.setup.session.flushUsage(args.userId);
    expect(usageWrites()).toHaveLength(1);
  });

  it("retains the original validation error if usage persistence also fails", async () => {
    mocks.sql.mockRejectedValue(new Error("Database unavailable"));
    await expect(runSearchSession(fixture())).rejects.toThrow("exactly 1024");
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ message: "Database unavailable" }), expect.objectContaining({ operation: "search-failed-usage" }));
  });
});
