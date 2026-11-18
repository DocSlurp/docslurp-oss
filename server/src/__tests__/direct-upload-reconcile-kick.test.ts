import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The in-process reconcile started by the files/complete call that completes a session's last file.
const mocks = vi.hoisted(() => ({ sql: vi.fn(), load: vi.fn(), finalize: vi.fn(), confirm: vi.fn(), lock: vi.fn() }));
vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("../services/direct-upload-session.js", () => ({
  loadDirectUploadSession: mocks.load, finalizeDirectUploadFile: mocks.finalize,
  abortAbandonedMultipartUploads: async () => 0,
  lockHoldBudget: () => ({ signal: new AbortController().signal, shouldStart: () => true }),
  abortDirectUploadSession: vi.fn(), queueAbandonedDirectUploadCleanup: vi.fn(),
  withDirectUploadLock: (_id: string, work: () => Promise<unknown>) => mocks.lock(work),
}));
vi.mock("../services/project-intake-actions.js", () => ({ confirmDirectUploadProjectIntake: mocks.confirm }));
vi.mock("../services/project-intake.js", () => ({ ProjectIntakeError: class extends Error {
  constructor(message: string, public statusCode: number, public issues?: unknown, public code?: string) { super(message); }
} }));
const { kickDirectUploadReconcile, startDirectUploadReconciler, stopDirectUploadReconciler, DIRECT_UPLOAD_KICK_DELAY_MS } = await import("../services/direct-upload-reconciler.js");
const { ProjectIntakeError } = await import("../services/project-intake.js");

const SESSION = { id: "session-1", user_id: "user-1", status: "pending", expired: false };
let kickTarget: typeof SESSION[];
const queries = (fragment: string) => mocks.sql.mock.calls.filter(([strings]) => (strings as string[]).join("").includes(fragment));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  kickTarget = [];
  // The periodic sweep finds nothing; the kick's own lookup (by id) finds the session.
  mocks.sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join("");
    if (text.includes("where id =") && text.includes("select id, user_id, status")) return kickTarget;
    return [];
  });
  mocks.lock.mockImplementation((work: () => Promise<unknown>) => work());
  mocks.load.mockResolvedValue({ session: { status: "pending" }, files: [{ id: "f1", status: "completed" }] });
  mocks.finalize.mockResolvedValue(true);
  mocks.confirm.mockResolvedValue({});
});
afterEach(async () => { await stopDirectUploadReconciler(); vi.useRealTimers(); });

describe("reconcile kick", () => {
  it("does nothing in a process that does not run the reconciler", async () => {
    kickTarget = [SESSION];
    kickDirectUploadReconcile("session-1");
    await vi.advanceTimersByTimeAsync(DIRECT_UPLOAD_KICK_DELAY_MS + 10);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("confirms the session shortly after the last complete, without waiting for the sweep", async () => {
    startDirectUploadReconciler();
    await vi.advanceTimersByTimeAsync(0);
    kickTarget = [SESSION];
    kickDirectUploadReconcile("session-1");
    kickDirectUploadReconcile("session-1"); // at most one kick per session at a time (this one earns a later re-run)
    expect(mocks.confirm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DIRECT_UPLOAD_KICK_DELAY_MS + 10);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.confirm).toHaveBeenCalledWith({ sessionId: "session-1", userId: "user-1" });
    // One lookup despite two kicks.
    expect(queries("where id =").filter(([strings]) => (strings as string[]).join("").includes("select id, user_id, status"))).toHaveLength(1);
  });

  it("leaves a busy session to its holder without rescheduling or recording an error", async () => {
    startDirectUploadReconciler();
    await vi.advanceTimersByTimeAsync(0);
    kickTarget = [SESSION];
    mocks.lock.mockRejectedValueOnce(new ProjectIntakeError("busy", 409, undefined, "upload_session_busy"));
    kickDirectUploadReconcile("session-1");
    await vi.advanceTimersByTimeAsync(DIRECT_UPLOAD_KICK_DELAY_MS + 10);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(queries("reconcile_attempts = reconcile_attempts + 1")).toHaveLength(0);
    expect(queries("last_error")).toHaveLength(0);
  });

  it("skips a session that was confirmed or closed meanwhile", async () => {
    startDirectUploadReconciler();
    await vi.advanceTimersByTimeAsync(0);
    kickDirectUploadReconcile("session-1");
    await vi.advanceTimersByTimeAsync(DIRECT_UPLOAD_KICK_DELAY_MS + 10);
    expect(mocks.lock).not.toHaveBeenCalled();
  });
});
