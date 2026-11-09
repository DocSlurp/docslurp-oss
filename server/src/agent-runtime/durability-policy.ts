export const OPERATION_RETENTION_MS = 7 * 86_400_000;

export function durableRedisUrl(env: { MASTRA_REDIS_URL?: string; API_RATE_LIMIT_REDIS_URL?: string }) {
  if (!env.MASTRA_REDIS_URL) throw new Error("native_chat_shared_transport_required");
  return env.MASTRA_REDIS_URL;
}

type RedisPolicyReader = {
  configGet(names: string[]): Promise<Record<string, string>>;
  info(section: string): Promise<string>;
};

/** Only read policy fields, never CONFIG SET or credentials. A volatile cache
 * cannot acknowledge resumable output. Unsupported policy inspection refuses
 * startup rather than assuming a managed backend is durable.
 */
export async function verifyDurableRedis(client: RedisPolicyReader) {
  try {
    const [config, persistence, replication] = await Promise.all([
      client.configGet(["appendonly", "appendfsync", "no-appendfsync-on-rewrite", "maxmemory-policy", "maxmemory"]),
      client.info("persistence"), client.info("replication"),
    ]);
    const fields = Object.fromEntries(`${persistence}\n${replication}`.split(/\r?\n/)
      .filter(line => line.includes(":") && !line.startsWith("#"))
      .map(line => { const index = line.indexOf(":"); return [line.slice(0, index), line.slice(index + 1)]; }));
    const sizesKnown = Number.isSafeInteger(Number(fields.aof_current_size)) && Number(fields.aof_current_size) >= 0 &&
      Number.isSafeInteger(Number(fields.aof_base_size)) && Number(fields.aof_base_size) >= 0;
    // A new empty AOF is valid. During a rewrite, require an established base;
    // otherwise enabling AOF over existing memory may still be initializing.
    const aofReady = sizesKnown && ((fields.aof_rewrite_in_progress === "0" && fields.aof_rewrite_scheduled === "0") ||
      (Number(fields.aof_base_size) > 0 && Number(fields.aof_current_size) >= Number(fields.aof_base_size)));
    if (config.appendonly !== "yes" || config.appendfsync !== "always" ||
      config["no-appendfsync-on-rewrite"] !== "no" || config["maxmemory-policy"] !== "noeviction" ||
      !Number.isSafeInteger(Number(config.maxmemory)) || Number(config.maxmemory) <= 0 ||
      fields.aof_enabled !== "1" || fields.aof_last_write_status !== "ok" ||
      !aofReady ||
      fields.aof_last_bgrewrite_status !== "ok" || fields.loading !== "0" || fields.role !== "master") {
      throw new Error("policy_refused");
    }
  } catch {
    // Backend errors can contain connection details; expose only this code.
    throw new Error("native_chat_durable_redis_required");
  }
}
