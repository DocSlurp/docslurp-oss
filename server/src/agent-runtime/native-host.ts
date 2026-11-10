import { startNativeRecovery } from "./recovery.js";
import { StrictCachingPubSub, boundedNativeCacheScript } from "./strict-pubsub.js";
import type { BackgroundTaskManager } from "@mastra/core/background-tasks";
import { Agent } from "@mastra/core/agent";
import { EventedAgent } from "@mastra/core/agent/durable";
import { Mastra } from "@mastra/core/mastra";
import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";
import { RedisServerCache, nodeRedisPreset, type RedisClient } from "@mastra/redis";
import { RedisStreamsPubSub, type RedisStreamsPubSubConfig } from "@mastra/redis-streams";
import { createClient } from "redis";
import type { Pool } from "pg";
import { OPERATION_RETENTION_MS, verifyDurableRedis } from "./durability-policy.js";

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
  let url: URL;
  try { url = new URL(options.redisUrl); } catch { throw new Error("native_chat_shared_transport_required"); }
  if (!["redis:", "rediss:"].includes(url.protocol)) throw new Error("native_chat_shared_transport_required");
  const storage = new PostgresStore({ id: "docslurp-chat", pool: options.pool,
    schemaName: "docslurp_mastra", disableInit: true });
  const io = new AbortController();
  const redisClients = new Set<ReturnType<typeof createClient>>();
  const forceClose = () => {
    io.abort();
    for (const connection of redisClients) { try { connection.destroy(); } catch {} }
  };
  const trackRedis = (connection: ReturnType<typeof createClient>) => {
    io.signal.throwIfAborted();
    redisClients.add(connection);
    connection.on("end", () => redisClients.delete(connection));
    connection.on("ready", () => {
      if (io.signal.aborted) connection.destroy(); else redisClients.add(connection);
    });
    const duplicate = connection.duplicate.bind(connection);
    connection.duplicate = ((...args: Parameters<typeof duplicate>) => trackRedis(duplicate(...args) as unknown as ReturnType<typeof createClient>)) as typeof connection.duplicate;
    return connection;
  };
  const client = trackRedis(createClient({ url: options.redisUrl, disableOfflineQueue: true,
    commandOptions: { abortSignal: io.signal, timeout: 2000 }, socket: { connectTimeout: 1000 } }));
  // No payloads, credentials or connection URLs in logs.
  client.on("error", () => {});
  let startupMastra: Mastra | undefined;
  let startupTransport: RedisStreamsPubSub | undefined;
  let startupTimer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_resolve, reject) => {
    startupTimer = setTimeout(() => { forceClose(); reject(new Error("native_chat_startup_timeout")); }, 10_000);
    startupTimer.unref();
  });
  const initialize = async () => {
    await client.connect();
    io.signal.throwIfAborted();
    await verifyDurableRedis(client);
    io.signal.throwIfAborted();
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
      }, keyPrefix: `${namespace}:cache:`, ttlSeconds: OPERATION_RETENTION_MS / 1000,
    });
    const transportClient = trackRedis(createClient({ url: options.redisUrl, disableOfflineQueue: true,
      commandOptions: { abortSignal: io.signal, timeout: 2000 }, socket: { connectTimeout: 1000 } }));
    // redis-streams declares node-redis 5 types; project uses compatible 6.
    // The injected client's public duplicate/destroy/command API is tested below.
    const transport = new RedisStreamsPubSub({ client: transportClient as unknown as RedisStreamsPubSubConfig["client"],
      keyPrefix: `${namespace}:events`, maxStreamLength: 4096, streamIdleTtlMs: OPERATION_RETENTION_MS });
    startupTransport = transport;
    const pubsub = new StrictCachingPubSub(transport, cache, topic => topic.startsWith("agent.stream."));
    const memory = new Memory({ storage, options: { lastMessages: 20,
      semanticRecall: false, workingMemory: { enabled: false } } });
    const agent = options.createAgent ? new EventedAgent({ agent: options.createAgent(memory), cache, pubsub,
      cleanupTimeoutMs: OPERATION_RETENTION_MS }) : undefined;
    const mastra = new Mastra({ agents: agent ? { chat: agent } : {}, storage, cache, pubsub,
      workers: options.worker ? undefined : false,
      // A dead model invocation is not silently retried/charged on restart.
      // Explicit authorized recovery can invoke the native recover API.
      recovery: { workflows: "off", durableAgents: "off" },
      backgroundTasks: { enabled: true, mode: options.worker ? "worker" : "producer", globalConcurrency: 8, perAgentConcurrency: 8,
        backpressure: "queue", defaultTimeoutMs: 600000, recoverStaleTasksOnStart: false,
        defaultRetries: { maxRetries: 0 }, cleanup: { completedTtlMs: OPERATION_RETENTION_MS, failedTtlMs: OPERATION_RETENTION_MS } },
    });
    startupMastra = mastra;
    if (options.configureBackgroundTasks) options.configureBackgroundTasks(mastra.backgroundTaskManager!, pubsub);
    await mastra.backgroundTaskManager!.init(pubsub);
    io.signal.throwIfAborted();
    const stopRecovery = options.worker ? startNativeRecovery(options.pool, options.redisUrl, namespace) : undefined;
    let closing: Promise<void> | undefined;
    return { mastra, agent, storage, memory, pubsub, cache,
      close() {
        return closing ??= (async () => {
          // One deadline starts before recovery cancellation and native shutdown.
          // Expiry destroys underlying Redis I/O, including duplicated readers;
          // it does not leave a timed-out publish queued for later reconnect.
          const timer = setTimeout(forceClose, 5000);
          try {
            await Promise.allSettled([stopRecovery?.(), mastra.shutdown({ drainTimeout: 5000 })]);
            await transport.close();
            if (client.isOpen) await client.quit();
          } finally { clearTimeout(timer); forceClose(); }
        })();
      } };
  };
  try { return await Promise.race([initialize(), expired]); }
  catch (error) {
    forceClose();
    // Cleanup cannot extend a failed startup indefinitely. All Redis I/O is
    // already aborted; the caller owns the bounded PostgreSQL pool.
    const cleanup = Promise.allSettled([startupMastra?.shutdown({ drainTimeout: 0 }), startupTransport?.close()]);
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([cleanup, new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(cleanupTimer); }
    throw error;
  } finally { clearTimeout(startupTimer!); }
}
