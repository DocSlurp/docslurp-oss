import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sql: vi.fn(async () => []), confirm: vi.fn() }));
vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("../services/direct-upload-session.js", () => ({
  loadDirectUploadSession: vi.fn(), finalizeDirectUploadFile: vi.fn(), abortDirectUploadSession: vi.fn(),
  queueAbandonedDirectUploadCleanup: vi.fn(), withDirectUploadLock: async (_id: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("../services/project-intake-actions.js", () => ({ confirmDirectUploadProjectIntake: mocks.confirm }));
vi.mock("../services/project-intake.js", () => ({
  ProjectIntakeError: class extends Error { constructor(message: string, public statusCode: number, public issues?: unknown, public code?: string) { super(message); } },
}));
import { confirmCompletedDirectUploadSoon, settleImmediateConfirms } from "../services/direct-upload-reconciler.js";
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
});
