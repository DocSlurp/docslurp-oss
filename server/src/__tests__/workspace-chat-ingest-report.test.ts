import { defaultPipelineFeatures, defaultWorkspaceSearchSettings } from "@docslurp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** "/status" and "how did my files process?" are answered from the ingest report without a model or spend. */
const sqlMock = Object.assign(vi.fn(async () => []), { unsafe: vi.fn(), begin: vi.fn() });
const assertCanSpend = vi.fn(async () => undefined);
const generateOpenRouterText = vi.fn();
const loadIngestReport = vi.fn();
const getWorkspace = vi.fn();
const getWorkspaceAccess = vi.fn();
const canEditWorkspace = vi.fn();

vi.mock("../db.js", () => ({ sql: sqlMock }));
vi.mock("../services/billing/spend-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/billing/spend-guard.js")>()),
  assertCanSpend,
}));
vi.mock("../services/workspaces.js", () => ({ getWorkspace }));
vi.mock("../services/organizations.js", () => ({ getWorkspaceAccess, canEditWorkspace }));
vi.mock("../services/search-controls.js", () => ({ getWorkspaceSearchSettings: vi.fn(async () => defaultWorkspaceSearchSettings) }));
vi.mock("../services/ingest-report.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ingest-report.js")>()),
  loadIngestReport,
}));
vi.mock("../lib/ai.js", () => ({
  SEARCH_OPENROUTER_MODEL: "openrouter-test",
  resolveOpenRouterApiKey: vi.fn(() => "key"),
  generateOpenRouterText,
  generateOpenRouterDocumentText: generateOpenRouterText,
}));

const { chatWorkspace } = await import("../services/workspace-chat.js");
const { buildIngestReport } = await import("../services/ingest-report.js");

const report = buildIngestReport({
  workspace: { id: "ws-1", name: "Contracts", pipeline: defaultPipelineFeatures },
  scope: { runId: null, documentIds: null, matchedDocuments: 1 },
  documents: [{ id: "d1", filename: "mixed.pdf", mimeType: "application/pdf", status: "completed", pageCount: 2, fileSize: 1000, runId: "r1", createdAt: "2026-10-14T00:00:00Z", chunkTotal: 1, chunkUnattributed: 0, language: null }],
  pageDetailDocumentIds: ["d1"],
  pages: [
    { documentId: "d1", pageNumber: 1, hasFacts: true, textBytes: 900, imageCount: 0, visionStatus: "not-selected", chunkCount: 1, chunkBytes: 900 },
    { documentId: "d1", pageNumber: 2, hasFacts: true, textBytes: 0, imageCount: 1, visionStatus: "not-selected", chunkCount: 0, chunkBytes: 0 },
  ],
  stages: [], runs: [], costCents: null, canEdit: true, focusPages: [2],
});

beforeEach(() => {
  vi.clearAllMocks();
  getWorkspace.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "Contracts", pipeline: defaultPipelineFeatures });
  getWorkspaceAccess.mockResolvedValue({ role: "viewer" });
  canEditWorkspace.mockReturnValue(false);
  loadIngestReport.mockResolvedValue(report);
  sqlMock.mockImplementation(async () => []);
});

describe("chat ingest report intent", () => {
  it("answers /status with the report and no model call or spend check", async () => {
    const response = await chatWorkspace({ workspaceId: "ws-1", userId: "u1", query: "why can't it find page 2?", answerIngestReport: true });
    expect(generateOpenRouterText).not.toHaveBeenCalled();
    expect(assertCanSpend).not.toHaveBeenCalled();
    expect(response.ingestReport).toBe(report);
    expect(response.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, costCents: 0 });
    expect(response.answer).toMatch(/Page 2 of mixed\.pdf: not searchable/);
    expect(loadIngestReport).toHaveBeenCalledWith(expect.objectContaining({ canEdit: false, focusPages: [2], documentIds: null }));
    expect(loadIngestReport.mock.calls[0]![0].workspace).toMatchObject({ id: "ws-1" });
  });

  it("narrows the report to the composer's document filter", async () => {
    await chatWorkspace({ workspaceId: "ws-1", userId: "u1", query: "/status", filters: { documentIds: ["d1"] }, answerIngestReport: true });
    expect(loadIngestReport).toHaveBeenCalledWith(expect.objectContaining({ documentIds: ["d1"] }));
  });

  it("refuses a workspace the user cannot read", async () => {
    getWorkspace.mockResolvedValue(null);
    await expect(chatWorkspace({ workspaceId: "ws-1", userId: "u1", query: "/status", answerIngestReport: true })).rejects.toThrow("Workspace not found");
    expect(loadIngestReport).not.toHaveBeenCalled();
  });

  it("never answers API, MCP or OpenAI-compatible callers with the report", async () => {
    getWorkspace.mockResolvedValue(null);
    await chatWorkspace({ workspaceId: "ws-1", userId: "u1", query: "/status" }).catch(() => undefined);
    expect(loadIngestReport).not.toHaveBeenCalled();
    expect(assertCanSpend).toHaveBeenCalled();
  });

  it("leaves ordinary questions to the model path", async () => {
    getWorkspace.mockResolvedValue(null);
    await chatWorkspace({ workspaceId: "ws-1", userId: "u1", query: "What is the notice period?" }).catch(() => undefined);
    expect(assertCanSpend).toHaveBeenCalled();
    expect(loadIngestReport).not.toHaveBeenCalled();
  });
});
