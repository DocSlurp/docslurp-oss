import { expect, it, vi } from "vitest";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { EventEmitterPubSub } from "@mastra/core/events";
import { InMemoryServerCache } from "@mastra/core/cache";
import { StrictCachingPubSub } from "./strict-pubsub.js";
import { NativeOperations, type NativeOperationPolicy } from "./native-operations.js";

it("uses native persistent identity for lost ACK recovery and rejects revoked observers before reading output",async()=>{
  const pubsub=new StrictCachingPubSub(new EventEmitterPubSub(),new InMemoryServerCache());
  const host=new Mastra({storage:new InMemoryStore(),pubsub,workers:false,backgroundTasks:{enabled:true,mode:"producer",recoverStaleTasksOnStart:false}});
  let allowed=true;let tail=Promise.resolve();
  const policy:NativeOperationPolicy={
    authorize:async id=>{if(!allowed||id!=="op")throw new Error("forbidden");return {id,rootId:id,userId:"u",orgId:"o",workspaceId:"w",deadline:new Date(Date.now()+60000)};},
    serializeAcceptance:async(_binding,work)=>{const preceding=tail;let release!:()=>void;tail=new Promise(resolve=>{release=resolve;});await preceding;try{return await work();}finally{release();}},
    redispatchPending:async()=>{},
    recordCancellation:async()=>{},
  };
  try {
    const manager=host.backgroundTaskManager!;
    const operations=new NativeOperations(manager,pubsub,policy);
    const a=await operations.launch("op");const b=await operations.launch("op");expect(b).toEqual(a);
    expect((await manager.listTasks({toolCallId:"op"})).total).toBe(1);
    const reads=vi.spyOn(pubsub,"getHistory");allowed=false;
    await expect(operations.read("op",0)).rejects.toThrow("forbidden");expect(reads).not.toHaveBeenCalled();
    await expect(operations.cancel("op","task")).rejects.toThrow("forbidden");
  } finally {await host.shutdown();}
});
