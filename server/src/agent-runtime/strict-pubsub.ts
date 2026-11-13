import { randomUUID } from "node:crypto";
import { CachingPubSub, isRunLocalTopic, cachedLogTtlMs, type PubSub, type Event, type EventCallback, type SubscribeOptions } from "@mastra/core/events";
import type { MastraServerCache } from "@mastra/core/cache";
import { operationOutputTopic } from "./operation-delivery.js";
import { OPERATION_RETENTION_MS } from "./durability-policy.js";

/** Mastra's background-task dispatch topic (not exported by @mastra/core 1.81).
 * The drain test fails if a native upgrade renames it. */
export const NATIVE_DISPATCH_TOPIC = "background-tasks";

/** Mastra 1.80 CachingPubSub logs cache-write failure then delivers live-only.
 * A resumable first-party stream must instead stop before advertising that
 * output. Keep native indexing/replay; change only this persistence boundary.
 */
export class StrictCachingPubSub extends CachingPubSub {
  private dispatchStopped = false;
  private readonly dispatchGates = new Map<string, Map<EventCallback, EventCallback>>();
  constructor(private readonly transport: PubSub, private readonly durableCache: MastraServerCache, private readonly cacheTopic: (topic: string) => boolean = () => true) {
    super(transport, durableCache, { shouldCache: cacheTopic });
  }
  /** Work-claiming deliveries on the native background-task dispatch topics
   * (the shared worker group and this process's own topic). Cancellation and
   * results still pass, so running tasks stay cancellable while draining. */
  private static claimsWork(topic: string, event: Event) {
    return (topic === NATIVE_DISPATCH_TOPIC || topic.startsWith(`${NATIVE_DISPATCH_TOPIC}:`)) &&
      ["task.dispatch", "task.restart", "task.resume"].includes(event.type);
  }
  override async subscribe(topic: string, cb: EventCallback, options?: SubscribeOptions) {
    if (topic !== NATIVE_DISPATCH_TOPIC && !topic.startsWith(`${NATIVE_DISPATCH_TOPIC}:`)) return super.subscribe(topic, cb, options);
    // A stopped worker never hands a claim to the native manager. It returns
    // the delivery unacknowledged (nack: republished for the group, which this
    // worker is leaving, so a live sibling takes it at once); without nack the
    // entry stays pending for a sibling's idle reclaim. Native recovery remains
    // the backstop for a dispatch that is lost either way.
    const gated: EventCallback = (event, ack, nack, ...rest) => {
      if (!this.dispatchStopped || !StrictCachingPubSub.claimsWork(topic, event)) return cb(event, ack, nack, ...rest);
      // Only the shared group can hand it elsewhere; a process topic would loop back here.
      return nack && topic === NATIVE_DISPATCH_TOPIC ? nack() : Promise.resolve();
    };
    const gates = this.dispatchGates.get(topic) ?? new Map<EventCallback, EventCallback>();
    gates.set(cb, gated);this.dispatchGates.set(topic, gates);
    return super.subscribe(topic, gated, options);
  }
  override async unsubscribe(topic: string, cb: EventCallback) {
    const gated = this.dispatchGates.get(topic)?.get(cb);
    if (!gated) return super.unsubscribe(topic, cb);
    this.dispatchGates.get(topic)!.delete(cb);
    return super.unsubscribe(topic, gated);
  }
  /** Stop claiming new native tasks: refuse further claims at once, then leave
   * the shared worker group so new work goes to other workers. Idempotent. */
  async stopDispatch() {
    this.dispatchStopped = true;
    const shared = [...this.dispatchGates.get(NATIVE_DISPATCH_TOPIC)?.values() ?? []];
    await Promise.allSettled(shared.map(gated => super.unsubscribe(NATIVE_DISPATCH_TOPIC, gated)));
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
