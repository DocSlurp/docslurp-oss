import { beforeEach, describe, expect, it, vi } from "vitest";

const createRunMock = vi.fn();
const createDocumentBatchMock = vi.fn();
const statements: string[] = [];
const lockedRuns = new Set<string>();

vi.mock("../db.js", () => {
  const client = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push(text);
    if (text.startsWith("select id from workspace_runs")) {
      return Promise.resolve(lockedRuns.has(String(values[0])) ? [{ id: values[0] }] : []);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(client, { begin: async (fn: (tx: typeof client) => unknown) => await fn(client) });
  return { sql };
});

vi.mock("../services/runs.js", () => ({
  createRun: createRunMock,
  createDocumentBatch: createDocumentBatchMock,
}));

const { createRunManifest } = await import("../services/run-manifest.js");
const { defaultPipelineFeatures } = await import("@docslurp/shared");

describe("Run Manifest Module", () => {
  beforeEach(() => {
    createRunMock.mockReset();
    createDocumentBatchMock.mockReset();
    statements.length = 0;
    lockedRuns.clear();
    createRunMock.mockResolvedValue({ id: "run-1", totalDocuments: 2 });
    createDocumentBatchMock.mockResolvedValue([
      { id: "doc-1", pageCount: 3 },
      { id: "doc-2", pageCount: 5 },
    ]);
  });

  it("materializes one Run and its Documents through one Interface", async () => {
    const manifest = await createRunManifest({
      userId: "user-1",
      workspaceId: "ws-1",
      kind: "bulk-upload",
      pipeline: defaultPipelineFeatures,
      files: [
        {
          filename: "a.txt",
          mimeType: "text/plain",
          sourceKey: "user-1/raw/a.txt",
        },
        {
          filename: "b.txt",
          mimeType: "text/plain",
          sourceKey: "user-1/raw/b.txt",
        },
      ],
    });

    expect(createRunMock).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      kind: "bulk-upload",
      totalDocuments: 2,
      pipeline: defaultPipelineFeatures,
      apiKeyId: null,
    });
    expect(createDocumentBatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workspaceId: "ws-1",
        runId: "run-1",
      }),
    );
    expect(manifest).toEqual({
      run: { id: "run-1", totalDocuments: 2, pagesTotal: 8 },
      documents: [
        { id: "doc-1", pageCount: 3 },
        { id: "doc-2", pageCount: 5 },
      ],
    });
  });

  it("discards the committed Run when its Documents cannot be created", async () => {
    lockedRuns.add("run-1");
    const failure = new Error("canceling statement due to user request");
    createDocumentBatchMock.mockRejectedValue(failure);

    await expect(createRunManifest({
      userId: "user-1",
      workspaceId: "ws-1",
      kind: "bulk-upload",
      pipeline: defaultPipelineFeatures,
      files: [{ filename: "a.txt", mimeType: "text/plain", sourceKey: "user-1/raw/a.txt" }],
    })).rejects.toBe(failure);

    expect(statements).toEqual([
      "select id from workspace_runs where id = ? and status = 'queued' for update",
      "delete from documents where run_id = ?",
      "delete from workspace_runs where id = ?",
    ]);
  });

  it("keeps a Run that already left the queued state", async () => {
    createDocumentBatchMock.mockRejectedValue(new Error("boom"));
    await expect(createRunManifest({
      userId: "user-1",
      workspaceId: "ws-1",
      kind: "bulk-upload",
      pipeline: defaultPipelineFeatures,
      files: [{ filename: "a.txt", mimeType: "text/plain", sourceKey: "user-1/raw/a.txt" }],
    })).rejects.toThrow("boom");
    expect(statements.some((statement) => statement.startsWith("delete"))).toBe(false);
  });
});
