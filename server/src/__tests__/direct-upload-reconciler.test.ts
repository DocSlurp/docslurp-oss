import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  sql: vi.fn(), load: vi.fn(), finalize: vi.fn(), confirm: vi.fn(), abort: vi.fn(), cleanup: vi.fn(),
}));
vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("../services/direct-upload-session.js", () => ({
  loadDirectUploadSession: mocks.load, finalizeDirectUploadFile: mocks.finalize,
  abortDirectUploadSession: mocks.abort, queueAbandonedDirectUploadCleanup: mocks.cleanup,
  withDirectUploadLock: async (_id: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("../services/project-intake-actions.js", () => ({ confirmDirectUploadProjectIntake: mocks.confirm, isReplayedDirectUploadConfirm: (result: { replayed?: boolean }) => result?.replayed === true }));
vi.mock("../lib/direct-upload-locks.js", () => ({ inBackgroundUploadLane: (run: () => Promise<unknown>) => run() }));
vi.mock("../services/project-intake.js", () => ({ ProjectIntakeError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } } }));
import { reconcileDirectUploads, stopDirectUploadReconciler } from "../services/direct-upload-reconciler.js";
import { ProjectIntakeError } from "../services/project-intake.js";
const session = { id: "session-1", user_id: "user-1", expired: false, status: "pending" };
let scheduled: typeof session[];
beforeEach(() => {
  vi.clearAllMocks();
  scheduled = [{ ...session }];
  mocks.sql.mockImplementation(async (strings: TemplateStringsArray) => strings.join("").includes("select id, user_id, status") ? scheduled : []);
  mocks.load.mockResolvedValue({ session:{status:"pending"},files:[{id:"file-1"}] });
  mocks.finalize.mockResolvedValue(true);
  mocks.confirm.mockResolvedValue({});
});
function queryValues(fragment: string) { return mocks.sql.mock.calls.filter(([strings]) => strings.join("").includes(fragment)).map(call => call.slice(1)); }
describe("automatic upload reconciler", () => {
  it("waits for incomplete bytes and caps ordinary polling at 30 seconds", async () => {
    mocks.finalize.mockResolvedValue(false);
    await reconcileDirectUploads();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(queryValues("next_reconcile_at = now() +")[0]?.[0]).toBe(30);
  });
  it("confirms complete sessions with the original initiating user", async () => {
    await reconcileDirectUploads();
    expect(mocks.confirm).toHaveBeenCalledWith({sessionId:"session-1",userId:"user-1"});
  });
  it("expires abandoned initialization but recovers expired ingestion", async () => {
    scheduled = [{...session,expired:true,status:"initializing"}];
    await reconcileDirectUploads();
    expect(mocks.abort).toHaveBeenCalledWith("session-1","user-1");
    expect(mocks.confirm).not.toHaveBeenCalled();
    mocks.abort.mockClear();
    scheduled = [{...session,expired:true,status:"ingesting"}];
    mocks.load.mockResolvedValue({session:{status:"ingesting"},files:[{id:"file-1",status:"completed"}]});
    await reconcileDirectUploads();
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalledOnce();
  });
  it("backs off provider failures and makes invalid bytes terminal", async () => {
    const log = vi.spyOn(console,"error").mockImplementation(() => {});
    mocks.finalize.mockRejectedValueOnce(new Error("storage unavailable"));
    await reconcileDirectUploads();
    expect(queryValues("next_reconcile_at = now() +")[0]?.[0]).toBe(300);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    mocks.finalize.mockRejectedValueOnce(new ProjectIntakeError("size mismatch",400));
    await reconcileDirectUploads();
    expect(queryValues("set status = 'failed'")).toHaveLength(1);
    expect(mocks.cleanup).toHaveBeenCalledWith("session-1");
    log.mockRestore();
  });
  it("does not overlap sweeps while a provider operation is pending", async () => {
    let resume!: () => void;
    mocks.finalize.mockReturnValueOnce(new Promise(resolve => { resume = () => resolve(true); }));
    const first = reconcileDirectUploads();
    await vi.waitFor(() => expect(mocks.finalize).toHaveBeenCalledOnce());
    await reconcileDirectUploads();
    expect(mocks.load).toHaveBeenCalledOnce();
    resume();
    await first;
  });
  it("finalizes due sessions side by side, at most eight at a time", async () => {
    scheduled = Array.from({ length: 12 }, (_, index) => ({ ...session, id: `session-${index}` }));
    const resumes: Array<() => void> = [];
    mocks.finalize.mockImplementation(() => new Promise(resolve => { resumes.push(() => resolve(true)); }));
    const sweep = reconcileDirectUploads();
    await vi.waitFor(() => expect(mocks.finalize).toHaveBeenCalledTimes(8));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mocks.finalize).toHaveBeenCalledTimes(8);
    resumes.splice(0).forEach(resume => resume());
    await vi.waitFor(() => expect(mocks.finalize).toHaveBeenCalledTimes(12));
    resumes.splice(0).forEach(resume => resume());
    await sweep;
    expect(mocks.confirm).toHaveBeenCalledTimes(12);
    expect(new Set(mocks.confirm.mock.calls.map(([args]) => args.sessionId)).size).toBe(12);
  });
  it("treats a session another process holds as busy, not failed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const busy = Object.assign(new ProjectIntakeError("busy", 409), { code: "upload_session_busy" });
    mocks.confirm.mockRejectedValueOnce(busy);
    await reconcileDirectUploads();
    expect(queryValues("last_error = 'Upload finalization is retrying'")).toHaveLength(0);
    expect(queryValues("next_reconcile_at = now() +")[0]?.[0]).toBe(30);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it("waits for active provider work and prevents another reservation during shutdown", async () => {
    let resume!: () => void;
    // Nine due sessions: the pool starts eight; shutdown must keep the ninth from starting.
    scheduled = Array.from({ length: 9 }, (_, index) => ({ ...session, id: `session-${index}` }));
    mocks.finalize.mockReturnValue(new Promise(resolve => { resume = () => resolve(true); }));
    const sweep = reconcileDirectUploads();
    await vi.waitFor(() => expect(mocks.finalize).toHaveBeenCalledTimes(8));
    let stopped = false;
    const stopping = stopDirectUploadReconciler().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resume();
    await Promise.all([sweep,stopping]);
    expect(stopped).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledTimes(8);
  });

});
