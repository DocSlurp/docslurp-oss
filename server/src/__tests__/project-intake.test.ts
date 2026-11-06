import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures, getProjectTemplate, normalizePipelineFeatures } from "@docslurp/shared";

import { env } from "../config.js";
import {
  intakeIntoProject,
  screenIntakeFile,
  ProjectIntakeError,
  type ProjectIntakeItem,
  type ProjectIntakeRequest,
} from "../services/project-intake.js";
import { remoteUrlIntakeItems } from "../services/remote-ingest.js";
import { ProjectAccessError } from "../services/default-project.js";
import { createProjectIntakeFakes, fakeProject } from "./helpers/project-intake-fakes.js";
import { configureApiExtractorIdAliases } from "../routes/extractors.js";

// URL safety checks resolve hosts; keep them independent of live DNS.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

// safeExternalFetch sends through undici's own fetch; route it to the global
// that each test stubs.
vi.mock("undici", async (importOriginal) => ({
  ...await importOriginal<typeof import("undici")>(),
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

function bytesItem(filename: string, body = "hello", mimeType = "text/plain"): ProjectIntakeItem {
  return { filename, mimeType, content: { bytes: Buffer.from(body) } };
}

function request(overrides: Partial<ProjectIntakeRequest> = {}): ProjectIntakeRequest {
  return {
    userId: "user-1",
    orgId: "org-1",
    project: null,
    newProject: true,
    kind: "bulk-upload",
    items: [bytesItem("contracts.txt")],
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<ProjectIntakeError> {
  const error = await promise.then(
    () => {
      throw new Error("expected intake to reject");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProjectIntakeError);
  return error as ProjectIntakeError;
}

const originalMaxUploadBytes = env.maxUploadBytes;
const originalComplexFormats = env.remoteIngestComplexFormatsEnabled;

afterEach(() => {
  (env as { maxUploadBytes: number }).maxUploadBytes = originalMaxUploadBytes;
  (env as { remoteIngestComplexFormatsEnabled: boolean }).remoteIngestComplexFormatsEnabled = originalComplexFormats;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Project Intake", () => {
  it("stores uploaded bytes, self-titles a new project, creates the run, starts it, and audits", async () => {
    const fakes = createProjectIntakeFakes();
    const result = await intakeIntoProject(
      request({
        items: [
          bytesItem("master_service_agreement_v2.pdf", "%PDF", "application/pdf"),
          bytesItem("notes.md", "# hi", "application/octet-stream"),
        ],
        audit: { ipAddress: "127.0.0.1", userAgent: "vitest" },
      }),
      fakes.ports,
    );

    expect(fakes.createdProjects).toEqual([
      expect.objectContaining({ name: "Master service agreement v2 + 1 more", orgId: "org-1", autoNamed: true }),
    ]);
    const [run] = fakes.runs;
    expect(run).toMatchObject({ projectId: result?.project.id, kind: "bulk-upload", pipeline: defaultPipelineFeatures });
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
    const fakes = createProjectIntakeFakes();
    await intakeIntoProject(request({ items: [{
      filename: "stream.txt", mimeType: "text/plain", sizeBytes: 900,
      content: { stream: Readable.from([Buffer.from("hé"), Buffer.from("llo")]), contentLength: 1 },
    }] }), fakes.ports);
    expect(fakes.runs[0].files[0].fileSize).toBe(Buffer.byteLength("héllo"));
    expect(fakes.objects.get(fakes.runs[0].files[0].sourceKey)?.body.toString()).toBe("héllo");
  });

  it("keeps already-stored source byte counts unknown instead of trusting declarations", async () => {
    const fakes = createProjectIntakeFakes();
    await intakeIntoProject(request({ items: [{ filename: "stored.txt", sizeBytes: 900, content: { storedKey: "existing/raw.txt" } }] }), fakes.ports);
    expect(fakes.runs[0].files[0].fileSize).toBeUndefined();
  });

  it("files untargeted uploads into the organization's default project", async () => {
    const fakes = createProjectIntakeFakes();
    const first = await intakeIntoProject(request({ newProject: undefined }), fakes.ports);
    const second = await intakeIntoProject(request({ newProject: undefined }), fakes.ports);

    expect(fakes.createdProjects).toEqual([]);
    expect(first?.project).toMatchObject({ id: "ws-default-org-1", isDefault: true });
    expect(second?.project.id).toBe("ws-default-org-1");
    expect(fakes.runs.map((run) => run.projectId)).toEqual(["ws-default-org-1", "ws-default-org-1"]);
  });

  it("treats the reserved \"default\" project ID as the organization's default project", async () => {
    const fakes = createProjectIntakeFakes();
    const result = await intakeIntoProject(request({ project: "default", newProject: true }), fakes.ports);
    expect(result?.project.id).toBe("ws-default-org-1");
    expect(fakes.createdProjects).toEqual([]);
  });

  it("creates a project when a name or template is given without an explicit flag", async () => {
    const fakes = createProjectIntakeFakes();
    await intakeIntoProject(request({ newProject: undefined, project: "Contracts" }), fakes.ports);
    await intakeIntoProject(request({ newProject: undefined, templateKey: "engineering-docs" }), fakes.ports);
    expect(fakes.createdProjects.map((project) => project.name)).toEqual(["Contracts", "Contracts"]);
  });

  it("keeps a caller-chosen project name instead of self-titling", async () => {
    const fakes = createProjectIntakeFakes();
    await intakeIntoProject(request({ project: "  Legal Contracts " }), fakes.ports);
    expect(fakes.createdProjects).toEqual([expect.objectContaining({ name: "Legal Contracts", slug: "legal-contracts", autoNamed: false })]);
  });

  it("self-titles a new project when the upload names it with the untitled placeholder", async () => {
    const fakes = createProjectIntakeFakes();
    await intakeIntoProject(request({ project: "Untitled project", items: [bytesItem("lease_2026.txt")] }), fakes.ports);
    expect(fakes.createdProjects).toEqual([expect.objectContaining({ name: "Lease 2026", autoNamed: true })]);
  });

  it("re-titles an existing project from the upload batch but not one it just created", async () => {
    const fakes = createProjectIntakeFakes({ projects: [fakeProject({ id: "ws-untitled", name: "Untitled project", slug: "untitled-project" })] });
    const nameFromUpload = vi.fn(async () => "Lease 2026 + 1 more");
    fakes.ports.records.nameFromUpload = nameFromUpload;
    const appended = await intakeIntoProject(
      request({ project: "untitled-project", newProject: undefined, items: [bytesItem("lease_2026.txt"), bytesItem("rider.txt")] }),
      fakes.ports,
    );
    expect(nameFromUpload).toHaveBeenCalledExactlyOnceWith({ projectId: "ws-untitled", filenames: ["lease_2026.txt", "rider.txt"] });
    expect(appended?.project.name).toBe("Lease 2026 + 1 more");

    nameFromUpload.mockClear();
    await intakeIntoProject(request(), fakes.ports);
    expect(nameFromUpload).not.toHaveBeenCalled();
  });

  it("keeps a committed upload when re-titling fails", async () => {
    const fakes = createProjectIntakeFakes({ projects: [fakeProject({ id: "ws-untitled", name: "Untitled project", slug: "untitled-project" })] });
    fakes.ports.records.nameFromUpload = vi.fn(async () => { throw new Error("db down"); });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await intakeIntoProject(request({ project: "untitled-project", newProject: undefined }), fakes.ports);
    expect(result?.project.name).toBe("Untitled project");
    expect(result?.run).toBeTruthy();
    errors.mockRestore();
  });

  it("appends to the project a name, slug or differently formatted name matches instead of creating another", async () => {
    const fakes = createProjectIntakeFakes();
    const created = await intakeIntoProject(request({ project: "Legal Contracts" }), fakes.ports);
    for (const project of ["legal-contracts", "  Légal—Contracts!! ", "LEGAL CONTRACTS"]) {
      const result = await intakeIntoProject(request({ project, newProject: undefined }), fakes.ports);
      expect(result?.project.id).toBe(created?.project.id);
    }
    expect(fakes.createdProjects).toHaveLength(1);
  });

  it("ignores newProject when an explicit project is named", async () => {
    const fakes = createProjectIntakeFakes({ projects: [fakeProject({ id: "ws-legal", name: "Legal Contracts", slug: "legal-contracts" })] });
    const result = await intakeIntoProject(request({ project: "Legal Contracts", newProject: true }), fakes.ports);
    expect(result?.project.id).toBe("ws-legal");
    expect(fakes.createdProjects).toEqual([]);
  });

  it("rejects a project value with no letters or digits with 400", async () => {
    const fakes = createProjectIntakeFakes();
    const error = await rejection(intakeIntoProject(request({ project: "!!!" }), fakes.ports));
    expect(error.statusCode).toBe(400);
    expect(fakes.createdProjects).toEqual([]);
  });

  it("never lets a project-restricted API key create a project or reach one outside its allowlist", async () => {
    const fakes = createProjectIntakeFakes({ projects: [
      fakeProject({ id: "ws-allowed", name: "Allowed", slug: "allowed" }),
      fakeProject({ id: "ws-hidden", name: "Hidden", slug: "hidden" }),
    ] });
    const restricted = { allowedProjectIds: ["ws-allowed"], newProject: undefined };
    expect((await intakeIntoProject(request({ ...restricted, project: "Allowed" }), fakes.ports))?.project.id).toBe("ws-allowed");
    for (const target of [{ project: "Hidden" }, { project: "Brand New" }, { newProject: true }]) {
      const error = await rejection(intakeIntoProject(request({ ...restricted, ...target }), fakes.ports));
      expect(error.statusCode).toBe(403);
    }
    expect(fakes.createdProjects).toEqual([]);
  });

  it("appends to an existing project and inherits its pipeline", async () => {
    const pipeline = { ...defaultPipelineFeatures, embed: false, indexVectors: false };
    const fakes = createProjectIntakeFakes({ projects: [fakeProject({ id: "ws-existing", pipeline })] });
    const result = await intakeIntoProject(request({ project: "ws-existing" }), fakes.ports);

    expect(fakes.createdProjects).toEqual([]);
    expect(result?.project.id).toBe("ws-existing");
    expect(fakes.runs[0]).toMatchObject({ projectId: "ws-existing", pipeline });
  });

  it("merges per-upload pipeline overrides onto the project pipeline", async () => {
    const pipeline = normalizePipelineFeatures({ summarize: true, graph: { domain: "Supplier contracts", depth: "deep" } });
    const fakes = createProjectIntakeFakes({ projects: [fakeProject({ id: "ws-existing", pipeline })] });
    await intakeIntoProject(
      request({ project: "ws-existing", pipeline: { pageIndex: true, graph: { depth: "lean" } } }),
      fakes.ports,
    );

    const run = fakes.runs[0].pipeline;
    expect(run.summarize).toBe(true); // kept from the project, not reset to the default
    expect(run.pageIndex).toBe(true); // the override
    expect(run.graph).toMatchObject({ domain: "Supplier contracts", depth: "lean" });
  });

  it("keeps template-locked settings when an upload tries to override them", async () => {
    const template = getProjectTemplate("legal-contracts")!;
    const fakes = createProjectIntakeFakes({
      projects: [fakeProject({ id: "ws-legal", templateKey: "legal-contracts", pipeline: template.pipeline })],
    });
    await intakeIntoProject(
      request({
        project: "ws-legal",
        pipeline: { summarize: !template.pipeline.summarize, piiPolicy: { enabled: false }, quality: "fast", chunkOverlap: true },
      }),
      fakes.ports,
    );

    const run = fakes.runs[0].pipeline;
    expect(run.summarize).toBe(template.pipeline.summarize);
    expect(run.piiPolicy.enabled).toBe(true);
    expect(run.quality).toBe("auto"); // the template locks auto; the upload asked for fast
    expect(run.chunkOverlap).toBe(true); // not locked, so the override applies
  });

  it("rejects an unknown target project before reading any source item", async () => {
    const fakes = createProjectIntakeFakes();
    const read = vi.fn();
    async function* items(): AsyncGenerator<ProjectIntakeItem> {
      read();
      yield bytesItem("a.txt");
    }

    const error = await intakeIntoProject(request({ project: "00000000-0000-4000-8000-00000000dead", items: items() }), fakes.ports).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProjectAccessError);
    expect((error as ProjectAccessError).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    expect(fakes.objects.size).toBe(0);
  });

  it("refuses a project from another organization", async () => {
    const otherId = "00000000-0000-4000-8000-0000000000b2";
    const fakes = createProjectIntakeFakes({ projects: [fakeProject({ id: otherId, orgId: "org-2", name: "Other", slug: "other" })] });
    const error = await intakeIntoProject(request({ project: otherId }), fakes.ports).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ status: 404, code: "project_not_found" });
    // A name from another organization is not a match: the upload gets its own project in this one.
    const result = await intakeIntoProject(request({ project: "Other" }), fakes.ports);
    expect(result?.project).toMatchObject({ orgId: "org-1", name: "Other" });
    expect(fakes.runs.map((run) => run.projectId)).toEqual([result?.project.id]);
  });

  it("rejects a lone unsupported file with 415 and creates nothing", async () => {
    const fakes = createProjectIntakeFakes();
    const error = await rejection(
      intakeIntoProject(
        request({ items: [bytesItem("payload.exe", "MZ", "application/x-msdownload")] }),
        fakes.ports,
      ),
    );
    expect(error).toMatchObject({ statusCode: 415, message: "Unsupported file type for payload.exe" });
    expect(fakes.objects.size).toBe(0);
    expect(fakes.createdProjects).toEqual([]);
  });

  describe("partial intake (every source)", () => {
    it("takes the valid files and reports unsupported, oversized and unreadable ones", async () => {
      (env as { maxUploadBytes: number }).maxUploadBytes = 8;
      const fakes = createProjectIntakeFakes();
      fakes.state.unreadable.add("broken.pdf");
      const result = await intakeIntoProject(
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
      const fakes = createProjectIntakeFakes();
      const error = await rejection(intakeIntoProject(
        request({ items: [bytesItem("a.exe", "MZ", "application/x-msdownload"), bytesItem("b.exe", "MZ", "application/x-msdownload")] }),
        fakes.ports,
      ));
      expect(error.statusCode).toBe(415);
      expect(error.issues?.map((issue) => issue.path)).toEqual(["a.exe", "b.exe"]);
      expect(fakes.createdProjects).toEqual([]);
      expect(fakes.runs).toEqual([]);
    });

    it("fails with 422 when every file is rejected for different reasons", async () => {
      (env as { maxUploadBytes: number }).maxUploadBytes = 4;
      const fakes = createProjectIntakeFakes();
      const error = await rejection(intakeIntoProject(
        request({ items: [bytesItem("a.exe", "MZ", "application/x-msdownload"), bytesItem("big.txt", "123456")] }),
        fakes.ports,
      ));
      expect(error.statusCode).toBe(422);
    });

    it("names the unreadable files together with the ones screened out earlier when nothing is accepted", async () => {
      const fakes = createProjectIntakeFakes();
      fakes.state.unreadable.add("a.pdf").add("b.pdf");
      const error = await rejection(intakeIntoProject(
        request({ items: [bytesItem("payload.exe", "MZ", "application/x-msdownload"), bytesItem("a.pdf", "%PDF", "application/pdf"), bytesItem("b.pdf", "%PDF", "application/pdf")] }),
        fakes.ports,
      ));
      expect(error.statusCode).toBe(422);
      expect(error.issues?.map((issue) => [issue.path, issue.code])).toEqual([
        ["payload.exe", "unsupported_type"], ["a.pdf", "unreadable_source"], ["b.pdf", "unreadable_source"],
      ]);
      expect(fakes.objects.size).toBe(0);
    });

    it("removes the project it created when no document survives, but never an existing one", async () => {
      const fresh = createProjectIntakeFakes();
      fresh.state.unreadable.add("broken.pdf");
      await rejection(intakeIntoProject(request({ items: [bytesItem("broken.pdf", "%PDF", "application/pdf")] }), fresh.ports));
      expect(fresh.createdProjects).toHaveLength(1);
      expect(fresh.discardedProjects).toEqual(["ws-1"]);

      const existing = createProjectIntakeFakes({ projects: [fakeProject({ id: "ws-existing", orgId: "org-1" })] });
      existing.state.unreadable.add("broken.pdf");
      await rejection(intakeIntoProject(request({ project: "ws-existing", newProject: undefined, items: [bytesItem("broken.pdf", "%PDF", "application/pdf")] }), existing.ports));
      expect(existing.discardedProjects).toEqual([]);
    });

    it("never fails the whole request over one bad file, whatever the intake kind", async () => {
      for (const kind of ["direct-upload", "url-ingest", "bulk-upload", "connector-sync"] as const) {
        const fakes = createProjectIntakeFakes();
        fakes.state.unreadable.add("broken.pdf");
        const result = await intakeIntoProject(
          request({ kind, items: [bytesItem("ok.txt"), bytesItem("payload.exe", "MZ", "application/x-msdownload"), bytesItem("broken.pdf", "%PDF", "application/pdf")] }),
          fakes.ports,
        );
        expect(result?.documents.map((document) => document.filename), kind).toEqual(["ok.txt"]);
        expect(result?.rejected.map((file) => file.code), kind).toEqual(["unsupported_type", "unreadable_source"]);
      }
    });

    it("reports a source its adapter could not produce, and keeps the rest", async () => {
      const fakes = createProjectIntakeFakes();
      const result = await intakeIntoProject(
        request({
          items: [
            { filename: "https://example.com/gone.pdf", content: { rejected: new ProjectIntakeError("Failed to fetch https://example.com/gone.pdf: 404", 400) } },
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
    const fakes = createProjectIntakeFakes();

    const declared = await rejection(intakeIntoProject(request({ items: [bytesItem("big.txt", "12345")] }), fakes.ports));
    expect(declared.statusCode).toBe(413);

    const streamed = await rejection(
      intakeIntoProject(
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
    const fakes = createProjectIntakeFakes();
    await intakeIntoProject(request({ items: [bytesItem("../../secret<1>.txt")] }), fakes.ports);
    const [file] = fakes.runs[0].files;
    expect(file.filename).toBe("secret-1-.txt");
    expect(file.sourceKey).toMatch(/\/raw\/[0-9a-f-]+-secret-1-\.txt$/);
  });

  it("removes stored objects when run creation is blocked", async () => {
    const fakes = createProjectIntakeFakes();
    fakes.state.blockRunCreation = new Error("Credit balance exhausted");
    await expect(intakeIntoProject(request(), fakes.ports)).rejects.toThrow("Credit balance exhausted");
    expect(fakes.objects.size).toBe(0);
    expect(fakes.started).toEqual([]);
  });

  it("keeps the run and reports a deferral when processing cannot start", async () => {
    const fakes = createProjectIntakeFakes();
    fakes.state.temporalDown = true;
    const result = await intakeIntoProject(request(), fakes.ports);
    expect(result?.deferredReason).toContain("Temporal is currently unavailable");
    expect(fakes.runs).toHaveLength(1);
    expect(fakes.objects.size).toBe(1);
    expect(fakes.audit).toHaveLength(1);
  });

  it("retries the upload audit once and never fails a committed upload over it", async () => {
    const retried = createProjectIntakeFakes();
    retried.state.auditFailures = 1;
    expect((await intakeIntoProject(request(), retried.ports))?.run.id).toBe("run-1");
    expect(retried.audit).toHaveLength(1);

    const lost = createProjectIntakeFakes();
    lost.state.auditFailures = 2;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await intakeIntoProject(request(), lost.ports);
      expect(result?.deferredReason).toBeNull();
      expect(lost.started).toEqual(["run-1"]);
      expect(lost.audit).toHaveLength(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("documents.uploaded for run=run-1"), expect.anything(), expect.anything());
    } finally { error.mockRestore(); }
  });

  it("reuses keys of already-stored objects and never deletes them on failure", async () => {
    const fakes = createProjectIntakeFakes();
    const stored: ProjectIntakeItem = {
      filename: "contracts.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      content: { storedKey: "user-1/session/raw/contracts.pdf" },
    };
    const result = await intakeIntoProject(request({ kind: "direct-upload", items: [stored] }), fakes.ports);
    expect(fakes.runs[0].files[0].sourceKey).toBe("user-1/session/raw/contracts.pdf");
    expect(result?.project.name).toBe("Contracts");

    const removed = vi.spyOn(fakes.ports.storage, "remove");
    fakes.state.blockRunCreation = new Error("blocked");
    await expect(intakeIntoProject(request({ kind: "direct-upload", items: [stored] }), fakes.ports)).rejects.toThrow("blocked");
    expect(removed).not.toHaveBeenCalled();
  });

  it("returns null for a skipping source that yields nothing, and rejects empty sources otherwise", async () => {
    const fakes = createProjectIntakeFakes({ projects: [fakeProject()] });
    await expect(
      intakeIntoProject(request({ project: "ws-existing", kind: "connector-sync", items: [], mayBeEmpty: true }), fakes.ports),
    ).resolves.toBeNull();
    expect((await rejection(intakeIntoProject(request({ items: [] }), fakes.ports))).statusCode).toBe(400);
    expect(fakes.runs).toEqual([]);
  });

  it("carries connector metadata and api key attribution onto the run", async () => {
    const fakes = createProjectIntakeFakes({ projects: [fakeProject()] });
    await intakeIntoProject(
      request({
        project: "ws-existing",
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
    const fakes = createProjectIntakeFakes();
    const docx = bytesItem("report.docx", "PK", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const blocked = await rejection(intakeIntoProject(request({ kind: "connector-sync", items: [docx] }), fakes.ports));
    expect(blocked).toMatchObject({ statusCode: 415, message: expect.stringContaining("REMOTE_INGEST_COMPLEX_FORMATS_ENABLED=true") });

    await expect(intakeIntoProject(request({ kind: "bulk-upload", items: [docx] }), fakes.ports)).resolves.not.toBeNull();
    (env as { remoteIngestComplexFormatsEnabled: boolean }).remoteIngestComplexFormatsEnabled = true;
    await expect(intakeIntoProject(request({ kind: "connector-sync", items: [docx] }), fakes.ports)).resolves.not.toBeNull();
  });
});

describe("Project Intake from remote URLs", () => {
  it.each(["gzip", "br", "deflate"])("does not forward the encoded length of a %s response to storage", async (encoding) => {
    const decoded = "Decoded source text ".repeat(30);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(decoded, {
      headers: { "content-type": "text/plain", "content-encoding": encoding, "content-length": "42" },
    })));
    const fakes = createProjectIntakeFakes();
    const put = vi.spyOn(fakes.ports.storage, "put");
    const urls = ["https://example.com/notes.txt"];
    await intakeIntoProject(request({ kind: "url-ingest", items: remoteUrlIntakeItems(urls), urls }), fakes.ports);
    expect(put.mock.calls[0]![1]).toMatchObject({ contentLength: undefined });
    const [file] = fakes.runs[0].files;
    expect(fakes.objects.get(file.sourceKey)?.body).toEqual(Buffer.from(decoded));
    expect(file.fileSize).toBe(Buffer.byteLength(decoded));
  });

  it("streams fetched bodies into storage, titles from the URL, and audits only origins", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hello from upstream", {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": "19" },
    })));
    const fakes = createProjectIntakeFakes();
    const urls = ["https://docs.example.com/reports/q1-pipeline.txt?token=secret"];

    await intakeIntoProject(request({ kind: "url-ingest", items: remoteUrlIntakeItems(urls), urls }), fakes.ports);

    const [file] = fakes.runs[0].files;
    expect(file).toMatchObject({ filename: "q1-pipeline.txt", mimeType: "text/plain" });
    expect(fakes.objects.get(file.sourceKey)).toMatchObject({ via: "stream", body: Buffer.from("hello from upstream") });
    expect(fakes.createdProjects[0].name).toBe("Q1 pipeline");
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
    const fakes = createProjectIntakeFakes();
    const urls = ["https://example.com/notes.txt"];
    await intakeIntoProject(request({ kind: "url-ingest", items: remoteUrlIntakeItems(urls), urls }), fakes.ports);
    expect([...fakes.objects.values()]).toEqual([expect.objectContaining({ via: "bytes", body: Buffer.from("hello") })]);
  });

  it("cancels rejected responses without storing anything", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 404 })));
    const fakes = createProjectIntakeFakes();
    const urls = ["https://example.com/file.txt"];
    const error = await rejection(intakeIntoProject(request({ kind: "url-ingest", items: remoteUrlIntakeItems(urls), urls }), fakes.ports));
    expect(error).toMatchObject({ statusCode: 400, message: expect.stringContaining("404") });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fakes.objects.size).toBe(0);
  });

  it("ingests the reachable URLs when another one fails to fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("missing")
      ? new Response("nope", { status: 404 })
      : new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })));
    const fakes = createProjectIntakeFakes();
    const urls = ["https://example.com/missing.txt", "https://example.com/found.txt"];
    const result = await intakeIntoProject(request({ kind: "url-ingest", items: remoteUrlIntakeItems(urls), urls }), fakes.ports);
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
    const fakes = createProjectIntakeFakes();
    const urls = ["https://example.com/file.txt"];
    const error = await rejection(intakeIntoProject(request({ kind: "url-ingest", items: remoteUrlIntakeItems(urls), urls }), fakes.ports));
    expect(error).toMatchObject({ statusCode: 400, message: "upstream failed" });
    expect(fakes.objects.size).toBe(0);
  });
});


