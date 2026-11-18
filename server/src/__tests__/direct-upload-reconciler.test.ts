import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  sql: vi.fn(), load: vi.fn(), finalize: vi.fn(), confirm: vi.fn(), abort: vi.fn(), cleanup: vi.fn(),
}));
vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("../services/direct-upload-session.js", () => ({
  loadDirectUploadSession: mocks.load, finalizeDirectUploadFile: mocks.finalize,
  lockHoldBudget: () => ({ signal: new AbortController().signal, shouldStart: () => true }),
  abortDirectUploadSession: mocks.abort, queueAbandonedDirectUploadCleanup: mocks.cleanup,
  withDirectUploadLock: async (_id: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("../services/project-intake-actions.js", () => ({ confirmDirectUploadProjectIntake: mocks.confirm }));
vi.mock("../services/project-intake.js", () => ({ ProjectIntakeError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } } }));
import { reconcileDirectUploads, stopDirectUploadReconciler } from "../services/direct-upload-reconciler.js";
import { ProjectIntakeError } from "../services/project-intake.js";
const session = { id: "session-1", user_id: "user-1", expired: false, status: "pending" };
let scheduled: typeof session[];
beforeEach(() => {
  vi.clearAllMocks();
  scheduled = [{ ...session }];
  mocks.sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join("");
    if (text.includes("select id, user_id, status")) return scheduled;
    // The guarded terminal transition finds the session as observed.
    if (text.includes("set status = 'failed'")) return [{ id: "session-1" }];
    return [];
  });
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
  it("skips sessions a client is completing, except expired ones", async () => {
    await reconcileDirectUploads();
    const [selection] = mocks.sql.mock.calls.find(([strings]) => strings.join("").includes("select id, user_id, status"))!;
    expect(selection.join("")).toContain("(client_finalizing_until is null or client_finalizing_until <= now() or expires_at < now())");
  });
  it("finalizes a session's files a few at a time, attempting every file before acting on a failure", async () => {
    const log = vi.spyOn(console,"error").mockImplementation(() => {});
    const files = Array.from({ length: 20 }, (_, i) => ({ id: `file-${i}` }));
    mocks.load.mockResolvedValue({ session:{status:"pending"}, files });
    let inFlight = 0, peak = 0;
    mocks.finalize.mockImplementation(async (file: { id: string }) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 2));
      inFlight--;
      if (file.id === "file-3") throw new ProjectIntakeError("size mismatch", 400);
      return true;
    });
    await reconcileDirectUploads();
    expect(mocks.finalize).toHaveBeenCalledTimes(20);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(queryValues("set status = 'failed'")).toHaveLength(1);
    expect(mocks.confirm).not.toHaveBeenCalled();
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
  it("waits for active provider work and prevents another reservation during shutdown", async () => {
    let resume!: () => void;
    scheduled = [{...session},{...session,id:"session-2"}];
    mocks.finalize.mockReturnValueOnce(new Promise(resolve => { resume = () => resolve(true); }));
    const sweep = reconcileDirectUploads();
    await vi.waitFor(() => expect(mocks.finalize).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = stopDirectUploadReconciler().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resume();
    await Promise.all([sweep,stopping]);
    expect(stopped).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledOnce();
  });

});
