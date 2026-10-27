import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceIntakeFakes, fakeWorkspace } from "./helpers/workspace-intake-fakes.js";

/**
 * /v1/extracts over the real intake (in-memory storage and records): sources
 * land under the extract prefix, partial success, scope and tenant checks, and
 * the reviewed errors. The extract records themselves are covered by
 * extracts.db.test.ts.
 */
const mocks = vi.hoisted(() => ({
  created: [] as Array<{ orgId: string; workspaceId: string; options: Record<string, unknown>; estimatedSourceBytes?: number }>,
  abandoned: [] as string[],
  attached: [] as Array<[string, string]>,
  creditsBlocked: false,
  extractRow: null as Record<string, unknown> | null,
  sign: vi.fn(async () => "https://storage.test/extracts/org-1/ext_x/exports/exp/a1.zip?X-Amz-Expires=120"),
  expire: vi.fn(async () => undefined),
  workspaces: new Map<string, { id: string; orgId: string; name: string }>(),
  validateApiKey: vi.fn(),
  orgAdmin: false,
  hasRun: false,
}));

vi.mock("../services/extracts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/extracts.js")>();
  const { SpendBlockedError } = await import("../services/billing/spend-guard.js");
  return {
    ...actual,
    async createExtract(args: { orgId: string; workspaceId: string; options: { retentionDays?: number }; estimatedSourceBytes?: number }) {
      const { paid } = actual.resolveExtractRetention(args.options, { freeHours: 48, maxDays: 30 });
      if (paid && mocks.creditsBlocked) throw new SpendBlockedError("no credits", "credit_exhausted");
      mocks.created.push(args);
      const id = `ext_${String(mocks.created.length).padStart(32, "0")}`;
      return { id, storagePrefix: `extracts/${args.orgId}/${id}` };
    },
    abandonExtract: vi.fn(async (id: string) => { mocks.abandoned.push(id); }),
    attachExtractRun: vi.fn(async (id: string, runId: string) => { mocks.attached.push([id, runId]); }),
    describeExtractById: vi.fn(async (id: string) => ({ id, status: "processing", expiresAt: "2026-10-28T00:00:00.000Z" })),
    getExtractForActor: vi.fn(async (id: string, actor: { type: string; apiKey?: { orgId: string } }) => {
      const row = mocks.extractRow;
      if (!row || row.id !== id) return null;
      if (actor.type === "apiKey" && actor.apiKey?.orgId !== row.org_id) return null;
      return row;
    }),
    signExtractDownload: vi.fn(async (row: Record<string, unknown>) => {
      if (row.expired) throw new actual.ExtractError(410, "extract_expired", actual.EXTRACT_EXPIRED_MESSAGE);
      return await mocks.sign();
    }),
    expireExtractNow: mocks.expire,
    actorMayDownload: vi.fn(async (actor: { userId: string }, row: { user_id?: string }) => row.user_id === actor.userId || mocks.orgAdmin),
    extractHasRun: vi.fn(async () => mocks.hasRun),
    chargeExtractRetention: vi.fn(async () => 0),
  };
});
vi.mock("../services/workspaces.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/workspaces.js")>(),
  getWorkspace: vi.fn(async (id: string) => mocks.workspaces.get(id) ?? null),
}));
vi.mock("./../routes/uploads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routes/uploads.js")>();
  return {
    ...actual,
    // Workspace lookup without a database: "new" asks for a new workspace, anything else must be known.
    directUploadTarget: vi.fn(async (actor: { type: string; apiKey?: { workspaceIds?: string[] } }, input: { workspace?: string; newWorkspace?: boolean }) => {
      if (input.newWorkspace) {
        if (actor.type === "apiKey" && actor.apiKey?.workspaceIds?.length) {
          const { WorkspaceIntakeError } = await import("../services/workspace-intake.js");
          throw new WorkspaceIntakeError("This API key is limited to specific workspaces and cannot create new ones.", 403);
        }
        return { workspaceId: null, workspaceName: null };
      }
      return { workspaceId: input.workspace ?? "ws-1", workspaceName: null };
    }),
  };
});
vi.mock("../services/api-keys.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/api-keys.js")>(),
  validateApiKey: mocks.validateApiKey,
}));

