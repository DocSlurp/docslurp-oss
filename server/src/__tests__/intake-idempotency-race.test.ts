import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ durable: null as null | Record<string, unknown>, preRunFault: false, persistReceipt: false, cacheFailure: false, stableFailure: false, rich: false, locks: new Set<string>(), cache: new Map<string, { status: number; body: Record<string, unknown> }>(), executions: 0, access: true, contribute: true, keyLive: true, keyProjects: [] as string[], keyScopes: ["ingest"] as string[] }));
vi.mock("../db.js", () => ({ sql: Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
  const query = parts.join("?");
  if (query.includes("set stable_result")) {
    if (state.stableFailure) throw new Error("receipt write fault");
    if (state.persistReceipt) state.durable = { ...state.durable, stable_result: values[0] };
    return [{ run_id: "r" }];
  }
  if (query.includes("delete from intake_request_receipts")) { state.durable = null; return []; }
  if (query.includes("intake_request_receipts")) return state.durable ? [state.durable] : [];
  if (query.includes("project_runs")) return [{ id: "r", project_id: "p", user_id: "u", pipeline: {} }];
  return [];
}, { json: (value: unknown) => value }) }));
vi.mock("../services/projects.js", async load => ({ ...await load<typeof import("../services/projects.js")>(), getProject: async () => ({ id: "p", orgId: "o" }) }));
vi.mock("../services/run-records.js", async load => ({ ...await load<typeof import("../services/run-records.js")>(), mapProjectRun: (row: {id:string}) => ({id: row.id}) }));
vi.mock("../services/organizations.js", () => ({
  getProjectAccess: async () => state.access ? { orgId: "o" } : null,
  canContributeToProject: () => state.contribute,
}));
vi.mock("../services/api-keys.js", () => ({
  getLiveApiKeyById: async () => state.keyLive ? { orgId: "o", scopes: state.keyScopes, projectIds: state.keyProjects } : null,
  // The intake credential recheck before external work: the same live key.
  getLiveIntakeKey: async () => state.keyLive ? { orgId: "o", scopes: state.keyScopes, projectIds: state.keyProjects } : null,
}));
vi.mock("../services/direct-upload-session.js", () => ({
  loadDirectUploadSession: async () => ({ session: { status: "completed", org_id: "o", api_key_id: "key-a", result: { payload: { project: { id: "p" }, run: { id: "r" }, documents: [] }, status: 201 } }, files: [] }),
  // Carries the stored result: the lock-free replay of a confirmed session re-authorizes it (the cases below).
  principalLockTenant: async () => "org:o",
  lockTenant: (orgId: string | null, userId: string) => orgId ? `org:${orgId}` : `user:${userId}`,
  loadDirectUploadSessionRow: async () => ({ status: "completed", org_id: "o", api_key_id: "key-a", result: { payload: { project: { id: "p" }, run: { id: "r" }, documents: [] }, status: 201 } }),
  withDirectUploadLock: async (name: string, run: () => Promise<unknown>) => {
    if (state.locks.has(name)) throw Object.assign(new Error("in flight"), { statusCode: 409 });
    state.locks.add(name);
    try { return await run(); } finally { state.locks.delete(name); }
  },
}));
vi.mock("../services/extracts.js", async load => ({
  ...await load<typeof import("../services/extracts.js")>(),
  chargeExtractRetention: vi.fn(async () => {}),
  describeExtractById: async (id: string) => ({id, state:"active"}),
}));
vi.mock("../services/idempotency.js", async (original) => ({
  ...await original<typeof import("../services/idempotency.js")>(),
  getCachedIdempotentResponse: async (a: { idempotencyKey: string }) => state.cache.get(a.idempotencyKey) ?? null,
  storeIdempotentResponse: async (a: { idempotencyKey: string; status: number; body: Record<string, unknown> }) => { if (state.cacheFailure) throw new Error("cache write fault"); state.cache.set(a.idempotencyKey, a); },
}));
vi.mock("../services/project-intake.js", async (original) => ({
  ...await original<typeof import("../services/project-intake.js")>(),
  intakeIntoProject: async () => {
    state.executions++;
    if (state.preRunFault) {
      const { intakeReceiptContext } = await import("../services/intake-receipt-context.js");
      state.durable = { request_hash: intakeReceiptContext.getStore()!.hash, run_id: null, creation_ready_at: null, external_effect_started: false };
      throw new Error("pre-run admission fault");
    }
    if (state.persistReceipt) {
      const { intakeReceiptContext } = await import("../services/intake-receipt-context.js");
      const receipt = intakeReceiptContext.getStore()!;
      state.durable = { request_hash: receipt.hash, run_id: "r", creation_ready_at: new Date() };
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    return { project: { id: "p" }, run: { id: "r" }, documents: [], rejected: state.rich ? [{filename:"bad.exe",code:"unsupported_format",message:"Unsupported"}] : [], deferredReason: state.rich ? "Workflow deferred" : null };
  },
}));
const { createBulkProjectIntake } = await import("../services/project-intake-actions.js");
const args = { userId: "u", orgId: "o", project: "p", idempotencyKey: "same", files: [new File(["hello"], "a.txt", { type: "text/plain" })] };
beforeEach(() => { state.rich = false; state.stableFailure = false; state.preRunFault = false; state.durable = null; state.persistReceipt = true; state.cacheFailure = false; state.cache.clear(); state.locks.clear(); state.executions = 0; state.access = true; state.contribute = true; state.keyLive = true; state.keyProjects = []; state.keyScopes = ["ingest"]; });
it("executes exactly one concurrent same-key intake and replays after completion", async () => {
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => createBulkProjectIntake(args)));
  expect(state.executions).toBe(1);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  for (const result of results) if (result.status === "rejected") expect(result.reason.statusCode).toBe(409);
  expect((await createBulkProjectIntake(args)).idempotencyReplayed).toBe(true);
  expect(state.executions).toBe(1);
});
it("never shares replay entries across tenants or API keys", async () => {
  await createBulkProjectIntake({ ...args, apiKeyId: "key-a" });
  state.durable = null;
  await createBulkProjectIntake({ ...args, apiKeyId: "key-b" });
  state.durable = null;
  await createBulkProjectIntake({ ...args, orgId: "other", apiKeyId: "key-a" });
  expect(state.executions).toBe(3);
});

