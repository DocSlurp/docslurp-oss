import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";

import { createUploadsRoutes } from "../routes/uploads.js";
import { RunCreationBlockedError } from "../services/runs.js";
import { withTestSession } from "./helpers/session-app.js";
import { createWorkspaceIntakeFakes, fakeWorkspace } from "./helpers/workspace-intake-fakes.js";

// URL safety checks resolve hosts; keep them independent of live DNS.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

function setup(workspaces = [fakeWorkspace({ id: "ws-1", orgId: "org-1" })]) {
  const fakes = createWorkspaceIntakeFakes({ workspaces });
  const app = withTestSession(new Hono(), { id: "user-1", email: "user-1@example.com", name: "User One" });
  app.route("/uploads", createUploadsRoutes(fakes.ports));
  return { app, fakes };
}

function bulk(files: File[], fields: Record<string, string> = {}): RequestInit {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  for (const file of files) form.append("files", file);
  return { method: "POST", body: form, headers: { "user-agent": "vitest" } };
}

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

const text = (name: string) => new File(["hello"], name, { type: "text/plain" });

afterEach(() => vi.unstubAllGlobals());

describe("uploadsRoutes over Workspace Intake", () => {
  it("files untargeted uploads into the organization's default workspace", async () => {
    const { app, fakes } = setup();
    const response = await app.request("/uploads/bulk", bulk([text("pricing.txt")], { orgId: "org-99" }));

    expect(response.status).toBe(201);
    expect(fakes.createdWorkspaces).toEqual([]);
    expect(fakes.runs[0].workspaceId).toBe("ws-default-org-99");
  });

  it("accepts the good files of a bulk upload and lists the rejected ones in the 201 body", async () => {
    const { app, fakes } = setup();
    fakes.state.unreadable.add("broken.pdf");
    const response = await app.request("/uploads/bulk", bulk([
      text("notes.txt"),
      new File(["MZ"], "payload.exe", { type: "application/x-msdownload" }),
      new File(["%PDF"], "broken.pdf", { type: "application/pdf" }),
    ]));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.documents.map((document: { filename: string }) => document.filename)).toEqual(["notes.txt"]);
    expect(body.rejected).toEqual([
      expect.objectContaining({ filename: "payload.exe", statusCode: 415, code: "unsupported_type" }),
      expect.objectContaining({ filename: "broken.pdf", statusCode: 422, code: "unreadable_source" }),
    ]);
    expect(body.warnings).toEqual(["2 of 3 files were not accepted: payload.exe, broken.pdf."]);
  });

  it("omits rejected when every file was taken, and fails the request when none was", async () => {
    const { app } = setup();
    expect((await (await app.request("/uploads/bulk", bulk([text("a.txt")]))).json()).rejected).toBeUndefined();

    const none = await app.request("/uploads/bulk", bulk([new File(["MZ"], "payload.exe", { type: "application/x-msdownload" })]));
    expect(none.status).toBe(415);
  });

  it("creates a self-titled workspace and returns the run handoff", async () => {
    const { app, fakes } = setup();
    const response = await app.request(
      "/uploads/bulk",
      bulk([new File(["%PDF"], "master_service_agreement_v2.pdf", { type: "application/pdf" }), text("pricing.txt")], { orgId: "org-99", newWorkspace: "true" }),
    );

    expect(response.status).toBe(201);
    expect(fakes.createdWorkspaces).toEqual([expect.objectContaining({ name: "Master service agreement v2 + 1 more", orgId: "org-99" })]);
    await expect(response.json()).resolves.toMatchObject({ run: { id: "run-1" }, documents: [{}, {}], warnings: [] });
    expect(fakes.audit[0].metadata).toMatchObject({ mode: "bulk-upload", userAgent: "vitest" });
  });

  it("appends to the targeted workspace with its pipeline when no override is sent", async () => {
    const pipeline = { ...defaultPipelineFeatures, embed: false, indexVectors: false };
    const { app, fakes } = setup([fakeWorkspace({ id: "ws-1", pipeline })]);
    const response = await app.request("/uploads/bulk", bulk([text("notes.txt")], { workspaceId: "ws-1" }));
    expect(response.status).toBe(201);
    expect(fakes.runs[0]).toMatchObject({ workspaceId: "ws-1", pipeline });
  });

  it("maps policy rejections to 415 and 413 before storage", async () => {
    const { app, fakes } = setup();
    expect((await app.request("/uploads/bulk", bulk([new File(["MZ"], "payload.exe", { type: "application/x-msdownload" })]))).status).toBe(415);
    expect((await app.request("/uploads/bulk", { method: "POST", headers: { "content-length": "999999999" } })).status).toBe(413);
    expect(fakes.objects.size).toBe(0);
  });

  it("returns 404 for an unknown target workspace", async () => {
    const { app } = setup([]);
    const response = await app.request("/uploads/bulk", bulk([text("notes.txt")], { workspaceId: "missing" }));
    expect(response.status).toBe(404);
  });

  it("returns field-level issues for invalid pipeline JSON before run creation", async () => {
    const { app, fakes } = setup();
    const response = await app.request("/uploads/bulk", bulk([text("contracts.txt")], { pipeline: "{not-json" }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid pipeline payload",
      issues: [expect.objectContaining({ path: "pipeline" })],
    });
    expect(fakes.runs).toEqual([]);
  });

  it("returns field-level issues for invalid pipeline config on URL ingest", async () => {
    const { app } = setup();
    const response = await app.request(
      "/uploads/url",
      json({ workspaceId: "ws-1", urls: ["https://example.com/contracts.txt"], pipeline: { embed: false, indexVectors: true } }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: "pipeline.indexVectors" })]),
    });
  });

  it("rejects complex remote formats on URL ingest unless explicitly enabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("docx-body", {
      status: 200,
      headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-length": "9" },
    })));
    const { app } = setup();
    const response = await app.request("/uploads/url", json({ workspaceId: "ws-1", urls: ["https://example.com/report.docx"] }));
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("REMOTE_INGEST_COMPLEX_FORMATS_ENABLED=true") });
  });

  it("reports what URL ingest fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hello", { status: 200, headers: { "content-type": "text/plain", "content-length": "5" } })));
    const { app } = setup();
    const response = await app.request("/uploads/url", json({ workspaceId: "ws-1", urls: ["https://example.com/contracts.txt?token=secret"] }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ ingested: [{ filename: "contracts.txt", mimeType: "text/plain" }] });
  });

  it("defaults URL canonical IDs to the URL and accepts per-URL overrides", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })));
    const { app, fakes } = setup();
    const response = await app.request("/uploads/url", json({ workspaceId: "ws-1", urls: [
      "https://example.com/products/#pricing",
      { url: "https://example.com/products.mdx", canonicalId: "/products" },
    ] }));
    expect(response.status).toBe(201);
    expect(fakes.runs[0].files.map((file) => file.canonicalId)).toEqual(["https://example.com/products", "/products"]);
    expect(fakes.runs[0].files[0].metadata).toMatchObject({ sourceUrl: "https://example.com/products/#pricing" });
  });

  it("carries multipart canonical IDs onto stored files", async () => {
    const { app, fakes } = setup();
    let response = await app.request("/uploads/bulk", bulk([text("products.md")], { workspaceId: "ws-1", canonicalId: "/products" }));
    expect(response.status).toBe(201);
    response = await app.request("/uploads/bulk", bulk([text("a.md"), text("b.md")], {
      workspaceId: "ws-1", canonicalIds: JSON.stringify({ "b.md": "/b" }),
    }));
    expect(response.status).toBe(201);
    expect(fakes.runs.map((run) => run.files.map((file) => file.canonicalId ?? null))).toEqual([["/products"], [null, "/b"]]);
  });

  it("rejects canonical IDs that do not line up with the uploaded files", async () => {
    const { app, fakes } = setup();
    const response = await app.request("/uploads/bulk", bulk([text("a.md"), text("b.md")], { workspaceId: "ws-1", canonicalId: "/a" }));
    expect(response.status).toBe(400);
    expect(fakes.runs).toEqual([]);
  });

  it("accepts uploads with a deferred warning header when processing cannot start", async () => {
    const { app, fakes } = setup();
    fakes.state.temporalDown = true;
    const response = await app.request("/uploads/bulk", bulk([text("contracts.txt")]));
    expect(response.status).toBe(201);
    expect(response.headers.get("X-Temporal-Deferred")).toBe("true");
    await expect(response.json()).resolves.toMatchObject({ warnings: [expect.stringContaining("Temporal is currently unavailable")] });
  });

  it("returns a billing error response when run creation is blocked", async () => {
    const { app, fakes } = setup();
    fakes.state.blockRunCreation = new RunCreationBlockedError("Credit balance exhausted.", 402, "credit_exhausted");
    const response = await app.request("/uploads/bulk", bulk([text("contracts.txt")]));
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({ error: "Credit balance exhausted.", code: "credit_exhausted" });
    expect(fakes.objects.size).toBe(0);
  });
});
