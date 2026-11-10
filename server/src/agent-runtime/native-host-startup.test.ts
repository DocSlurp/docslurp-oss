import type { Pool } from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  init: vi.fn<(...args: unknown[]) => Promise<void>>(),
  shutdown: vi.fn(async () => {}),
  connectStalled: false,
  recover: vi.fn(() => async () => {}),
  clients: [] as Array<{ isOpen: boolean; connect: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>,
}));
vi.mock("redis", () => ({ createClient: () => {
  const client = {
    isOpen: false,
    on: vi.fn(),
    duplicate: vi.fn(),
    connect: vi.fn(async () => { client.isOpen = true; if (state.connectStalled) await new Promise<void>(() => {}); }),
    quit: vi.fn(async () => { client.isOpen = false; }),
    destroy: vi.fn(() => { client.isOpen = false; }),
    eval: vi.fn(async () => 1),
    configGet: vi.fn(async () => ({ appendonly: "yes", appendfsync: "always", "no-appendfsync-on-rewrite": "no", "maxmemory-policy": "noeviction", maxmemory: "268435456" })),
    info: vi.fn(async (section: string) => section === "replication" ? "role:master\r\n" : "aof_enabled:1\r\naof_last_write_status:ok\r\naof_last_bgrewrite_status:ok\r\naof_current_size:100\r\naof_base_size:100\r\naof_rewrite_in_progress:0\r\naof_rewrite_scheduled:0\r\nloading:0\r\n"),
  };
  state.clients.push(client);
  return client;
} }));
vi.mock("@mastra/pg", () => ({ PostgresStore: class {} }));
vi.mock("@mastra/memory", () => ({ Memory: class {} }));
vi.mock("@mastra/redis", () => ({ RedisServerCache: class {}, nodeRedisPreset: {} }));
vi.mock("@mastra/redis-streams", () => ({ RedisStreamsPubSub: class { async close() {} } }));
vi.mock("./recovery.js", () => ({ startNativeRecovery: state.recover }));
vi.mock("@mastra/core/mastra", () => ({ Mastra: class {
  backgroundTaskManager = { init: state.init };
  shutdown = state.shutdown;
  constructor(options: { pubsub: unknown }) {
    // Installed Mastra starts initialization and logs/catches its rejection.
    // The host must await the same barrier rather than relying on construction.
    void state.init(options.pubsub).catch(() => {});
  }
} }));
import { createNativeChatHost } from "./native-host.js";

const hosts: Array<Awaited<ReturnType<typeof createNativeChatHost>>> = [];
beforeEach(() => { state.clients.length = 0; state.connectStalled = false; state.init.mockReset(); state.shutdown.mockClear(); state.recover.mockClear(); });
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); vi.useRealTimers(); });

it("does not return a ready host until native initialization settles", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  state.init.mockReturnValue(pending);
  let settled = false;
  const starting = createNativeChatHost({ pool: {} as Pool, redisUrl: "redis://127.0.0.1:6379", worker: false });
  void starting.then(host => { hosts.push(host); settled = true; });
  await vi.waitFor(() => expect(state.init).toHaveBeenCalled());
  const readyBeforeInitialization = settled;
  release();
  await starting;
  expect(readyBeforeInitialization).toBe(false);
});

it("refuses readiness and closes Redis resources when native initialization fails", async () => {
  state.init.mockRejectedValue(new Error("native initialization refused"));
  let accepted: Awaited<ReturnType<typeof createNativeChatHost>> | undefined;
  try {
    await expect(createNativeChatHost({ pool: {} as Pool, redisUrl: "redis://127.0.0.1:6379", worker: false }).then(host => { accepted = host; })).rejects.toThrow();
    expect(state.clients.every(client => !client.isOpen)).toBe(true);
  } finally { if (accepted) await accepted.close(); }
});

it.each(["connect", "native-init"])("bounds stalled %s and destroys owned Redis I/O", async stage => {
  vi.useFakeTimers();
  state.connectStalled = stage === "connect";
  state.init.mockImplementation(() => new Promise<void>(() => {}));
  const starting = createNativeChatHost({ pool: {} as Pool, redisUrl: "redis://127.0.0.1:6379", worker: false });
  const rejected = expect(starting).rejects.toThrow("native_chat_startup_timeout");
  await vi.advanceTimersByTimeAsync(10_001);
  await rejected;
  expect(state.clients.every(client => !client.isOpen && client.destroy.mock.calls.length > 0)).toBe(true);
  if (stage === "connect") expect(state.init).not.toHaveBeenCalled();
});

it("does not start recovery if native initialization resolves after its deadline", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const init = new Promise<void>(resolve => { release = resolve; });
  state.init.mockReturnValue(init);
  const starting = createNativeChatHost({ pool: {} as Pool, redisUrl: "redis://127.0.0.1:6379", worker: true });
  const rejected = expect(starting).rejects.toThrow("native_chat_startup_timeout");
  await vi.advanceTimersByTimeAsync(10_001);
  await rejected;
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.recover).not.toHaveBeenCalled();
  expect(state.shutdown).toHaveBeenCalled();
  expect(state.clients.every(client => !client.isOpen)).toBe(true);
});
