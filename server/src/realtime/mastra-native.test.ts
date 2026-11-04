import { afterEach, expect, it } from "vitest";
import { Agent } from "@mastra/core/agent";
import { createDurableAgent, AGENT_STREAM_TOPIC } from "@mastra/core/agent/durable";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { InMemoryServerCache } from "@mastra/core/cache";
import { CachingPubSub, EventEmitterPubSub } from "@mastra/core/events";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";

let host: Mastra | undefined;
afterEach(async()=>{await host?.shutdown();host=undefined;});
function nativeAgent(){
  let executions=0;
  const model=createMockModel({version:"v2",mockText:"first second",spyStream:()=>{executions++;}});
  const cache=new InMemoryServerCache({ttlMs:60000});
  const pubsub=new CachingPubSub(new EventEmitterPubSub(),cache);
  const agent=createDurableAgent({agent:new Agent({id:"native-proof",name:"Local proof",instructions:"Return fixture text",model}),cache,pubsub,cleanupTimeoutMs:0});
  host=new Mastra({agents:{agent},storage:new InMemoryStore(),cache,pubsub});
  return {agent,pubsub,executions:()=>executions};
}
it("native replay and observer detach retain output without starting another model call",async()=>{
  const {agent,pubsub,executions}=nativeAgent();
  const started=await agent.stream("fixture",{runId:"native-replay-test",maxSteps:1});
  expect(await started.output.text).toBe("first second");
  const observer=await agent.observe(started.runId);
  observer.detach();
  const replay=await agent.observe(started.runId);
  expect(await replay.output.text).toBe("first second");
  expect(executions()).toBe(1);
  const history=await pubsub.getHistory(AGENT_STREAM_TOPIC(started.runId));
  expect(history.length).toBeGreaterThan(2);
  expect(history.every(event=>Number.isSafeInteger(event.index))).toBe(true);
  // Native offsets count lifecycle events too; chunk count cannot be a durable cursor.
  expect(history.some(event=>event.type!=="chunk")).toBe(true);
  replay.detach();
  started.cleanup();
},30000);
it("native storage alone does not reconstruct cleared replay history",async()=>{
  const {agent,pubsub}=nativeAgent();
  const started=await agent.stream("fixture",{runId:"native-cleanup-test",maxSteps:1});
  await started.output.text;
  await pubsub.clearTopic(AGENT_STREAM_TOPIC(started.runId));
  expect(await pubsub.getHistory(AGENT_STREAM_TOPIC(started.runId))).toEqual([]);
  started.cleanup();
},30000);
