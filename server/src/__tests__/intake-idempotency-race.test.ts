import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ locks: new Set<string>(), cache: new Map<string, { status: number; body: Record<string, unknown> }>(), executions: 0 }));
vi.mock("../services/direct-upload-session.js", () => ({
  withDirectUploadLock: async (name: string, run: () => Promise<unknown>) => {
    if (state.locks.has(name)) throw Object.assign(new Error("in flight"), { statusCode: 409 });
    state.locks.add(name);
    try { return await run(); } finally { state.locks.delete(name); }
  },
}));
vi.mock("../services/idempotency.js", async (original) => ({
  ...await original<typeof import("../services/idempotency.js")>(),
  getCachedIdempotentResponse: async (a: { idempotencyKey: string }) => state.cache.get(a.idempotencyKey) ?? null,
  storeIdempotentResponse: async (a: { idempotencyKey: string; status: number; body: Record<string, unknown> }) => { state.cache.set(a.idempotencyKey, a); },
}));
vi.mock("../services/project-intake.js", async (original) => ({
  ...await original<typeof import("../services/project-intake.js")>(),
  intakeIntoProject: async () => {
    state.executions++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { project: { id: "p" }, run: { id: "r" }, documents: [], rejected: [] };
  },
}));
const { createBulkProjectIntake } = await import("../services/project-intake-actions.js");
const args = { userId: "u", orgId: "o", project: "p", idempotencyKey: "same", files: [new File(["hello"], "a.txt", { type: "text/plain" })] };
beforeEach(() => { state.cache.clear(); state.locks.clear(); state.executions = 0; });
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
  await createBulkProjectIntake({ ...args, apiKeyId: "key-b" });
  await createBulkProjectIntake({ ...args, orgId: "other", apiKeyId: "key-a" });
  expect(state.executions).toBe(3);
});