it.each(["p", undefined])("refuses replay after project access removal, including default (%s)", async (project) => {
  const request = { ...args, project };
  await createBulkProjectIntake(request);
  state.access = false;
  await expect(createBulkProjectIntake(request)).rejects.toMatchObject({ statusCode: 403 });
  expect(state.executions).toBe(1);
});
it("refuses a cached response after contributor role removal", async () => {
  await createBulkProjectIntake(args);
  state.contribute = false;
  await expect(createBulkProjectIntake(args)).rejects.toMatchObject({ statusCode: 403 });
});
it.each(["revoked", "project", "scope"])("rechecks current API key policy: %s", async (change) => {
  const request = { ...args, apiKeyId: "key-a" };
  await createBulkProjectIntake(request);
  if (change === "revoked") state.keyLive = false;
  if (change === "project") state.keyProjects = ["other-project"];
  if (change === "scope") state.keyScopes = ["chat"];
  await expect(createBulkProjectIntake(request)).rejects.toMatchObject({ statusCode: 403 });
  expect(state.executions).toBe(1);
});
it("refuses a cached payload whose resolved project now belongs to another org", async () => {
  await createBulkProjectIntake({ ...args, orgId: "other" });
  await expect(createBulkProjectIntake({ ...args, orgId: "other" })).rejects.toMatchObject({ statusCode: 403 });
});

