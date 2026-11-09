import { expect, it, vi } from "vitest";
import { EventEmitterPubSub, cachedLogTtlMs } from "@mastra/core/events";
import { InMemoryServerCache } from "@mastra/core/cache";
import { StrictCachingPubSub } from "./strict-pubsub.js";
import { operationOutputTopic } from "./operation-delivery.js";
it("never delivers unpersisted output after native cache failure",async()=>{
  const transport=new EventEmitterPubSub();const cache=new InMemoryServerCache();
  const pubsub=new StrictCachingPubSub(transport,cache);const received=vi.fn();
  await pubsub.subscribe("test",received);
  vi.spyOn(cache,"listPushIndexed").mockRejectedValueOnce(new Error("storage down"));
  await expect(pubsub.publish("test",{type:"chunk",runId:"run",data:{text:"must not leak"}})).rejects.toThrow("storage down");
  expect(received).not.toHaveBeenCalled();expect(await pubsub.getHistory("test")).toEqual([]);
  await pubsub.unsubscribe("test",received);
});
it("keeps native indexed replay after the publishing observer detaches",async()=>{
  const pubsub=new StrictCachingPubSub(new EventEmitterPubSub(),new InMemoryServerCache());
  await pubsub.publish("test",{type:"chunk",runId:"run",data:{text:"saved"}});
  const received=vi.fn();await pubsub.subscribeFromOffset("test",0,received);
  expect(received.mock.calls[0]?.[0]).toMatchObject({index:0,data:{text:"saved"}});
  await pubsub.unsubscribe("test",received);
});
it("retains accepted application output for seven days without changing other native topics", async () => {
  const cache = new InMemoryServerCache();
  const append = vi.spyOn(cache, "listPushIndexed");
  const pubsub = new StrictCachingPubSub(new EventEmitterPubSub(), cache);
  await pubsub.publish(operationOutputTopic("retention-test"), { type: "chunk", runId: "retention-test", data: { text: "partial answer" } });
  expect(append.mock.calls[0]?.[3]).toBe(7 * 86_400_000);
  const otherTopic = "agent.stream.other-owner";
  await pubsub.publish(otherTopic, { type: "chunk", runId: "other-owner", data: {} });
  expect(append.mock.calls[1]?.[3]).toBe(cachedLogTtlMs(otherTopic));
});
