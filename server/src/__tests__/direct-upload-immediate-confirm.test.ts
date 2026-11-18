import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sql: vi.fn(async () => []), confirm: vi.fn() }));
vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("../services/direct-upload-session.js", () => ({
  loadDirectUploadSession: vi.fn(), finalizeDirectUploadFile: vi.fn(), abortDirectUploadSession: vi.fn(),
  queueAbandonedDirectUploadCleanup: vi.fn(), withDirectUploadLock: async (_id: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("../services/project-intake-actions.js", () => ({ confirmDirectUploadProjectIntake: mocks.confirm, isReplayedDirectUploadConfirm: (result: { replayed?: boolean }) => result?.replayed === true }));
vi.mock("../lib/direct-upload-locks.js", () => ({ inBackgroundUploadLane: (run: () => Promise<unknown>) => run() }));
vi.mock("../services/project-intake.js", () => ({
  ProjectIntakeError: class extends Error { constructor(message: string, public statusCode: number, public issues?: unknown, public code?: string) { super(message); } },
}));
import { AsyncLocalStorage } from "node:async_hooks";
import { confirmCompletedDirectUploadSoon, requestDirectUploadSweep, settleImmediateConfirms, startDirectUploadReconciler, stopDirectUploadReconciler } from "../services/direct-upload-reconciler.js";
import { ProjectIntakeError } from "../services/project-intake.js";

beforeEach(() => { vi.clearAllMocks(); });

describe("immediate confirm when the last file completes", () => {
  it("confirms the session for its own user with the route's ports and audit, and logs the lag", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.confirm.mockResolvedValue({ status: 202, payload: {} });
    const ports = { storage: {}, records: {} } as never;
    confirmCompletedDirectUploadSoon({ sessionId: "s-1", userId: "u-1", ports, audit: { ipAddress: "127.0.0.1" } });
    await settleImmediateConfirms();
    expect(mocks.confirm).toHaveBeenCalledWith({ sessionId: "s-1", userId: "u-1", audit: { ipAddress: "127.0.0.1" } }, ports);
    expect(log.mock.calls.some(([line]) => String(line).includes("[upload-reconcile] confirmed session=s-1 path=immediate lag_ms="))).toBe(true);
    log.mockRestore();
  });

  it("leaves a busy session to whoever holds it, silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.confirm.mockRejectedValue(new ProjectIntakeError("busy", 409, undefined, "upload_session_busy"));
    confirmCompletedDirectUploadSoon({ sessionId: "s-2", userId: "u-1" });
    await settleImmediateConfirms();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never throws: a failure goes to telemetry by name only and is left to the sweep", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.confirm.mockRejectedValue(new Error("secret-bearing provider message"));
    expect(() => confirmCompletedDirectUploadSoon({ sessionId: "s-3", userId: "u-1" })).not.toThrow();
    await settleImmediateConfirms();
    expect(warn).toHaveBeenCalledWith("[upload-reconcile] session=s-3 immediate confirm deferred to sweep", "Error");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-bearing");
    // The sweep owns failing a rejected session: the immediate path writes nothing.
    expect(mocks.sql).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("records no lag when the confirm replayed a run another path already started", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.confirm.mockResolvedValue({ replayed: true });
    confirmCompletedDirectUploadSoon({ sessionId: "s-4", userId: "u-1" });
    await settleImmediateConfirms();
    expect(log.mock.calls.some(([line]) => String(line).includes("confirmed session=s-4"))).toBe(false);
    log.mockRestore();
  });

  it("runs at most four at once per process and leaves the rest to the sweep", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const resumes: Array<() => void> = [];
    mocks.confirm.mockImplementation(() => new Promise(resolve => { resumes.push(() => resolve({})); }));
    for (let index = 0; index < 6; index += 1) confirmCompletedDirectUploadSoon({ sessionId: `burst-${index}`, userId: "u-1" });
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(4));
    expect(log.mock.calls.filter(([line]) => String(line).includes("immediate confirm skipped"))).toHaveLength(2);
    resumes.forEach(resume => resume());
    await settleImmediateConfirms();
    log.mockRestore();
  });

  it("never runs intake inside the request that triggered it: no request key, allowlist or organization leaks in", async () => {
    // Stand-in for the request context (lib/request-context.ts): intake falls back to it when a session has no key.
    const storage = new AsyncLocalStorage<{ apiKeyId: string; allowlist: string[] }>();
    const seen: Array<unknown> = [];
    mocks.confirm.mockImplementation(async () => { seen.push(storage.getStore() ?? null); return {}; });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await storage.run({ apiKeyId: "key-of-org-a", allowlist: ["project-a"] }, async () => {
      confirmCompletedDirectUploadSoon({ sessionId: "s-other", userId: "u-1" });
    });
    await settleImmediateConfirms();
    expect(seen).toEqual([null]);
    log.mockRestore();
  });

  it("sweeps outside the request that asked for it, directly or past the immediate-confirm cap", async () => {
    const storage = new AsyncLocalStorage<{ apiKeyId: string }>();
    const seen: unknown[] = [];
    mocks.sql.mockImplementation((async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("from upload_sessions")) seen.push(storage.getStore() ?? null);
      return [];
    }) as never);
    startDirectUploadReconciler();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 10));
    await storage.run({ apiKeyId: "key-of-org-a" }, async () => { requestDirectUploadSweep(); });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 10));
    const resumes: Array<() => void> = [];
    mocks.confirm.mockImplementation(() => new Promise(resolve => { resumes.push(() => resolve({})); }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await storage.run({ apiKeyId: "key-of-org-a" }, async () => {
      for (let index = 0; index < 5; index += 1) confirmCompletedDirectUploadSoon({ sessionId: `cap-${index}`, userId: "u-1" });
    });
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen).toEqual([null, null, null]);
    resumes.forEach(resume => resume());
    await stopDirectUploadReconciler();
    log.mockRestore();
  });
});
