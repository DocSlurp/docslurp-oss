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
vi.mock("../services/workspace-intake-actions.js", () => ({ confirmDirectUploadWorkspaceIntake: mocks.confirm }));
vi.mock("../services/workspace-intake.js", () => ({ WorkspaceIntakeError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } } }));
import { reconcileDirectUploads } from "../services/direct-upload-reconciler.js";
import { WorkspaceIntakeError } from "../services/workspace-intake.js";
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
    mocks.finalize.mockRejectedValueOnce(new WorkspaceIntakeError("size mismatch",400));
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
});
