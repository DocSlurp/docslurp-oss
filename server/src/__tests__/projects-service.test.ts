import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();
const listAccessibleProjectIdsMock = vi.fn();

vi.mock("../services/project-naming.js", () => ({
  refineProjectNames: vi.fn(async () => undefined),
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
  canEditProject: vi.fn(() => true),
  canManageProject: vi.fn(() => true),
  resolveDefaultOrganization: vi.fn(),
  getProjectAccess: vi.fn(),
  listAccessibleProjectIds: listAccessibleProjectIdsMock,
}));

// Attribution SQL is covered against real Postgres in usage-attribution.db.test.ts.
vi.mock("../services/usage-attribution.js", () => ({
  attributedUsage: () => "attributed_usage",
}));

vi.mock("../services/runs.js", () => ({
  buildRunProgressSnapshot: vi.fn(),
  withRunCosts: vi.fn(async (runs: unknown[]) => runs),
}));

const { refineProjectNames } = await import("../services/project-naming.js");
const { listProjectBoardRecords, listProjects } = await import("../services/projects.js");

describe("listProjects", () => {
  beforeEach(() => {
    vi.mocked(refineProjectNames).mockClear();
    sqlMock.mockReset();
    listAccessibleProjectIdsMock.mockReset();
  });

  it("never refines titles on a read (the maintenance sweep does, after ingest)", async () => {
    listAccessibleProjectIdsMock.mockResolvedValue(["ws-1"]);
    sqlMock.mockResolvedValueOnce([]);
    expect(await listProjects("user-1")).toEqual([]);
    expect(refineProjectNames).not.toHaveBeenCalled();
    expect(sqlMock).toHaveBeenCalledOnce();
  });

  it("maps the real project page total instead of estimating from document count", async () => {
    listAccessibleProjectIdsMock.mockResolvedValue(["ws-1"]);
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

    const projects = await listProjects("user-1");

    expect(projects[0]).toMatchObject({
      documentCount: 2,
      totalPageCount: 3,
      sourceBytes: 0,
      pendingDocumentCount: 0,
      pendingPageCount: 0,
    });
  });

  it("lists every readable project when one row's stored settings no longer validate", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const row = (id: string, pipeline: unknown) => ({
      id, org_id: "org-1", user_id: "user-1", name: id, template_key: null, system_prompt: null, pipeline, monthly_budget_cents: null,
      document_count: 0, total_page_count: 0, run_count: 0, latest_run_id: null, latest_run_status: null, archived_at: null,
      slug: `slug-${id}`, last_activity_at: "2026-04-08T18:00:00.000Z", created_at: "2026-04-08T17:00:00.000Z", updated_at: "2026-04-08T18:00:00.000Z",
    });
    listAccessibleProjectIdsMock.mockResolvedValue(["good", "old-model", "bad-field", "unreadable"]);
    sqlMock.mockResolvedValueOnce([
      row("good", null),
      // The production shape: a model named by catalog id that is refused today.
      row("old-model", { vision: { model: "gpt-4.1-mini", prompt: "<OCR>", baseUrl: null, runtime: "remote-openai", benchmarkProfile: "difficult-pages", maxPagesPerDocument: 4, remoteFallbackModel: "gpt-4.1-mini" } }),
      // A setting the schema rejects outright: listed with the default for that field.
      row("bad-field", { quality: "no-such-quality", vision: { profile: "cheapest-hosted" } }),
      // Not a project row at all: left out, the others still listed.
      { ...row("unreadable", null), org_id: null, name: null },
    ]);

    const projects = await listProjects("user-1");

    expect(projects.map((project) => project.id)).toEqual(["good", "old-model", "bad-field"]);
    expect(JSON.stringify(projects)).not.toContain("gpt-4.1-mini");
    expect(projects[2]!.pipeline.vision.profile).toBe("cheapest-hosted");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("project bad-field has stored settings that no longer validate"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("project unreadable could not be read even with defaults; left out of the list"));
    error.mockRestore();
  });

  it("opens one project whose stored settings no longer validate, with defaults for the invalid fields and its privacy mode kept", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getProject } = await import("../services/projects.js");
    const { getProjectAccess } = await import("../services/organizations.js");
    vi.mocked(getProjectAccess).mockResolvedValue({ orgId: "org-1" } as never);
    sqlMock.mockResolvedValueOnce([{
      id: "ws-old", org_id: "org-1", user_id: "user-1", name: "Old", template_key: null, system_prompt: null, monthly_budget_cents: null,
      pipeline: { privacyMode: "local-only", quality: "no-such-quality", embedding: { profile: "cheapest-local" }, vision: { profile: "cheapest-local" } },
      document_count: 0, total_page_count: 0, run_count: 0, latest_run_id: null, latest_run_status: null, archived_at: null,
      slug: "old", last_activity_at: "2026-04-08T18:00:00.000Z", created_at: "2026-04-08T17:00:00.000Z", updated_at: "2026-04-08T18:00:00.000Z",
    }]);

    const project = await getProject("ws-old", "user-1");

    expect(project?.id).toBe("ws-old");
    expect(project?.pipeline.privacyMode).toBe("local-only");
    expect(project?.pipeline.embedding.profile).toBe("cheapest-local");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("project ws-old has stored settings that no longer validate"));
    error.mockRestore();
  });

  it("reads corpus totals from counters and in-flight work separately", async () => {
    listAccessibleProjectIdsMock.mockResolvedValue(["ws-1"]);
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

    const [project] = await listProjects("user-1");

    expect(project).toMatchObject({
      documentCount: 4,
      totalPageCount: 40,
      sourceBytes: 123456789,
      pendingDocumentCount: 2,
      pendingPageCount: 20,
    });
  });
});

describe("listProjectBoardRecords", () => {
  beforeEach(() => {
    vi.mocked(refineProjectNames).mockClear();
    sqlMock.mockReset();
    listAccessibleProjectIdsMock.mockReset();
  });

  it.each([{ pages: 18 }, JSON.stringify({ pages: 18 })])("reads board aggregates and stored run records (%s)", async (stats) => {
    listAccessibleProjectIdsMock.mockResolvedValue(["ws-1"]);
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
          project_id: "ws-1",
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
        id: "run-1", org_id: "org-1", user_id: "user-1", project_id: "ws-1",
        project_name: "Contracts", kind: "ingest", status: "completed", stage: "completed",
        total_documents: 2, processed_documents: 2, pages_total: 18, pages_processed: 18,
        pipeline: null, stats, artifacts: JSON.stringify({}), error: null,
        created_at: "2026-04-08T17:00:00.000Z", updated_at: "2026-04-08T18:00:00.000Z",
      }]);

    const records = await listProjectBoardRecords("user-1");

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
