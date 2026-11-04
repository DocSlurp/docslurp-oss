import { expect, it, vi } from "vitest";
import { EventEmitterPubSub } from "@mastra/core/events";
import { InMemoryServerCache } from "@mastra/core/cache";
import { StrictCachingPubSub } from "./strict-pubsub.js";
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