const { createExtractsRoutes } = await import("../routes/extracts.js");
const { apiKeyAuth } = await import("../middleware/api-key-auth.js");
const { apiPublicErrorMiddleware } = await import("../lib/public-errors.js");

type Key = { scopes?: string[]; keyType?: string; workspaceIds?: string[]; orgId?: string };

function setup(apiKey?: Key) {
  const fakes = createWorkspaceIntakeFakes({ workspaces: [fakeWorkspace({ id: "ws-1", orgId: "org-1" })] });
  const runs: Array<{ extract?: unknown }> = [];
  const createRun = fakes.ports.records.createRun;
  fakes.ports.records.createRun = async (args) => { runs.push(args); return await createRun(args); };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1", email: "u@example.test", name: "U" } as never);
    if (apiKey) c.set("apiKey", { userId: "user-1", orgId: "org-1", keyType: "server", keyId: "key-1", workspaceIds: [], scopes: ["ingest"], ...apiKey } as never);
    await next();
  });
  // The production boundary: only reviewed copy and closed codes leave the API.
  app.use("*", apiPublicErrorMiddleware);
  app.route("/extracts", createExtractsRoutes(fakes.ports));
  return { app, fakes, runs };
}

function bulk(files: File[], fields: Record<string, string> = {}): RequestInit {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  for (const file of files) form.append("files", file);
  return { method: "POST", body: form };
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const text = (name: string) => new File(["hello"], name, { type: "text/plain" });
const exe = () => new File(["MZ\u0090\u0000"], "payload.exe", { type: "application/x-msdownload" });

beforeEach(() => {
  mocks.created.length = 0;
  mocks.abandoned.length = 0;
  mocks.attached.length = 0;
  mocks.creditsBlocked = false;
  mocks.extractRow = null;
  mocks.workspaces.clear();
  mocks.workspaces.set("ws-1", { id: "ws-1", orgId: "org-1", name: "Inbox" });
  mocks.sign.mockClear();
  mocks.expire.mockClear();
  mocks.validateApiKey.mockReset();
  mocks.orgAdmin = false;
  mocks.hasRun = false;
});

describe("POST /v1/extracts/bulk", () => {
  it("stores sources under the extract prefix, creates the run with the extract and returns it", async () => {
    const { app, fakes, runs } = setup();
    const response = await app.request("/extracts/bulk", bulk([text("notes.txt")], { retentionDays: "2", notifyEmail: "false", download: "all" }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.extract).toMatchObject({ id: "ext_00000000000000000000000000000001" });
    expect(mocks.created[0]).toMatchObject({ orgId: "org-1", workspaceId: "ws-1", options: { retentionDays: 2, notifyEmail: false, download: "all" }, estimatedSourceBytes: 5 });
    const keys = [...fakes.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^extracts\/org-1\/ext_0{31}1\/raw\/[0-9a-f-]{36}-notes\.txt$/);
    expect(runs[0]).toMatchObject({ extract: { id: "ext_00000000000000000000000000000001", storagePrefix: "extracts/org-1/ext_00000000000000000000000000000001" } });
    // The run links to its extract inside run creation (run-creation.ts), not afterwards.
  });

  it("accepts the good files, reports the bad ones, and fails only when nothing was created", async () => {
    const { app, fakes } = setup();
    const partial = await app.request("/extracts/bulk", bulk([text("a.txt"), exe()]));
    expect(partial.status).toBe(201);
    expect((await partial.json()).rejected).toEqual([expect.objectContaining({ filename: "payload.exe", statusCode: 415 })]);

    const none = await app.request("/extracts/bulk", bulk([exe()]));
    expect(none.status).toBe(415);
    // The extract made for the failed request expires at once, so the sweep empties its prefix.
    expect(mocks.abandoned).toEqual(["ext_00000000000000000000000000000002"]);
    expect([...fakes.objects.keys()].every((key) => key.startsWith("extracts/org-1/ext_0000000000000000000000000000000"))).toBe(true);
  });

  it("refuses an oversized body before storing anything", async () => {
    const { app, fakes } = setup();
    const response = await app.request("/extracts/bulk", { ...bulk([text("big.txt")]), headers: { "content-length": "999999999999" } });
    expect(response.status).toBe(413);
    expect(fakes.objects.size).toBe(0);
    expect(mocks.abandoned).toHaveLength(1);
  });

  it("refuses retention past the cap with a reviewed error and a paid window without credits with 402", async () => {
    const { app, fakes } = setup();
    const capped = await app.request("/extracts/bulk", bulk([text("a.txt")], { retentionDays: "31" }));
    expect(capped.status).toBe(400);
    expect(await capped.json()).toMatchObject({ error: { code: "retention_exceeds_cap", details: { maxRetentionDays: 30 } } });

    mocks.creditsBlocked = true;
    const blocked = await app.request("/extracts/bulk", bulk([text("a.txt")], { retentionDays: "30" }));
    expect(blocked.status).toBe(402);
    const invalid = await app.request("/extracts/bulk", bulk([text("a.txt")], { retentionDays: "lots" }));
    expect(invalid.status).toBe(422);
    expect(fakes.objects.size).toBe(0);
    expect(mocks.created).toHaveLength(0);
  });

  it("removes a workspace it created for an extract that then failed", async () => {
    const { app, fakes } = setup();
    const response = await app.request("/extracts/bulk", bulk([exe()], { newWorkspace: "true" }));
    expect(response.status).toBe(415);
    expect(fakes.createdWorkspaces).toHaveLength(1);
    expect(fakes.discardedWorkspaces).toHaveLength(1);
  });
});

describe("API key scope on /v1/extracts", () => {
  it("needs ingest to create, the key's own org, and an unrestricted key to create a workspace", async () => {
    expect((await setup({ scopes: ["search"] }).app.request("/extracts/bulk", bulk([text("a.txt")]))).status).toBe(403);
    expect((await setup({ scopes: ["artifacts"] }).app.request("/extracts/url", json({ urls: ["https://example.com/a.pdf"] }))).status).toBe(403);
    expect((await setup().app.request("/extracts/url", json({ urls: ["https://example.com/a.pdf"], retentionDays: 99 }))).status).toBe(400);
    const foreign = await setup({ scopes: ["ingest"] }).app.request("/extracts/url", json({ urls: ["https://example.com/a.pdf"], orgId: "org-2" }));
    expect(foreign.status).toBe(403);
    const restricted = await setup({ scopes: ["ingest"], workspaceIds: ["ws-1"] }).app.request("/extracts/bulk", bulk([text("a.txt")], { newWorkspace: "true" }));
    expect(restricted.status).toBe(403);
    expect(mocks.created).toHaveLength(0);
  });

  it("refuses a workspace outside the key's allowlist as not found", async () => {
    mocks.workspaces.set("ws-2", { id: "ws-2", orgId: "org-1", name: "Other" });
    const response = await setup({ scopes: ["ingest"], workspaceIds: ["ws-1"] }).app.request("/extracts/bulk", bulk([text("a.txt")], { workspace: "ws-2" }));
    expect(response.status).toBe(404);
    expect(mocks.created).toHaveLength(0);
  });

  it("downloads only with a server key holding artifacts", async () => {
    mocks.extractRow = { id: "ext_1", org_id: "org-1", workspace_id: "ws-1", user_id: "user-1", expired: false };
    expect((await setup({ scopes: ["ingest"] }).app.request("/extracts/ext_1/download")).status).toBe(403);
    expect((await setup({ scopes: ["artifacts"], keyType: "publishable" }).app.request("/extracts/ext_1/download")).status).toBe(403);
    const allowed = await setup({ scopes: ["artifacts"] }).app.request("/extracts/ext_1/download");
    expect(allowed.status).toBe(302);
  });

  it("rejects a revoked or unknown key before the route runs", async () => {
    const fakes = createWorkspaceIntakeFakes({ workspaces: [fakeWorkspace({ id: "ws-1", orgId: "org-1" })] });
    const app = new Hono().use("*", apiKeyAuth).route("/v1/extracts", createExtractsRoutes(fakes.ports));
    mocks.validateApiKey.mockResolvedValue(null);
    const response = await app.request("/v1/extracts/bulk", { ...bulk([text("a.txt")]), headers: { Authorization: "Bearer dslp_revoked" } });
    expect(response.status).toBe(403);
    expect(mocks.created).toHaveLength(0);
    expect(fakes.objects.size).toBe(0);
  });
});

describe("download authorization and failures after the run exists", () => {
  it("lets the requester or an org owner/admin download, not other workspace readers", async () => {
    const { app } = setup();
    mocks.extractRow = { id: "ext_1", org_id: "org-1", workspace_id: "ws-1", user_id: "someone-else", expired: false };
    expect((await app.request("/extracts/ext_1/download")).status).toBe(403);
    expect(mocks.sign).not.toHaveBeenCalled();
    mocks.orgAdmin = true;
    expect((await app.request("/extracts/ext_1/download")).status).toBe(302);
  });

  it("never expires an extract or removes its workspace once its run exists", async () => {
    const { app, fakes } = setup();
    mocks.hasRun = true;
    fakes.state.startError = null;
    // Fail after intake committed the run (the response payload cannot be built).
    const actions = await import("../services/workspace-intake-actions.js");
    const spy = vi.spyOn(actions, "createBulkWorkspaceIntake").mockRejectedValueOnce(new Error("lost connection after commit"));
    const response = await app.request("/extracts/bulk", bulk([text("a.txt")], { newWorkspace: "true" }));
    expect(response.status).toBe(500);
    expect(mocks.abandoned).toEqual([]);
    expect(fakes.discardedWorkspaces).toEqual([]);
    spy.mockRestore();
  });
});

describe("deleting an extract", () => {
  it("lets only the requester expire it early", async () => {
    const { app } = setup();
    mocks.extractRow = { id: "ext_1", org_id: "org-1", workspace_id: "ws-1", user_id: "someone-else", expired: false };
    expect((await app.request("/extracts/ext_1", { method: "DELETE" })).status).toBe(403);
    expect(mocks.expire).not.toHaveBeenCalled();
    expect((await setup({ scopes: ["artifacts"] }).app.request("/extracts/ext_1", { method: "DELETE" })).status).toBe(403);
    mocks.extractRow = { ...mocks.extractRow, user_id: "user-1", state: "active", retention_hours: 48, paid_retention: false, expires_at: new Date().toISOString(), created_at: new Date().toISOString(), notify_email: true, download_content: "markdown", run_id: null, pages: null, stored_bytes: null, retention_credits: null, completed_at: null, deleted_at: null, export_skipped: false };
    const deleted = await app.request("/extracts/ext_1", { method: "DELETE" });
    expect(deleted.status).toBe(202);
    expect(mocks.expire).toHaveBeenCalledTimes(1);
    expect((await deleted.json()).extract.status).toBe("expired");
  });
});

describe("reading an extract", () => {
  it("is 404 for another tenant, 410 once expired, and redirects to a short-lived signed URL with no-store", async () => {
    const { app } = setup();
    mocks.extractRow = { id: "ext_1", org_id: "org-1", workspace_id: "ws-1", user_id: "user-1", expired: false };
    // Another org's key sees nothing, for the record and for the download.
    const other = setup({ scopes: ["artifacts"], orgId: "org-2" }).app;
    expect((await other.request("/extracts/ext_1")).status).toBe(404);
    expect((await other.request("/extracts/ext_1/download")).status).toBe(404);
    expect(mocks.sign).not.toHaveBeenCalled();
    // A tampered or unknown ID is the same 404.
    expect((await app.request("/extracts/ext_2/download")).status).toBe(404);

    const download = await app.request("/extracts/ext_1/download");
    expect(download.status).toBe(302);
    expect(download.headers.get("location")).toContain("X-Amz-Expires=120");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(download.headers.get("referrer-policy")).toBe("no-referrer");

    mocks.extractRow = { ...mocks.extractRow, expired: true, state: "deleted", retention_hours: 48, paid_retention: false, expires_at: new Date().toISOString(), created_at: new Date().toISOString(), notify_email: true, download_content: "markdown", run_id: null, pages: null, stored_bytes: null, retention_credits: null, completed_at: null, deleted_at: null, export_skipped: false };
    const gone = await app.request("/extracts/ext_1");
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ error: { code: "extract_expired" } });
    const goneDownload = await app.request("/extracts/ext_1/download");
    expect(goneDownload.status).toBe(410);
    expect(await goneDownload.json()).toMatchObject({ error: { code: "extract_expired", message: expect.stringContaining("expired") } });
  });
});
