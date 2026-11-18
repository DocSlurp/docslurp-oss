import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  release: vi.fn(), end: vi.fn(async () => {}), create: vi.fn(), reserve: vi.fn(),
  env: { databaseUrl: "postgres://lock-test" } as Record<string, unknown>,
}));
vi.mock("../config.js", () => ({ env: mocks.env }));
vi.mock("../lib/api-pool.js", () => ({ createApiPool: mocks.create }));
import { closeDirectUploadLockPool, directUploadLockLimits, reserveDirectUploadLockConnection } from "../lib/direct-upload-locks.js";
afterEach(async () => {
  await closeDirectUploadLockPool();
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.env)) if (key !== "databaseUrl") delete mocks.env[key];
});
function setup() {
  mocks.reserve.mockResolvedValue({release:mocks.release});
  mocks.create.mockReturnValue({sql:{reserve:mocks.reserve,end:mocks.end}});
}
describe("separate direct upload lock connections", () => {
  it("uses a lazy bounded pool separate from intake query connections", async () => {
    setup();
    const lock = await reserveDirectUploadLockConnection();
    expect(mocks.create).toHaveBeenCalledWith("postgres://lock-test", {max:6,applicationName:"docslurp-upload-locks"});
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
});

describe("lock classes and deadlines", () => {
  it("caps batch holders per organization and per process while short operations keep a connection", async () => {
    vi.useFakeTimers();
    // Pool 8: 2 wave, 1 reconcile, 4 batch, the rest short.
    mocks.env.directUploadLockPoolMax = 8;
    try {
      setup();
      const a1 = await reserveDirectUploadLockConnection({ lockClass: "batch", orgId: "org-a" });
      const a2 = await reserveDirectUploadLockConnection({ lockClass: "batch", orgId: "org-a" });
      // A third holder for the same organization waits for a slot, then gives up on its deadline.
      let refused: unknown = null;
      const a3 = reserveDirectUploadLockConnection({ lockClass: "batch", orgId: "org-a", deadline: Date.now() + 3_000 }).catch(error => { refused = error; });
      // Another organization and a short operation are not starved by org-a's batches.
      const b1 = await reserveDirectUploadLockConnection({ lockClass: "batch", orgId: "org-b" });
      const short = await reserveDirectUploadLockConnection();
      await vi.advanceTimersByTimeAsync(3_100);
      await a3;
      expect(refused).toMatchObject({ name: "DirectUploadLockUnavailable" });
      // The process has 4 batch slots here: the fourth fills them.
      const b2 = await reserveDirectUploadLockConnection({ lockClass: "batch", orgId: "org-b" });
      let processFull: unknown = null;
      const c1 = reserveDirectUploadLockConnection({ lockClass: "batch", orgId: "org-c" }).catch(error => { processFull = error; });
      await vi.advanceTimersByTimeAsync(2_100);
      await c1;
      expect(processFull).toMatchObject({ name: "DirectUploadLockUnavailable" });
      // Short operations and the reconciler still get connections with every batch slot taken.
      const reconcile = await reserveDirectUploadLockConnection({ lockClass: "reconcile" });
      const short2 = await reserveDirectUploadLockConnection();
      // A released slot is handed to the next waiter.
      const waiting = reserveDirectUploadLockConnection({ lockClass: "batch", orgId: "org-c", deadline: Date.now() + 5_000 });
      a1.release();
      const c2 = await waiting;
      for (const lock of [a2, b1, short, b2, reconcile, short2, c2]) lock.release();
    } finally { vi.useRealTimers(); }
  });

  it("gives background waves their own slots: two uploads' waves hold at once beside the sweep and batches", async () => {
    vi.useFakeTimers();
    try {
      setup();
      expect(directUploadLockLimits()).toMatchObject({ poolMax: 6, waveMax: 2, wavePerOrg: 2, reconcileMax: 1, batchMax: 2 });
      // The sweep and a batch hold their own classes; neither takes a wave slot.
      const reconcile = await reserveDirectUploadLockConnection({ lockClass: "reconcile" });
      const batch = await reserveDirectUploadLockConnection({ lockClass: "batch", orgId: "org-a" });
      // Two uploads of one organization start waves at once.
      const first = await reserveDirectUploadLockConnection({ lockClass: "wave", orgId: "org-a" });
      const second = await reserveDirectUploadLockConnection({ lockClass: "wave", orgId: "org-a" });
      // The process cap holds: a third wave waits for a slot and gives up on its deadline.
      let refused: unknown = null;
      const third = reserveDirectUploadLockConnection({ lockClass: "wave", orgId: "org-b", deadline: Date.now() + 2_500 }).catch(error => { refused = error; });
      // Short operations keep a connection with every capped slot taken.
      const short = await reserveDirectUploadLockConnection();
      await vi.advanceTimersByTimeAsync(2_600);
      await third;
      expect(refused).toMatchObject({ name: "DirectUploadLockUnavailable" });
      // A released wave slot goes to the next waiter.
      const waiting = reserveDirectUploadLockConnection({ lockClass: "wave", orgId: "org-b", deadline: Date.now() + 5_000 });
      first.release();
      const next = await waiting;
      for (const lock of [reconcile, batch, second, short, next]) lock.release();
    } finally { vi.useRealTimers(); }
  });

  it("caps waves per organization: another organization's upload is not queued behind one tenant's", async () => {
    vi.useFakeTimers();
    mocks.env.directUploadLockWavePerOrg = 1;
    try {
      setup();
      const a1 = await reserveDirectUploadLockConnection({ lockClass: "wave", orgId: "org-a" });
      let refused: unknown = null;
      const a2 = reserveDirectUploadLockConnection({ lockClass: "wave", orgId: "org-a", deadline: Date.now() + 2_500 }).catch(error => { refused = error; });
      const b1 = await reserveDirectUploadLockConnection({ lockClass: "wave", orgId: "org-b" });
      await vi.advanceTimersByTimeAsync(2_600);
      await a2;
      expect(refused).toMatchObject({ name: "DirectUploadLockUnavailable" });
      for (const lock of [a1, b1]) lock.release();
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
      const pending = reserveDirectUploadLockConnection({ deadline: Date.now() + 2_500 }).catch(error => { refused = error; });
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
});
