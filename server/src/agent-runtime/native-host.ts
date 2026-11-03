import { startNativeRecovery } from "./recovery.js";
import { StrictCachingPubSub, boundedNativeCacheScript } from "./strict-pubsub.js";
import type { BackgroundTaskManager } from "@mastra/core/background-tasks";
import { Agent } from "@mastra/core/agent";
import { EventedAgent } from "@mastra/core/agent/durable";
import { Mastra } from "@mastra/core/mastra";
import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";
import { RedisServerCache, nodeRedisPreset, type RedisClient } from "@mastra/redis";
import { RedisStreamsPubSub } from "@mastra/redis-streams";
import { createClient } from "redis";
import type { Pool } from "pg";

/** Native lifecycle host. The supplied agent must resolve policies/tools from
 * trusted persisted scope, not request closures. No custom queue or lease owner.
 * Construction is explicit; importing this module never connects or enables it.
 */
export async function createNativeChatHost(options: {
  pool: Pool;
  redisUrl: string;
  createAgent?(memory: Memory): Agent;
  configureBackgroundTasks?(manager: BackgroundTaskManager, pubsub: StrictCachingPubSub): void;
  worker: boolean;
  namespace?: string;
}) {
  const namespace = options.namespace ?? "docslurp:mastra";
  if (!/^[a-zA-Z0-9:-]{1,100}$/.test(namespace)) throw new Error("native_chat_invalid_namespace");
  const url = new URL(options.redisUrl);
  if (!["redis:", "rediss:"].includes(url.protocol)) throw new Error("native_chat_shared_transport_required");
  const storage = new PostgresStore({ id: "docslurp-chat", pool: options.pool,
    schemaName: "docslurp_mastra", disableInit: true });
  const client = createClient({ url: options.redisUrl });
  // No payloads, credentials or connection URLs in logs.
  client.on("error", () => {});
  await client.connect();
  try {
    // Refuse a backend without atomic script support before accepting paid work.
    await client.eval("return 1", { keys: [], arguments: [] });
    const cache = new RedisServerCache({ client: client as unknown as RedisClient }, {
      ...nodeRedisPreset,
      evalScript: async (_client, script, keys, args) => {
        try {
          const type = (JSON.parse(args[0]!) as { type?: string }).type;
          const limit = ["finish", "error", "abort"].includes(type ?? "") ? 2097152 : 1572864;
          return await client.eval(boundedNativeCacheScript(script), { keys: [...keys, `${keys[1]}:bytes`], arguments: [...args, String(limit)] });
        }
        catch (cause) { throw new Error("native_cache_atomic_write_failed", { cause }); }
      }, keyPrefix: `${namespace}:cache:`, ttlSeconds: 7 * 86400,
    });
    const transport = new RedisStreamsPubSub({ url: options.redisUrl,
      keyPrefix: `${namespace}:events`, maxStreamLength: 4096, streamIdleTtlMs: 7 * 86400000 });
    const pubsub = new StrictCachingPubSub(transport, cache, topic => topic.startsWith("agent.stream."));
    const memory = new Memory({ storage, options: { lastMessages: 20,
      semanticRecall: false, workingMemory: { enabled: false } } });
    const agent = options.createAgent ? new EventedAgent({ agent: options.createAgent(memory), cache, pubsub,
      cleanupTimeoutMs: 7 * 86400000 }) : undefined;
    const mastra = new Mastra({ agents: agent ? { chat: agent } : {}, storage, cache, pubsub,
      workers: options.worker ? undefined : false,
      // A dead model invocation is not silently retried/charged on restart.
      // Explicit authorized recovery can invoke the native recover API.
      recovery: { workflows: "off", durableAgents: "off" },
      backgroundTasks: { enabled: true, mode: options.worker ? "worker" : "producer", globalConcurrency: 8, perAgentConcurrency: 8,
        backpressure: "queue", defaultTimeoutMs: 600000, recoverStaleTasksOnStart: options.worker,
        defaultRetries: { maxRetries: 0 }, cleanup: { completedTtlMs: 7 * 86400000, failedTtlMs: 7 * 86400000 } },
    });
    if (options.configureBackgroundTasks) options.configureBackgroundTasks(mastra.backgroundTaskManager!, pubsub);
    const stopRecovery = options.worker ? startNativeRecovery(mastra.backgroundTaskManager!, options.pool) : undefined;
    return { mastra, agent, storage, memory, pubsub, cache,
      async close() { await stopRecovery?.(); await mastra.shutdown({ drainTimeout: 5000 }); await transport.close(); await client.quit(); } };
  } catch (error) { await client.quit().catch(() => {}); throw error; }
}
