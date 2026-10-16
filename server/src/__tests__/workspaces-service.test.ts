import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();
const listAccessibleWorkspaceIdsMock = vi.fn();

vi.mock("../services/workspace-naming.js", () => ({
  refineWorkspaceNames: vi.fn(async () => undefined),
}));

vi.mock("../db.js", () => ({
  sql: Object.assign(sqlMock, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    listen: vi.fn(),
    begin: vi.fn(),
  }),
}));

vi.mock("../services/organizations.js", () => ({
  canEditWorkspace: vi.fn(() => true),
  canManageWorkspace: vi.fn(() => true),
  ensurePersonalOrganization: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  listAccessibleWorkspaceIds: listAccessibleWorkspaceIdsMock,
}));

// Attribution SQL is covered against real Postgres in usage-attribution.db.test.ts.
vi.mock("../services/usage-attribution.js", () => ({
  attributedUsage: () => "attributed_usage",
}));

vi.mock("../services/runs.js", () => ({
  buildRunProgressSnapshot: vi.fn(),
  withRunCosts: vi.fn(async (runs: unknown[]) => runs),
}));

const { refineWorkspaceNames } = await import("../services/workspace-naming.js");
const { listWorkspaceBoardRecords, listWorkspaces } = await import("../services/workspaces.js");

describe("listWorkspaces", () => {
  beforeEach(() => {
    vi.mocked(refineWorkspaceNames).mockClear();
    sqlMock.mockReset();
    listAccessibleWorkspaceIdsMock.mockReset();
  });

  it("does not refine titles during dashboard bootstrap reads", async () => {
    listAccessibleWorkspaceIdsMock.mockResolvedValue(["ws-1"]);
    sqlMock.mockResolvedValueOnce([]);
    expect(await listWorkspaces("user-1", { refineNames: false })).toEqual([]);
    expect(refineWorkspaceNames).not.toHaveBeenCalled();
    expect(sqlMock).toHaveBeenCalledOnce();
  });

  it("maps the real workspace page total instead of estimating from document count", async () => {
    listAccessibleWorkspaceIdsMock.mockResolvedValue(["ws-1"]);
    sqlMock.mockResolvedValueOnce([
      {
        id: "ws-1",
        org_id: "org-1",
        user_id: "user-1",
        name: "Contracts",
        template_key: null,
        system_prompt: null,
        pipeline: null,
        monthly_budget_cents: null,
        document_count: 2,
        total_page_count: 3,
        run_count: 1,
        latest_run_id: "run-1",
        latest_run_status: "completed",
        archived_at: null,
        slug: "amber-falcon-ridge",
        last_activity_at: "2026-04-08T18:00:00.000Z",
        created_at: "2026-04-08T17:00:00.000Z",
        updated_at: "2026-04-08T18:00:00.000Z",
      },
    ]);

    const workspaces = await listWorkspaces("user-1");

    expect(workspaces[0]).toMatchObject({
      documentCount: 2,
      totalPageCount: 3,
      sourceBytes: 0,
      pendingDocumentCount: 0,
      pendingPageCount: 0,
    });
  });

  it("reads corpus totals from counters and in-flight work separately", async () => {
    listAccessibleWorkspaceIdsMock.mockResolvedValue(["ws-1"]);
    sqlMock.mockResolvedValueOnce([
      {
        id: "ws-1",
        org_id: "org-1",
        user_id: "user-1",
        name: "Contracts",
        template_key: null,
        system_prompt: null,
        pipeline: null,
        monthly_budget_cents: null,
        document_count: 4,
        total_page_count: 40,
        source_bytes: "123456789",
        pending_document_count: 2,
        pending_page_count: 20,
        run_count: 3,
        latest_run_id: "run-3",
        latest_run_status: "processing",
        archived_at: null,
        slug: "amber-falcon-ridge",
        last_activity_at: "2026-04-08T18:00:00.000Z",
        created_at: "2026-04-08T17:00:00.000Z",
        updated_at: "2026-04-08T18:00:00.000Z",
      },
    ]);

    const [workspace] = await listWorkspaces("user-1");

    expect(workspace).toMatchObject({
      documentCount: 4,
      totalPageCount: 40,
      sourceBytes: 123456789,
      pendingDocumentCount: 2,
      pendingPageCount: 20,
    });
  });
});

describe("listWorkspaceBoardRecords", () => {
  beforeEach(() => {
    vi.mocked(refineWorkspaceNames).mockClear();
    sqlMock.mockReset();
    listAccessibleWorkspaceIdsMock.mockReset();
  });

  it.each([{ pages: 18 }, JSON.stringify({ pages: 18 })])("reads board aggregates and stored run records (%s)", async (stats) => {
    listAccessibleWorkspaceIdsMock.mockResolvedValue(["ws-1"]);
    sqlMock
      .mockResolvedValueOnce([
        {
          id: "ws-1",
          org_id: "org-1",
          user_id: "user-1",
          name: "Contracts",
          template_key: null,
          system_prompt: null,
          pipeline: null,
          monthly_budget_cents: null,
          document_count: 2,
          total_page_count: 18,
          run_count: 1,
          latest_run_id: "run-1",
          latest_run_status: "completed",
          archived_at: null,
          slug: "amber-falcon-ridge",
          last_activity_at: "2026-04-08T18:00:00.000Z",
          created_at: "2026-04-08T17:00:00.000Z",
          updated_at: "2026-04-08T18:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          workspace_id: "ws-1",
          total_documents: 2,
          total_pages: 18,
          processed_pages: 18,
          completed_runs: 1,
          indexed_bytes: "8192",
          avg_completed_run_ms: 42000,
          search_sessions: 4,
          total_input_tokens: "1200",
          total_output_tokens: "300",
          total_embedding_tokens: "600",
          total_llm_cost_cents: "5",
        },
      ])
      .mockResolvedValueOnce([{
        id: "run-1", org_id: "org-1", user_id: "user-1", workspace_id: "ws-1",
        workspace_name: "Contracts", kind: "ingest", status: "completed", stage: "completed",
        total_documents: 2, processed_documents: 2, pages_total: 18, pages_processed: 18,
        pipeline: null, stats, artifacts: JSON.stringify({}), error: null,
        created_at: "2026-04-08T17:00:00.000Z", updated_at: "2026-04-08T18:00:00.000Z",
      }]);

    const records = await listWorkspaceBoardRecords("user-1");

    expect(records).toHaveLength(1);
    expect(records[0]?.run?.stats).toEqual({ pages: 18 });
    expect(records[0]?.run?.artifacts).toEqual({});
    expect(records[0]?.summary).toMatchObject({
      indexedBytes: 8192,
      totalInputTokens: 1200,
      totalOutputTokens: 300,
      totalEmbeddingTokens: 600,
      totalLlmCostCents: 5,
    });
  });
});
