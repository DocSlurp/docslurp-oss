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
  it("partitions the default pool of 5 (2 short, 1 reconcile, 2 shared by batch, start and intake) and 8 likewise", () => {
    expect(directUploadLockLimits()).toEqual({ poolMax: 5, heavyMax: 3, shortMax: 2, shortPerOrg: 1, sharedMax: 2, batchMax: 1, batchPerOrg: 1, startMax: 1, startPerOrg: 1, intakeMax: 1, intakePerOrg: 1, reconcileMax: 1 });
    lockEnv.directUploadLockPoolMax = 3; // below the minimum: raised to it
    expect(directUploadLockLimits()).toMatchObject({ poolMax: 5, heavyMax: 3 });
    lockEnv.directUploadLockPoolMax = 8;
    expect(directUploadLockLimits()).toEqual({ poolMax: 8, heavyMax: 6, shortMax: 2, shortPerOrg: 1, sharedMax: 5, batchMax: 3, batchPerOrg: 2, startMax: 2, startPerOrg: 1, intakeMax: 2, intakePerOrg: 1, reconcileMax: 1 });
    for (const pool of [5, 6, 8, 16, 64]) {
      lockEnv.directUploadLockPoolMax = pool;
      const limits = directUploadLockLimits();
      // Short work and the heavy classes partition the pool; the reconciler's slot is never shared.
      expect(limits.shortMax + limits.heavyMax).toBe(limits.poolMax);
      expect(limits.sharedMax + limits.reconcileMax).toBe(limits.heavyMax);
      for (const cap of [limits.batchMax, limits.startMax, limits.intakeMax]) expect(cap).toBeGreaterThanOrEqual(1);
      for (const cap of [limits.batchMax, limits.startMax, limits.intakeMax]) expect(cap).toBeLessThanOrEqual(limits.sharedMax);
      expect(limits.shortPerOrg).toBeLessThan(limits.shortMax);
    }
    delete lockEnv.directUploadLockPoolMax;
  });

  it("at the default pool, keeps every class within its partition and the reconciler's slot free", async () => {
    vi.useFakeTimers();
    try {
      setup();
      const refused: string[] = [];
      const attempt = (name: string, options: Parameters<typeof reserveDirectUploadLockConnection>[0]) =>
        reserveDirectUploadLockConnection({ ...options, deadline: Date.now() + 2_500 }).catch(() => { refused.push(name); return null; });
      const batch = await reserveDirectUploadLockConnection({ lockClass: "batch", tenant: "org-a" });
      const start = await reserveDirectUploadLockConnection({ lockClass: "start", tenant: "org-b" });
      // The two shared slots are taken: an intake and another batch wait, then give up.
      const intake = attempt("intake", { lockClass: "intake", tenant: "org-c" });
      const batch2 = attempt("batch", { lockClass: "batch", tenant: "org-d" });
      // The reconciler's slot is still free, and short work has its own two connections (one per organization).
      const reconcile = await reserveDirectUploadLockConnection({ lockClass: "reconcile" });
      const shortX = await reserveDirectUploadLockConnection({ tenant: "org-x" });
      const shortX2 = attempt("short-same-org", { tenant: "org-x" });
      const shortY = await reserveDirectUploadLockConnection({ tenant: "org-y" });
      const shortZ = attempt("short-full", { tenant: "org-z" });
      await vi.advanceTimersByTimeAsync(2_600);
      await Promise.all([intake, batch2, shortX2, shortZ]);
      expect(refused.sort()).toEqual(["batch", "intake", "short-full", "short-same-org"]);
      // A released shared slot goes to the next waiter of any shared class.
      const waiting = reserveDirectUploadLockConnection({ lockClass: "intake", tenant: "org-c", deadline: Date.now() + 5_000 });
      start.release();
      const intake2 = await waiting;
      for (const lock of [batch, reconcile, shortX, shortY, intake2]) lock.release();
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
      let refused: unknown = null;
      const a2 = reserveDirectUploadLockConnection({ tenant: "org-a" }).catch(error => { refused = error; });
      const b1 = await reserveDirectUploadLockConnection({ tenant: "org-b" });
      await vi.advanceTimersByTimeAsync(2_100);
      await a2;
      expect(refused).toMatchObject({ name: "DirectUploadLockUnavailable" });
      for (const lock of [a1, b1]) lock.release();
    } finally { vi.useRealTimers(); }
  });
});