describe("VM PDF admission contract", () => {
  it("admits the large PDFs supported by the chunked VM route and refuses excess before storage", () => {
    vi.stubEnv("DOCSLURP_VM_PDF_INSTALLED", "1");
    (env as { maxUploadBytes: number }).maxUploadBytes = 1024 * 1024 * 1024;
    for (const mib of [64, 65, 80, 500]) {
      expect(screenIntakeFile({ filename: "document.pdf", sizeBytes: mib * 1024 * 1024 }, "bulk-upload").ok).toBe(true);
    }
    expect(screenIntakeFile({ filename: "document.pdf", sizeBytes: 500 * 1024 * 1024 + 1 }, "bulk-upload"))
      .toMatchObject({ ok: false, reason: "size", statusCode: 413 });
    expect(screenIntakeFile({ filename: "data.txt", sizeBytes: 600 * 1024 * 1024 }, "bulk-upload").ok).toBe(true);
  });
  it("keeps an operator's smaller limit", () => {
    vi.stubEnv("DOCSLURP_VM_PDF_INSTALLED", "1");
    (env as { maxUploadBytes: number }).maxUploadBytes = 10;
    expect(screenIntakeFile({ filename: "document.pdf", sizeBytes: 11 }, "bulk-upload"))
      .toMatchObject({ ok: false, statusCode: 413 });
  });
  it("keeps the sandboxed provider cap when only DOCSLURP_PDF_EXTRACTOR selects it, trimmed", () => {
    vi.stubEnv("DOCSLURP_VM_PDF_INSTALLED", "");
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", " vm-pdf ");
    (env as { maxUploadBytes: number }).maxUploadBytes = 1024 * 1024 * 1024;
    expect(screenIntakeFile({ filename: "document.pdf", sizeBytes: 500 * 1024 * 1024 + 1 }, "bulk-upload"))
      .toMatchObject({ ok: false, reason: "size", statusCode: 413 });
  });
  it("refuses an unknown DOCSLURP_PDF_EXTRACTOR instead of dropping the cap", () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm_pdf");
    (env as { maxUploadBytes: number }).maxUploadBytes = 1024 * 1024 * 1024;
    expect(() => screenIntakeFile({ filename: "document.pdf", sizeBytes: 600 * 1024 * 1024 }, "bulk-upload")).toThrow("DOCSLURP_PDF_EXTRACTOR");
    expect(() => configureApiExtractorIdAliases({ DOCSLURP_PDF_EXTRACTOR: "vm_pdf" })).toThrow("DOCSLURP_PDF_EXTRACTOR");
    expect(() => configureApiExtractorIdAliases({ DOCSLURP_PDF_EXTRACTOR: "vm-pdf" })).not.toThrow();
  });
});
