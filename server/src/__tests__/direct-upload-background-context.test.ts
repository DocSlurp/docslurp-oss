import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";

/**
 * Background upload work started by a request (the kick after the last files/complete, a storage-notification sweep)
 * never runs in that request's async context: intake falls back to the request's API key, project allowlist and
 * organization when a session has none, so inheriting them would run another tenant's intake under them.
 */
const storage = vi.hoisted(() => ({ current: null as AsyncLocalStorage<{ apiKeyId: string }> | null }));
const seen = vi.hoisted(() => [] as unknown[]);
vi.mock("../db.js", () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    if (strings.join("").includes("from upload_sessions")) seen.push(storage.current?.getStore() ?? null);
    return [];
  }),
}));
vi.mock("../services/direct-upload-session.js", () => ({
  loadDirectUploadSession: vi.fn(), finalizeDirectUploadFile: vi.fn(), abortDirectUploadSession: vi.fn(),
  abortAbandonedMultipartUploads: async () => 0, queueAbandonedDirectUploadCleanup: vi.fn(),
  lockHoldBudget: () => ({ signal: new AbortController().signal, shouldStart: () => true }),
  withDirectUploadLock: async (_id: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("../services/project-intake-actions.js", () => ({ confirmDirectUploadProjectIntake: vi.fn(), isReplayedDirectUploadConfirm: () => false }));
vi.mock("../services/project-intake.js", () => ({ ProjectIntakeError: class extends Error {} }));
import { kickDirectUploadReconcile, requestDirectUploadSweep, startDirectUploadReconciler, stopDirectUploadReconciler } from "../services/direct-upload-reconciler.js";

describe("background upload work runs outside the triggering request", () => {
  it("a requested sweep and a kick see no request context", async () => {
    const context = new AsyncLocalStorage<{ apiKeyId: string }>();
    storage.current = context;
    startDirectUploadReconciler();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    await context.run({ apiKeyId: "key-of-org-a" }, async () => { requestDirectUploadSweep(); });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
    await context.run({ apiKeyId: "key-of-org-a" }, async () => { kickDirectUploadReconcile("session-of-org-a"); });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(3), { timeout: 3_000 });
    expect(seen.every(store => store === null)).toBe(true);
    await stopDirectUploadReconciler();
  });
});
