import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  release: vi.fn(), end: vi.fn(async () => {}), create: vi.fn(), reserve: vi.fn(),
}));
const lockEnv = vi.hoisted(() => ({ databaseUrl: "postgres://lock-test" } as { databaseUrl: string; directUploadLockPoolMax?: number }));
vi.mock("../config.js", () => ({ env: lockEnv }));
vi.mock("../lib/api-pool.js", () => ({ createApiPool: mocks.create }));
import { closeDirectUploadLockPool, directUploadLockLimits, reserveDirectUploadLockConnection } from "../lib/direct-upload-locks.js";
afterEach(async () => { await closeDirectUploadLockPool(); vi.clearAllMocks(); });
function setup() {
  mocks.reserve.mockResolvedValue({release:mocks.release});
  mocks.create.mockReturnValue({sql:{reserve:mocks.reserve,end:mocks.end}});
}
describe("separate direct upload lock connections", () => {
  it("uses a lazy bounded pool separate from intake query connections", async () => {
    setup();
    const lock = await reserveDirectUploadLockConnection({ tenant: "org-x" });
    expect(mocks.create).toHaveBeenCalledWith("postgres://lock-test", {max:5,applicationName:"docslurp-upload-locks"});
    lock.release(); lock.release();
    expect(mocks.release).toHaveBeenCalledOnce();
    await closeDirectUploadLockPool();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
  it("drains existing locks before closing and permits a fresh pool afterward", async () => {
    setup();
    const lock = await reserveDirectUploadLockConnection({ tenant: "org-x" });
    const closing = closeDirectUploadLockPool();
    await Promise.resolve();
    expect(mocks.end).not.toHaveBeenCalled();
    lock.release();
    await closing;
    const next = await reserveDirectUploadLockConnection({ tenant: "org-x" });
    expect(mocks.create).toHaveBeenCalledTimes(2);
    next.release();
  });
});

describe("lock classes and deadlines", () => {
  it("keeps two short-only connections and one slot per heavy class at the default pool of 5, more at 8", () => {
    expect(directUploadLockLimits()).toEqual({ poolMax: 5, heavyMax: 3, batchMax: 1, batchPerOrg: 1, startMax: 1, startPerOrg: 1, shortPerOrg: 2, reconcileMax: 1 });
    // Below the minimum is raised to it.
    lockEnv.directUploadLockPoolMax = 3;
    expect(directUploadLockLimits()).toMatchObject({ poolMax: 5, heavyMax: 3 });
    lockEnv.directUploadLockPoolMax = 8;
    expect(directUploadLockLimits()).toEqual({ poolMax: 8, heavyMax: 6, batchMax: 3, batchPerOrg: 2, startMax: 2, startPerOrg: 1, shortPerOrg: 2, reconcileMax: 1 });
    for (const pool of [5, 6, 8, 16, 64]) {
      lockEnv.directUploadLockPoolMax = pool;
      const limits = directUploadLockLimits();
      // The heavy classes together never reach the two short-only connections, and each keeps at least one slot.
      expect(limits.heavyMax).toBe(limits.poolMax - 2);
      expect(Math.min(limits.batchMax, limits.startMax, limits.reconcileMax)).toBeGreaterThanOrEqual(1);
      expect(limits.batchMax + limits.startMax + limits.reconcileMax).toBeLessThanOrEqual(limits.heavyMax);
    }
    delete lockEnv.directUploadLockPoolMax;
  });

  it("at the default pool, caps each heavy class and still serves short operations with every heavy slot taken", async () => {
    vi.useFakeTimers();
    try {
      setup();
      const batch = await reserveDirectUploadLockConnection({ lockClass: "batch", tenant: "org-a" });
      // The one batch slot is taken: another organization's batch waits, then gives up on its deadline.
      let batchRefused: unknown = null;
      const batch2 = reserveDirectUploadLockConnection({ lockClass: "batch", tenant: "org-b", deadline: Date.now() + 2_500 }).catch(error => { batchRefused = error; });
      const start = await reserveDirectUploadLockConnection({ lockClass: "start", tenant: "org-b" });
      const reconcile = await reserveDirectUploadLockConnection({ lockClass: "reconcile" });
      // Every heavy slot is taken: another run start is refused, but both short-only connections are served.
      let startRefused: unknown = null;
      const start2 = reserveDirectUploadLockConnection({ lockClass: "start", tenant: "org-c" }).catch(error => { startRefused = error; });
      const short1 = await reserveDirectUploadLockConnection({ tenant: "org-x" });
      const short2 = await reserveDirectUploadLockConnection({ tenant: "org-x" });
      await vi.advanceTimersByTimeAsync(2_600);
      await Promise.all([batch2, start2]);
      expect(batchRefused).toMatchObject({ name: "DirectUploadLockUnavailable" });
      expect(startRefused).toMatchObject({ name: "DirectUploadLockUnavailable" });
      // A released slot is handed to the next waiter of that class.
      const waiting = reserveDirectUploadLockConnection({ lockClass: "batch", tenant: "org-c", deadline: Date.now() + 5_000 });
      batch.release();
      const batch3 = await waiting;
      for (const lock of [start, reconcile, short1, short2, batch3]) lock.release();
    } finally { vi.useRealTimers(); }
  });

  it("gives up on a saturated pool on schedule and hands back a connection that arrives late", async () => {
    vi.useFakeTimers();
    try {
      setup();
      let deliver!: (connection: { release: () => void }) => void;
      const lateRelease = vi.fn();
      mocks.reserve.mockReturnValueOnce(new Promise(resolve => { deliver = resolve; }));
      let refused: unknown = null;
      const pending = reserveDirectUploadLockConnection({ tenant: "org-x", deadline: Date.now() + 2_500 }).catch(error => { refused = error; });
      await vi.advanceTimersByTimeAsync(2_400);
      expect(refused).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      expect(refused).toMatchObject({ name: "DirectUploadLockUnavailable" });
      deliver({ release: lateRelease });
      await vi.advanceTimersByTimeAsync(0);
      expect(lateRelease).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("keeps a caller's explicit deadline exactly, and requires a tenant for capped classes", async () => {
    vi.useFakeTimers();
    try {
      setup();
      let deliver!: (connection: { release: () => void }) => void;
      mocks.reserve.mockReturnValueOnce(new Promise(resolve => { deliver = resolve; }));
      let refusedAt = 0;
      const started = Date.now();
      // A 300 ms wait is not stretched to the 2 s default: confirm's documented limit holds.
      const pending = reserveDirectUploadLockConnection({ tenant: "org-x", deadline: Date.now() + 300 }).catch(() => { refusedAt = Date.now(); });
      await vi.advanceTimersByTimeAsync(350);
      await pending;
      expect(refusedAt - started).toBeLessThan(400);
      await expect(reserveDirectUploadLockConnection({ lockClass: "start" })).rejects.toThrow(/needs a tenant/);
      deliver({ release: () => {} });
      await vi.advanceTimersByTimeAsync(0);
    } finally { vi.useRealTimers(); }
  });

  it("caps one organization's short holders so another organization's short work is served", async () => {
    vi.useFakeTimers();
    try {
      setup();
      const a1 = await reserveDirectUploadLockConnection({ tenant: "org-a" });
      const a2 = await reserveDirectUploadLockConnection({ tenant: "org-a" });
      let refused: unknown = null;
      const a3 = reserveDirectUploadLockConnection({ tenant: "org-a" }).catch(error => { refused = error; });
      const b1 = await reserveDirectUploadLockConnection({ tenant: "org-b" });
      await vi.advanceTimersByTimeAsync(2_100);
      await a3;
      expect(refused).toMatchObject({ name: "DirectUploadLockUnavailable" });
      for (const lock of [a1, a2, b1]) lock.release();
    } finally { vi.useRealTimers(); }
  });
});
