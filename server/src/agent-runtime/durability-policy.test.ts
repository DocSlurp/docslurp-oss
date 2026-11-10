import { expect, it, vi } from "vitest";
import { durableRedisUrl, verifyDurableRedis } from "./durability-policy.js";

const settings = () => ({ appendonly: "yes", appendfsync: "always", "no-appendfsync-on-rewrite": "no", "maxmemory-policy": "noeviction", maxmemory: "268435456" });
const persistence = "loading:0\r\naof_enabled:1\r\naof_last_write_status:ok\r\naof_last_bgrewrite_status:ok\r\naof_current_size:100\r\naof_base_size:100\r\naof_rewrite_in_progress:0\r\naof_rewrite_scheduled:0\r\n";
const reader = (config = settings(), info = persistence, role = "master") => ({
  configGet: vi.fn(async () => config),
  info: vi.fn(async (section: string) => section === "replication" ? `role:${role}\r\n` : info),
});

it("requires the explicit durable endpoint rather than a limiter cache", () => {
  expect(() => durableRedisUrl({ API_RATE_LIMIT_REDIS_URL: "redis://127.0.0.1:6379" })).toThrow("native_chat_shared_transport_required");
  expect(durableRedisUrl({ MASTRA_REDIS_URL: "rediss://durable.example.test:6379", API_RATE_LIMIT_REDIS_URL: "redis://limiter.example.test:6379" })).toBe("rediss://durable.example.test:6379");
});
it("accepts a bounded, non-evicting writable backend with healthy synchronous AOF", async () => {
  await expect(verifyDurableRedis(reader())).resolves.toBeUndefined();
});
it.each([
  { appendonly: "no" }, { appendfsync: "everysec" }, { "no-appendfsync-on-rewrite": "yes" },
  { "maxmemory-policy": "allkeys-lru" }, { maxmemory: "0" }, { maxmemory: "invalid" },
])("refuses weaker persistence or unbounded capacity: %j", async delta => {
  await expect(verifyDurableRedis(reader({ ...settings(), ...delta }))).rejects.toThrow("native_chat_durable_redis_required");
});
it.each([
  persistence.replace("aof_enabled:1", "aof_enabled:0"),
  persistence.replace("aof_last_write_status:ok", "aof_last_write_status:err"),
  persistence.replace("aof_last_bgrewrite_status:ok", "aof_last_bgrewrite_status:err"),
  persistence.replace("loading:0", "loading:1"), "",
  persistence.replace("aof_base_size:100", "aof_base_size:0").replace("aof_rewrite_in_progress:0", "aof_rewrite_in_progress:1"),
])("refuses unhealthy or unavailable persistence evidence (%#)", async info => {
  await expect(verifyDurableRedis(reader(settings(), info))).rejects.toThrow("native_chat_durable_redis_required");
});
it("accepts a fresh empty AOF and an established base during compaction", async () => {
  await expect(verifyDurableRedis(reader(settings(), persistence.replace("aof_base_size:100", "aof_base_size:0").replace("aof_current_size:100", "aof_current_size:0")))).resolves.toBeUndefined();
  await expect(verifyDurableRedis(reader(settings(), persistence.replace("aof_rewrite_in_progress:0", "aof_rewrite_in_progress:1")))).resolves.toBeUndefined();
});
it("refuses a replica and redacts policy-inspection failures", async () => {
  await expect(verifyDurableRedis(reader(settings(), persistence, "slave"))).rejects.toThrow("native_chat_durable_redis_required");
  const client = reader();
  client.configGet.mockRejectedValue(new Error("NOPERM redis://user:must-not-leak@private.example.test"));
  try { await verifyDurableRedis(client); throw new Error("unexpected success"); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("native_chat_durable_redis_required");
    expect((error as Error).cause).toBeUndefined();
  }
});
