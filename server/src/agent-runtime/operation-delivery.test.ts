import { expect, it } from "vitest";
import { InMemoryServerCache } from "@mastra/core/cache";
import { EventEmitterPubSub } from "@mastra/core/events";
import type { BackgroundTask } from "@mastra/core/background-tasks";
import { StrictCachingPubSub } from "./strict-pubsub.js";
import { operationOutputTopic, publishOperationOutput, readNativeOperationOutput } from "./operation-delivery.js";
const task: BackgroundTask={id:"task",status:"running",toolName:"chat",toolCallId:"op",args:{},agentId:"chat",runId:"root",resourceId:"owner",createdAt:new Date(),retryCount:0,maxRetries:0,timeoutMs:600000};
const bus=()=>new StrictCachingPubSub(new EventEmitterPubSub(),new InMemoryServerCache());
it("uses native event indices for last-applied replay and retains text across non-text events",async()=>{
  const pubsub=bus();
  await publishOperationOutput(pubsub,task.id,{kind:"text",payload:{text:"first "}});
  await publishOperationOutput(pubsub,task.id,{kind:"tool",payload:{status:"completed"}});
  await publishOperationOutput(pubsub,task.id,{kind:"text",payload:{text:"second"}});
  const recovery=await readNativeOperationOutput(pubsub,task,1);
  expect(recovery.snapshot).toEqual({text:"first second",tools:[{status:"completed"}]});
  expect(recovery.events.map(event=>event.sequence)).toEqual([2,3]);
  expect(recovery.watermark).toBe(3);expect(recovery.hasMore).toBe(false);
  expect((await readNativeOperationOutput(pubsub,task,99)).resync).toBe(true);
  await expect(readNativeOperationOutput(pubsub,task,-1)).rejects.toThrow("invalid_cursor");
});
it("recovers terminal result/citations from native task storage when event retention expires",async()=>{
  const pubsub=bus();const completed:BackgroundTask={...task,status:"completed",result:{result:{answer:"retained",citations:[{documentId:"doc"}]},watermark:7}};
  const recovery=await readNativeOperationOutput(pubsub,completed,2);
  expect(recovery).toMatchObject({resync:true,events:[],watermark:7,snapshot:{answer:"retained",citations:[{documentId:"doc"}]}});
  await expect(readNativeOperationOutput(pubsub,task,2)).rejects.toThrow("output_history_unavailable");
});
it("never mistakes missing cached indices for a complete active answer",async()=>{
  const cache=new InMemoryServerCache();const pubsub=new StrictCachingPubSub(new EventEmitterPubSub(),cache);
  await publishOperationOutput(pubsub,task.id,{kind:"text",payload:{text:"first"}});
  await cache.increment(`pubsub:${operationOutputTopic(task.id)}:counter`);
  await publishOperationOutput(pubsub,task.id,{kind:"text",payload:{text:"third"}});
  await expect(readNativeOperationOutput(pubsub,task,0)).rejects.toThrow("output_history_gap");
  expect(await readNativeOperationOutput(pubsub,{...task,status:"completed",result:{result:{answer:"authoritative"},watermark:4}},0))
    .toMatchObject({resync:true,events:[],watermark:4,snapshot:{answer:"authoritative"}});
});
it("keeps terminal tool outcomes after cache expiry and distinguishes no output yet from missing output",async()=>{
  const pubsub=bus();
  const result={answer:"done",tools:[{tool:"search",status:"completed"}],citations:[{documentId:"doc"}]};
  expect((await readNativeOperationOutput(pubsub,{...task,status:"completed",result:{result,watermark:4}},1)).snapshot).toEqual(result);
  expect((await readNativeOperationOutput(pubsub,task,0,false)).snapshot).toMatchObject({text:"",tools:[]});
  await expect(readNativeOperationOutput(pubsub,task,0,true)).rejects.toThrow("output_history_unavailable");
});
