import { randomUUID } from "node:crypto";
import { CachingPubSub, isRunLocalTopic, cachedLogTtlMs, type PubSub, type Event } from "@mastra/core/events";
import type { MastraServerCache } from "@mastra/core/cache";
import { operationOutputTopic } from "./operation-delivery.js";
import { OPERATION_RETENTION_MS } from "./durability-policy.js";

/** Mastra 1.80 CachingPubSub logs cache-write failure then delivers live-only.
 * A resumable first-party stream must instead stop before advertising that
 * output. Keep native indexing/replay; change only this persistence boundary.
 */
export class StrictCachingPubSub extends CachingPubSub {
  constructor(private readonly transport: PubSub, private readonly durableCache: MastraServerCache, private readonly cacheTopic: (topic: string) => boolean = () => true) {
    super(transport, durableCache, { shouldCache: cacheTopic });
  }
  override async publish(topic: string, event: Omit<Event, "id" | "createdAt">, options?: { localOnly?: boolean }) {
    if (options?.localOnly || isRunLocalTopic(topic) || !this.cacheTopic(topic)) return this.transport.publish(topic, event, options);
    const fullEvent = { ...event, id: randomUUID(), createdAt: new Date() };
    const ttl = topic.startsWith(operationOutputTopic("")) ? OPERATION_RETENTION_MS : cachedLogTtlMs(topic);
    const index = await this.durableCache.listPushIndexed(`pubsub:${topic}`, `pubsub:${topic}:counter`, fullEvent, ttl);
    await this.transport.publish(topic, { ...fullEvent, index }, options);
  }
}

/** Wrap the native atomic append script, adding an atomic byte quota. Native
 * Redis cache has TTL but no byte limit; Redis Streams MAXLEN does not limit
 * its separate replay cache. No new queue, journal or replay algorithm.
 */
export function boundedNativeCacheScript(nativeScript: string) {
  return `
local used=tonumber(redis.call('GET',KEYS[3]) or '0')
local size=string.len(ARGV[1])
if size>524288 or used+size>tonumber(ARGV[3]) then return redis.error_reply('native_cache_byte_limit') end
local function native_append()
${nativeScript}
end
local index=native_append()
redis.call('SET',KEYS[3],used+size)
local ttl=tonumber(ARGV[2])
if ttl>0 then redis.call('EXPIRE',KEYS[3],ttl) end
return index
`;
}
