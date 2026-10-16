import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures, getWorkspaceTemplate, normalizePipelineFeatures } from "@docslurp/shared";

import { env } from "../config.js";
import {
  intakeIntoWorkspace,
  WorkspaceIntakeError,
  type WorkspaceIntakeItem,
  type WorkspaceIntakeRequest,
} from "../services/workspace-intake.js";
import { remoteUrlIntakeItems } from "../services/remote-ingest.js";
import { createWorkspaceIntakeFakes, fakeWorkspace } from "./helpers/workspace-intake-fakes.js";

// URL safety checks resolve hosts; keep them independent of live DNS.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

function bytesItem(filename: string, body = "hello", mimeType = "text/plain"): WorkspaceIntakeItem {
  return { filename, mimeType, content: { bytes: Buffer.from(body) } };
}

function request(overrides: Partial<WorkspaceIntakeRequest> = {}): WorkspaceIntakeRequest {
  return {
    userId: "user-1",
    orgId: "org-1",
    workspaceId: null,
    newWorkspace: true,
    kind: "bulk-upload",
    items: [bytesItem("contracts.txt")],
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<WorkspaceIntakeError> {
  const error = await promise.then(
    () => {
      throw new Error("expected intake to reject");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WorkspaceIntakeError);
  return error as WorkspaceIntakeError;
}

const originalMaxUploadBytes = env.maxUploadBytes;
const originalComplexFormats = env.remoteIngestComplexFormatsEnabled;

afterEach(() => {
  (env as { maxUploadBytes: number }).maxUploadBytes = originalMaxUploadBytes;
  (env as { remoteIngestComplexFormatsEnabled: boolean }).remoteIngestComplexFormatsEnabled = originalComplexFormats;
  vi.unstubAllGlobals();
});

describe("Workspace Intake", () => {
  it("stores uploaded bytes, self-titles a new workspace, creates the run, starts it, and audits", async () => {
    const fakes = createWorkspaceIntakeFakes();
    const result = await intakeIntoWorkspace(
      request({
        items: [
          bytesItem("master_service_agreement_v2.pdf", "%PDF", "application/pdf"),
          bytesItem("notes.md", "# hi", "application/octet-stream"),
        ],
        audit: { ipAddress: "127.0.0.1", userAgent: "vitest" },
      }),
      fakes.ports,
    );

    expect(fakes.createdWorkspaces).toEqual([
      expect.objectContaining({ name: "Master service agreement v2 + 1 more", orgId: "org-1", autoNamed: true }),
    ]);
    const [run] = fakes.runs;
    expect(run).toMatchObject({ workspaceId: result?.workspace.id, kind: "bulk-upload", pipeline: defaultPipelineFeatures });
    // The policy resolves generic MIME types from the extension.
    expect(run.files.map((file) => file.mimeType)).toEqual(["application/pdf", "text/markdown"]);
    expect(run.files.map((file) => file.fileSize)).toEqual([4, 4]);
    for (const file of run.files) {
      expect(file.sourceKey).toMatch(new RegExp(`^user-1/[0-9a-f-]+/raw/[0-9a-f-]+-${file.filename.replace(".", "\\.")}$`));
      expect(fakes.objects.get(file.sourceKey)?.contentType).toBe(file.mimeType);
    }
    expect(fakes.started).toEqual([run.id]);
    expect(result?.deferredReason).toBeNull();
    expect(fakes.audit).toEqual([
      expect.objectContaining({
        action: "documents.uploaded",
        runId: run.id,
        ipAddress: "127.0.0.1",
        metadata: { count: 2, mode: "bulk-upload", userAgent: "vitest" },
      }),
    ]);
    expect(JSON.stringify(fakes.audit)).not.toContain("master_service_agreement");
  });

  it("records actual streamed bytes despite a misleading declared length", async () => {
    const fakes = createWorkspaceIntakeFakes();
    await intakeIntoWorkspace(request({ items: [{
      filename: "stream.txt", mimeType: "text/plain", sizeBytes: 900,
      content: { stream: Readable.from([Buffer.from("hé"), Buffer.from("llo")]), contentLength: 1 },
    }] }), fakes.ports);
    expect(fakes.runs[0].files[0].fileSize).toBe(Buffer.byteLength("héllo"));
    expect(fakes.objects.get(fakes.runs[0].files[0].sourceKey)?.body.toString()).toBe("héllo");
  });

  it("keeps already-stored source byte counts unknown instead of trusting declarations", async () => {
    const fakes = createWorkspaceIntakeFakes();
    await intakeIntoWorkspace(request({ items: [{ filename: "stored.txt", sizeBytes: 900, content: { storedKey: "existing/raw.txt" } }] }), fakes.ports);
    expect(fakes.runs[0].files[0].fileSize).toBeUndefined();
  });

  it("files untargeted uploads into the organization's default workspace", async () => {
    const fakes = createWorkspaceIntakeFakes();
    const first = await intakeIntoWorkspace(request({ newWorkspace: undefined }), fakes.ports);
    const second = await intakeIntoWorkspace(request({ newWorkspace: undefined }), fakes.ports);

    expect(fakes.createdWorkspaces).toEqual([]);
    expect(first?.workspace).toMatchObject({ id: "ws-default-org-1", isDefault: true });
    expect(second?.workspace.id).toBe("ws-default-org-1");
    expect(fakes.runs.map((run) => run.workspaceId)).toEqual(["ws-default-org-1", "ws-default-org-1"]);
  });

  it("treats the reserved \"default\" workspace ID as the organization's default workspace", async () => {
    const fakes = createWorkspaceIntakeFakes();
    const result = await intakeIntoWorkspace(request({ workspaceId: "default", newWorkspace: true }), fakes.ports);
    expect(result?.workspace.id).toBe("ws-default-org-1");
    expect(fakes.createdWorkspaces).toEqual([]);
  });

  it("creates a workspace when a name or template is given without an explicit flag", async () => {
    const fakes = createWorkspaceIntakeFakes();
    await intakeIntoWorkspace(request({ newWorkspace: undefined, workspaceName: "Contracts" }), fakes.ports);
    await intakeIntoWorkspace(request({ newWorkspace: undefined, templateKey: "engineering-docs" }), fakes.ports);
    expect(fakes.createdWorkspaces.map((workspace) => workspace.name)).toEqual(["Contracts", "Contracts"]);
  });

  it("keeps a caller-chosen workspace name instead of self-titling", async () => {
    const fakes = createWorkspaceIntakeFakes();
    await intakeIntoWorkspace(request({ workspaceName: "Contracts" }), fakes.ports);
    expect(fakes.createdWorkspaces).toEqual([expect.objectContaining({ name: "Contracts", autoNamed: false })]);
  });

  it("appends to an existing workspace and inherits its pipeline", async () => {
    const pipeline = { ...defaultPipelineFeatures, embed: false, indexVectors: false };
    const fakes = createWorkspaceIntakeFakes({ workspaces: [fakeWorkspace({ id: "ws-existing", pipeline })] });
    const result = await intakeIntoWorkspace(request({ workspaceId: "ws-existing" }), fakes.ports);

    expect(fakes.createdWorkspaces).toEqual([]);
    expect(result?.workspace.id).toBe("ws-existing");
    expect(fakes.runs[0]).toMatchObject({ workspaceId: "ws-existing", pipeline });
  });

  it("merges per-upload pipeline overrides onto the workspace pipeline", async () => {
    const pipeline = normalizePipelineFeatures({ summarize: true, graph: { domain: "Supplier contracts", depth: "deep" } });
    const fakes = createWorkspaceIntakeFakes({ workspaces: [fakeWorkspace({ id: "ws-existing", pipeline })] });
    await intakeIntoWorkspace(
      request({ workspaceId: "ws-existing", pipeline: { pageIndex: true, graph: { depth: "lean" } } }),
      fakes.ports,
    );

    const run = fakes.runs[0].pipeline;
    expect(run.summarize).toBe(true); // kept from the workspace, not reset to the default
    expect(run.pageIndex).toBe(true); // the override
    expect(run.graph).toMatchObject({ domain: "Supplier contracts", depth: "lean" });
  });

  it("keeps template-locked settings when an upload tries to override them", async () => {
    const template = getWorkspaceTemplate("legal-contracts")!;
    const fakes = createWorkspaceIntakeFakes({
      workspaces: [fakeWorkspace({ id: "ws-legal", templateKey: "legal-contracts", pipeline: template.pipeline })],
    });
    await intakeIntoWorkspace(
      request({
        workspaceId: "ws-legal",
        pipeline: { summarize: !template.pipeline.summarize, piiPolicy: { enabled: false }, parserPlaybook: "fast", chunkOverlap: true },
      }),
      fakes.ports,
    );

    const run = fakes.runs[0].pipeline;
    expect(run.summarize).toBe(template.pipeline.summarize);
    expect(run.piiPolicy.enabled).toBe(true);
    expect(run.parserPlaybook).toBe("review-grade");
    expect(run.chunkOverlap).toBe(true); // not locked, so the override applies
  });

  it("rejects an unknown target workspace before reading any source item", async () => {
    const fakes = createWorkspaceIntakeFakes();
    const read = vi.fn();
    async function* items(): AsyncGenerator<WorkspaceIntakeItem> {
      read();
      yield bytesItem("a.txt");
    }

    const error = await rejection(intakeIntoWorkspace(request({ workspaceId: "missing", items: items() }), fakes.ports));
    expect(error.statusCode).toBe(404);
    expect(read).not.toHaveBeenCalled();
    expect(fakes.objects.size).toBe(0);
  });

  it("refuses a workspace from another organization", async () => {
    const fakes = createWorkspaceIntakeFakes({ workspaces: [fakeWorkspace({ id: "ws-other", orgId: "org-2" })] });
    const error = await rejection(intakeIntoWorkspace(request({ workspaceId: "ws-other" }), fakes.ports));
    expect(error.message).toBe("Workspace does not belong to the requested organization");
    expect(fakes.runs).toEqual([]);
  });

  it("rejects a lone unsupported file with 415 and creates nothing", async () => {
    const fakes = createWorkspaceIntakeFakes();
    const error = await rejection(
      intakeIntoWorkspace(
        request({ items: [bytesItem("payload.exe", "MZ", "application/x-msdownload")] }),
        fakes.ports,
      ),
    );
    expect(error).toMatchObject({ statusCode: 415, message: "Unsupported file type for payload.exe" });
    expect(fakes.objects.size).toBe(0);
    expect(fakes.createdWorkspaces).toEqual([]);
  });

  describe("partial intake (every source)", () => {
    it("takes the valid files and reports unsupported, oversized and unreadable ones", async () => {
      (env as { maxUploadBytes: number }).maxUploadBytes = 8;
      const fakes = createWorkspaceIntakeFakes();
      fakes.state.unreadable.add("broken.pdf");
      const result = await intakeIntoWorkspace(
        request({
          items: [
            bytesItem("ok.txt"),
            bytesItem("payload.exe", "MZ", "application/x-msdownload"),
            bytesItem("big.txt", "123456789"),
            bytesItem("broken.pdf", "%PDF", "application/pdf"),
            bytesItem("also-ok.md", "# hi", "text/markdown"),
          ],
        }),
        fakes.ports,
      );

      expect(result?.documents.map((document) => document.filename)).toEqual(["ok.txt", "also-ok.md"]);
      expect(result?.rejected).toEqual([
        { filename: "payload.exe", statusCode: 415, code: "unsupported_type", message: "Unsupported file type for payload.exe" },
        expect.objectContaining({ filename: "big.txt", statusCode: 413, code: "file_too_large" }),
        expect.objectContaining({ filename: "broken.pdf", statusCode: 422, code: "unreadable_source" }),
      ]);
      expect(fakes.runs[0]!.files.map((file) => file.filename)).toEqual(["ok.txt", "also-ok.md"]);
      // The unreadable file's raw object is removed; only accepted files stay in storage.
      expect([...fakes.objects.keys()].sort()).toEqual(fakes.runs[0]!.files.map((file) => file.sourceKey).sort());
    });

    it("still fails, naming every file, when nothing is accepted", async () => {
      const fakes = createWorkspaceIntakeFakes();
      const error = await rejection(intakeIntoWorkspace(
        request({ items: [bytesItem("a.exe", "MZ", "application/x-msdownload"), bytesItem("b.exe", "MZ", "application/x-msdownload")] }),
        fakes.ports,
      ));
      expect(error.statusCode).toBe(415);
      expect(error.issues?.map((issue) => issue.path)).toEqual(["a.exe", "b.exe"]);
      expect(fakes.createdWorkspaces).toEqual([]);
      expect(fakes.runs).toEqual([]);
    });

    it("fails with 422 when every file is rejected for different reasons", async () => {
      (env as { maxUploadBytes: number }).maxUploadBytes = 4;
      const fakes = createWorkspaceIntakeFakes();
      const error = await rejection(intakeIntoWorkspace(
        request({ items: [bytesItem("a.exe", "MZ", "application/x-msdownload"), bytesItem("big.txt", "123456")] }),
        fakes.ports,
      ));
      expect(error.statusCode).toBe(422);
    });

    it("names the unreadable files together with the ones screened out earlier when nothing is accepted", async () => {
      const fakes = createWorkspaceIntakeFakes();
      fakes.state.unreadable.add("a.pdf").add("b.pdf");
      const error = await rejection(intakeIntoWorkspace(
        request({ items: [bytesItem("payload.exe", "MZ", "application/x-msdownload"), bytesItem("a.pdf", "%PDF", "application/pdf"), bytesItem("b.pdf", "%PDF", "application/pdf")] }),
        fakes.ports,
      ));
      expect(error.statusCode).toBe(422);
      expect(error.issues?.map((issue) => [issue.path, issue.code])).toEqual([
        ["payload.exe", "unsupported_type"], ["a.pdf", "unreadable_source"], ["b.pdf", "unreadable_source"],
      ]);
      expect(fakes.objects.size).toBe(0);
    });

    it("removes the workspace it created when no document survives, but never an existing one", async () => {
      const fresh = createWorkspaceIntakeFakes();
      fresh.state.unreadable.add("broken.pdf");
      await rejection(intakeIntoWorkspace(request({ items: [bytesItem("broken.pdf", "%PDF", "application/pdf")] }), fresh.ports));
      expect(fresh.createdWorkspaces).toHaveLength(1);
      expect(fresh.discardedWorkspaces).toEqual(["ws-1"]);

      const existing = createWorkspaceIntakeFakes({ workspaces: [fakeWorkspace({ id: "ws-existing", orgId: "org-1" })] });
      existing.state.unreadable.add("broken.pdf");
      await rejection(intakeIntoWorkspace(request({ workspaceId: "ws-existing", newWorkspace: undefined, items: [bytesItem("broken.pdf", "%PDF", "application/pdf")] }), existing.ports));
      expect(existing.discardedWorkspaces).toEqual([]);
    });

    it("never fails the whole request over one bad file, whatever the intake kind", async () => {
      for (const kind of ["direct-upload", "url-ingest", "bulk-upload", "ai-automation"] as const) {
        const fakes = createWorkspaceIntakeFakes();
        fakes.state.unreadable.add("broken.pdf");
        const result = await intakeIntoWorkspace(
          request({ kind, items: [bytesItem("ok.txt"), bytesItem("payload.exe", "MZ", "application/x-msdownload"), bytesItem("broken.pdf", "%PDF", "application/pdf")] }),
          fakes.ports,
        );
        expect(result?.documents.map((document) => document.filename), kind).toEqual(["ok.txt"]);
        expect(result?.rejected.map((file) => file.code), kind).toEqual(["unsupported_type", "unreadable_source"]);
      }
    });

    it("reports a source its adapter could not produce, and keeps the rest", async () => {
      const fakes = createWorkspaceIntakeFakes();
      const result = await intakeIntoWorkspace(
        request({
          items: [
            { filename: "https://example.com/gone.pdf", content: { rejected: new WorkspaceIntakeError("Failed to fetch https://example.com/gone.pdf: 404", 400) } },
            bytesItem("ok.txt"),
          ],
        }),
        fakes.ports,
      );
      expect(result?.documents.map((document) => document.filename)).toEqual(["ok.txt"]);
      expect(result?.rejected).toEqual([
        { filename: "https://example.com/gone.pdf", statusCode: 400, code: "rejected", message: "Failed to fetch https://example.com/gone.pdf: 404" },
      ]);
    });
  });

  it("rejects oversized files with 413, including streams that outgrow the cap", async () => {
    (env as { maxUploadBytes: number }).maxUploadBytes = 4;
    const fakes = createWorkspaceIntakeFakes();

    const declared = await rejection(intakeIntoWorkspace(request({ items: [bytesItem("big.txt", "12345")] }), fakes.ports));
    expect(declared.statusCode).toBe(413);

    const streamed = await rejection(
      intakeIntoWorkspace(
        request({
          items: [{ filename: "big.txt", mimeType: "text/plain", content: { stream: Readable.from([Buffer.from("123"), Buffer.from("456")]) } }],
        }),
        fakes.ports,
      ),
    );
    expect(streamed).toMatchObject({ statusCode: 413, message: expect.stringContaining("MAX_UPLOAD_BYTES") });
    expect(fakes.objects.size).toBe(0);
  });

  it("sanitizes filenames before they reach the storage key", async () => {
    const fakes = createWorkspaceIntakeFakes();
    await intakeIntoWorkspace(request({ items: [bytesItem("../../secret<1>.txt")] }), fakes.ports);
    const [file] = fakes.runs[0].files;
    expect(file.filename).toBe("secret-1-.txt");
    expect(file.sourceKey).toMatch(/\/raw\/[0-9a-f-]+-secret-1-\.txt$/);
  });

  it("removes stored objects when run creation is blocked", async () => {
    const fakes = createWorkspaceIntakeFakes();
    fakes.state.blockRunCreation = new Error("Credit balance exhausted");
    await expect(intakeIntoWorkspace(request(), fakes.ports)).rejects.toThrow("Credit balance exhausted");
    expect(fakes.objects.size).toBe(0);
    expect(fakes.started).toEqual([]);
  });

  it("keeps the run and reports a deferral when processing cannot start", async () => {
    const fakes = createWorkspaceIntakeFakes();
    fakes.state.temporalDown = true;
    const result = await intakeIntoWorkspace(request(), fakes.ports);
    expect(result?.deferredReason).toContain("Temporal is currently unavailable");
    expect(fakes.runs).toHaveLength(1);
    expect(fakes.objects.size).toBe(1);
    expect(fakes.audit).toHaveLength(1);
  });

  it("retries the upload audit once and never fails a committed upload over it", async () => {
    const retried = createWorkspaceIntakeFakes();
    retried.state.auditFailures = 1;
    expect((await intakeIntoWorkspace(request(), retried.ports))?.run.id).toBe("run-1");
    expect(retried.audit).toHaveLength(1);

    const lost = createWorkspaceIntakeFakes();
    lost.state.auditFailures = 2;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await intakeIntoWorkspace(request(), lost.ports);
      expect(result?.deferredReason).toBeNull();
      expect(lost.started).toEqual(["run-1"]);
      expect(lost.audit).toHaveLength(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("documents.uploaded for run=run-1"), expect.anything(), expect.anything());
    } finally { error.mockRestore(); }
  });

  it("reuses keys of already-stored objects and never deletes them on failure", async () => {
    const fakes = createWorkspaceIntakeFakes();
    const stored: WorkspaceIntakeItem = {
      filename: "contracts.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      content: { storedKey: "user-1/session/raw/contracts.pdf" },
    };
    const result = await intakeIntoWorkspace(request({ kind: "direct-upload", items: [stored] }), fakes.ports);
    expect(fakes.runs[0].files[0].sourceKey).toBe("user-1/session/raw/contracts.pdf");
    expect(result?.workspace.name).toBe("Contracts");

    const removed = vi.spyOn(fakes.ports.storage, "remove");
    fakes.state.blockRunCreation = new Error("blocked");
    await expect(intakeIntoWorkspace(request({ kind: "direct-upload", items: [stored] }), fakes.ports)).rejects.toThrow("blocked");
    expect(removed).not.toHaveBeenCalled();
  });

  it("returns null for a skipping source that yields nothing, and rejects empty sources otherwise", async () => {
    const fakes = createWorkspaceIntakeFakes({ workspaces: [fakeWorkspace()] });
    await expect(
      intakeIntoWorkspace(request({ workspaceId: "ws-existing", kind: "connector-sync", items: [], mayBeEmpty: true }), fakes.ports),
    ).resolves.toBeNull();
    expect((await rejection(intakeIntoWorkspace(request({ items: [] }), fakes.ports))).statusCode).toBe(400);
    expect(fakes.runs).toEqual([]);
  });

  it("carries connector metadata and api key attribution onto the run", async () => {
    const fakes = createWorkspaceIntakeFakes({ workspaces: [fakeWorkspace()] });
    await intakeIntoWorkspace(
      request({
        workspaceId: "ws-existing",
        kind: "connector-sync",
        apiKeyId: "key-1",
        items: [{ ...bytesItem("report.txt"), metadata: { connectorId: "conn-1" } }],
      }),
      fakes.ports,
    );
    expect(fakes.runs[0]).toMatchObject({ apiKeyId: "key-1", files: [expect.objectContaining({ metadata: { connectorId: "conn-1" } })] });
    expect(fakes.audit[0]).toMatchObject({ apiKeyId: "key-1", metadata: { mode: "connector-sync" } });
  });

  it("blocks complex formats from remote sources unless enabled, but not from direct uploads", async () => {
    const fakes = createWorkspaceIntakeFakes();
    const docx = bytesItem("report.docx", "PK", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const blocked = await rejection(intakeIntoWorkspace(request({ kind: "connector-sync", items: [docx] }), fakes.ports));
    expect(blocked).toMatchObject({ statusCode: 415, message: expect.stringContaining("REMOTE_INGEST_COMPLEX_FORMATS_ENABLED=true") });

    await expect(intakeIntoWorkspace(request({ kind: "bulk-upload", items: [docx] }), fakes.ports)).resolves.not.toBeNull();
    (env as { remoteIngestComplexFormatsEnabled: boolean }).remoteIngestComplexFormatsEnabled = true;
    await expect(intakeIntoWorkspace(request({ kind: "connector-sync", items: [docx] }), fakes.ports)).resolves.not.toBeNull();
  });
});

describe("Workspace Intake from remote URLs", () => {
  it("streams fetched bodies into storage, titles from the URL, and audits only origins", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hello from upstream", {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": "19" },
    })));
    const fakes = createWorkspaceIntakeFakes();
    const urls = ["https://docs.example.com/reports/q1-pipeline.txt?token=secret"];

    await intakeIntoWorkspace(request({ kind: "url-ingest", items: remoteUrlIntakeItems(urls), urls }), fakes.ports);

    const [file] = fakes.runs[0].files;
    expect(file).toMatchObject({ filename: "q1-pipeline.txt", mimeType: "text/plain" });
    expect(fakes.objects.get(file.sourceKey)).toMatchObject({ via: "stream", body: Buffer.from("hello from upstream") });
    expect(fakes.createdWorkspaces[0].name).toBe("Q1 pipeline");
    expect(fakes.audit[0].metadata).toMatchObject({ mode: "url-ingest", urlCount: 1, urlOrigins: ["https://docs.example.com"] });
    expect(JSON.stringify(fakes.audit)).not.toContain("secret");
  });

  it("buffers when the response has no body stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain", "content-length": "5" }),
      body: null,
      arrayBuffer: async () => Uint8Array.from([104, 101, 108, 108, 111]).buffer,
    })));
    const fakes = createWorkspaceIntakeFakes();
    const urls = ["https://example.com/notes.txt"];
    await intakeIntoWorkspace(request({ kind: "url-ingest", items: remoteUrlIntakeItems(urls), urls }), fakes.ports);
    expect([...fakes.objects.values()]).toEqual([expect.objectContaining({ via: "bytes", body: Buffer.from("hello") })]);
  });

  it("cancels rejected responses without storing anything", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 404 })));
    const fakes = createWorkspaceIntakeFakes();
    const urls = ["https://example.com/file.txt"];
    const error = await rejection(intakeIntoWorkspace(request({ kind: "url-ingest", items: remoteUrlIntakeItems(urls), urls }), fakes.ports));
    expect(error).toMatchObject({ statusCode: 400, message: expect.stringContaining("404") });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fakes.objects.size).toBe(0);
  });

  it("ingests the reachable URLs when another one fails to fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("missing")
      ? new Response("nope", { status: 404 })
      : new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })));
    const fakes = createWorkspaceIntakeFakes();
    const urls = ["https://example.com/missing.txt", "https://example.com/found.txt"];
    const result = await intakeIntoWorkspace(request({ kind: "url-ingest", items: remoteUrlIntakeItems(urls), urls }), fakes.ports);
    expect(result?.documents.map((document) => document.filename)).toEqual(["found.txt"]);
    expect(result?.rejected).toEqual([
      expect.objectContaining({ filename: "https://example.com/missing.txt", statusCode: 400, message: expect.stringContaining("404") }),
    ]);
  });

  it("surfaces upstream stream failures as a 400 instead of hanging storage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      new ReadableStream({ start(controller) { controller.error(new Error("upstream failed")); } }),
      { headers: { "content-type": "text/plain" } },
    )));
    const fakes = createWorkspaceIntakeFakes();
    const urls = ["https://example.com/file.txt"];
    const error = await rejection(intakeIntoWorkspace(request({ kind: "url-ingest", items: remoteUrlIntakeItems(urls), urls }), fakes.ports));
    expect(error).toMatchObject({ statusCode: 400, message: "upstream failed" });
    expect(fakes.objects.size).toBe(0);
  });
});