it("denies a bulk HTTP replay after live contribution access is revoked", async () => {
  const { Hono } = await import("hono");
  const { withTestSession } = await import("./helpers/session-app.js");
  const { createUploadsRoutes } = await import("../routes/uploads.js");
  const app = withTestSession(new Hono(), { id: "u", name: "U", email: "u@example.test" });
  app.route("/uploads", createUploadsRoutes());
  const request = () => {
    const body = new FormData();
    body.set("project", "p"); body.set("orgId", "o");
    body.append("files", new File(["hello"], "a.txt", { type: "text/plain" }));
    return app.request("/uploads/bulk", { method: "POST", headers: { "Idempotency-Key": "http-replay" }, body });
  };
  expect((await request()).status).toBe(201);
  state.contribute = false;
  expect((await request()).status).toBe(403);
  expect(state.executions).toBe(1);
});

it("recovers committed intake after response-cache failure without executing it again", async () => {
  state.persistReceipt = true; state.cacheFailure = true;
  await expect(createBulkProjectIntake(args)).rejects.toThrow("cache write fault");
  state.cacheFailure = false;
  expect((await createBulkProjectIntake(args)).idempotencyReplayed).toBe(true);
  expect(state.executions).toBe(1);
  state.access = false;
  await expect(createBulkProjectIntake(args)).rejects.toMatchObject({ statusCode: 403 });
});

it("retries the same key after a known pre-run fault", async () => {
  state.preRunFault = true;
  await expect(createBulkProjectIntake(args)).rejects.toThrow("pre-run admission fault");
  state.preRunFault = false;
  expect((await createBulkProjectIntake(args)).status).toBe(201);
  expect(state.executions).toBe(2);
});
it.each(["membership", "contribute", "revoked", "scope", "project"])("direct confirmation reauthorizes saved receipts: %s", async change => {
  const { confirmDirectUploadProjectIntake } = await import("../services/project-intake-actions.js");
  if (change === "membership") state.access = false;
  if (change === "contribute") state.contribute = false;
  if (change === "revoked") state.keyLive = false;
  if (change === "scope") state.keyScopes = ["chat"];
  if (change === "project") state.keyProjects = ["foreign"];
  await expect(confirmDirectUploadProjectIntake({ sessionId: "s", userId: "u" })).rejects.toMatchObject({ statusCode: 403 });
});

it("does not repeat an ambiguous external effect after restart", async () => {
  state.preRunFault = true;
  await expect(createBulkProjectIntake(args)).rejects.toThrow();
  state.preRunFault = false;
  state.durable!.external_effect_started = true;
  await expect(createBulkProjectIntake(args)).rejects.toMatchObject({ statusCode: 409, code: "intake_reconciliation_required" });
  expect(state.executions).toBe(1);
});

it("preserves mixed rejections and deferred warnings after cache loss or expiry", async () => {
  state.rich = true; state.persistReceipt = true;
  const original = await createBulkProjectIntake(args);
  state.cache.clear();
  const replay = await createBulkProjectIntake(args);
  expect(replay.payload).toEqual(original.payload);
  expect(replay.temporalDeferred).toBe(true);
  expect(state.executions).toBe(1);
});
it("refuses a published run missing its stable response without repeating effects", async () => {
  state.persistReceipt = true; state.stableFailure = true;
  await expect(createBulkProjectIntake(args)).rejects.toThrow("receipt write fault");
  state.stableFailure = false;
  await expect(createBulkProjectIntake(args)).rejects.toMatchObject({code:"intake_reconciliation_required"});
  expect(state.executions).toBe(1);
});

it("keeps the original extract receipt after cache expiry", async () => {
  state.persistReceipt = true;
  const original = await createBulkProjectIntake({...args, extract: {id:"original-extract"} as never});
  expect(original.payload.extract).toMatchObject({id:"original-extract"});
  state.cache.clear();
  const replay = await createBulkProjectIntake({...args, extract: {id:"retry-extract"} as never});
  expect(replay.payload.extract).toEqual(original.payload.extract);
  expect(state.executions).toBe(1);
});

it.each([null, {}])("refuses cache replay without a complete durable envelope (%s)", async stable => {
  state.persistReceipt = true;
  await createBulkProjectIntake(args);
  state.durable = { ...state.durable, stable_result: stable };
  await expect(createBulkProjectIntake(args)).rejects.toMatchObject({ statusCode: 409 });
  expect(state.executions).toBe(1);
});
