import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  release: vi.fn(), end: vi.fn(async () => {}), create: vi.fn(), reserve: vi.fn(),
}));
vi.mock("../config.js", () => ({ env: { databaseUrl: "postgres://lock-test" } }));
vi.mock("../lib/api-pool.js", () => ({ createApiPool: mocks.create }));
import { closeDirectUploadLockPool, inBackgroundUploadLane, reserveDirectUploadLockConnection } from "../lib/direct-upload-locks.js";
afterEach(async () => { await closeDirectUploadLockPool(); vi.clearAllMocks(); });
function setup() {
  mocks.reserve.mockResolvedValue({release:mocks.release});
  mocks.create.mockReturnValue({sql:{reserve:mocks.reserve,end:mocks.end}});
}
describe("separate direct upload lock connections", () => {
  it("uses a lazy bounded pool separate from intake query connections", async () => {
    setup();
    const lock = await reserveDirectUploadLockConnection();
    expect(mocks.create).toHaveBeenCalledWith("postgres://lock-test", {max:2,applicationName:"docslurp-upload-locks"});
    lock.release(); lock.release();
    expect(mocks.release).toHaveBeenCalledOnce();
    await closeDirectUploadLockPool();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
  it("drains existing locks before closing and permits a fresh pool afterward", async () => {
    setup();
    const lock = await reserveDirectUploadLockConnection();
    const closing = closeDirectUploadLockPool();
    await Promise.resolve();
    expect(mocks.end).not.toHaveBeenCalled();
    lock.release();
    await closing;
    const next = await reserveDirectUploadLockConnection();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    next.release();
  });
  it("gives background upload work its own pool so it never queues a client's lock behind it", async () => {
    setup();
    const background = await inBackgroundUploadLane(() => reserveDirectUploadLockConnection());
    const request = await reserveDirectUploadLockConnection();
    expect(mocks.create).toHaveBeenCalledWith("postgres://lock-test", {max:8,applicationName:"docslurp-upload-locks-background"});
    expect(mocks.create).toHaveBeenCalledWith("postgres://lock-test", {max:2,applicationName:"docslurp-upload-locks"});
    expect(mocks.create).toHaveBeenCalledTimes(2);
    background.release(); request.release();
    await closeDirectUploadLockPool();
    expect(mocks.end).toHaveBeenCalledTimes(2);
  });
});
