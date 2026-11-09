import { expect, it, vi } from "vitest";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { EventEmitterPubSub } from "@mastra/core/events";
import { InMemoryServerCache } from "@mastra/core/cache";
import { StrictCachingPubSub } from "./strict-pubsub.js";
import { NativeOperations, type NativeOperationPolicy } from "./native-operations.js";
import { publishOperationOutput, operationOutputTopic } from "./operation-delivery.js";
import { ATTEMPT_CURSOR_STRIDE } from "./native-attempts.js";

it("uses native persistent identity for lost ACK recovery and rejects revoked observers before reading output",async()=>{
  const pubsub=new StrictCachingPubSub(new EventEmitterPubSub(),new InMemoryServerCache());
  const host=new Mastra({storage:new InMemoryStore(),pubsub,workers:false,backgroundTasks:{enabled:true,mode:"producer",recoverStaleTasksOnStart:false}});
  let allowed=true;let tail=Promise.resolve();
  const policy:NativeOperationPolicy={
    authorize:async id=>{if(!allowed||id!=="op")throw new Error("forbidden");return {id,rootId:id,parentId:null,userId:"u",orgId:"o",projectId:"w",deadline:new Date(Date.now()+60000),cancelRequested:false,treeCancelled:false};},
    listTree:async()=>["op"],
    serializeAcceptance:async(_binding,work)=>{const preceding=tail;let release!:()=>void;tail=new Promise(resolve=>{release=resolve;});await preceding;try{return await work(async()=>{});}finally{release();}},
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

it("retains native attempt output, deduplicates concurrent retry ACKs and rejects unauthorized or overlapping attempts",async()=>{
  const pubsub=new StrictCachingPubSub(new EventEmitterPubSub(),new InMemoryServerCache());
  const host=new Mastra({storage:new InMemoryStore(),pubsub,workers:false,backgroundTasks:{enabled:true,mode:"producer",recoverStaleTasksOnStart:false}});
  let allowed=true;let tail=Promise.resolve();
  const binding={id:"child",rootId:"root",parentId:"root",userId:"u",orgId:"o",projectId:"p",deadline:new Date(Date.now()+60000),cancelRequested:false,treeCancelled:false,authSessionId:"fresh-session"};
  const policy:NativeOperationPolicy={
    authorize:async()=>{if(!allowed)throw new Error("forbidden");return binding;},listTree:async()=>["child"],
    serializeAcceptance:async(_binding,work)=>{const before=tail;let release!:()=>void;tail=new Promise(resolve=>{release=resolve;});await before;try{if(!allowed)throw new Error("forbidden");return await work(async()=>{});}finally{release();}},
    recordCancellation:async()=>{},
  };
  try {
    const manager=host.backgroundTaskManager!;const storage=await manager.getStorage();
    const operations=new NativeOperations(manager,pubsub,policy);
    const initial=await operations.launch("child");
    await publishOperationOutput(pubsub,initial.taskId,{kind:"text",payload:{text:"retained partial"}});
    await storage.updateTask(initial.taskId,{status:"failed",metadata:{attemptOrdinal:0,outputExpected:true}});
    const [a,b]=await Promise.all([operations.retry("child","retry_request_1"),operations.retry("child","retry_request_1")]);
    expect(a).toEqual(b);expect(a.taskId).not.toBe(initial.taskId);expect(a.operationId).toBe(initial.operationId);
    expect((await manager.listTasks({toolCallId:"child"})).total).toBe(2);
    expect((await manager.getTask(a.taskId))?.args).toMatchObject({operationId:"child",authSessionId:"fresh-session"});
    await expect(operations.retry("child","retry_request_2")).rejects.toThrow("operation_not_retryable");
    const empty=await operations.read("child",1);
    expect(empty.watermark).toBe(ATTEMPT_CURSOR_STRIDE);expect(empty.resync).toBe(true);
    expect(empty.operation.snapshot.priorAttempts).toMatchObject([{snapshot:{text:"retained partial"}}]);
    await publishOperationOutput(pubsub,a.taskId,{kind:"text",payload:{text:"new answer"}});
    await storage.updateTask(a.taskId,{status:"completed",metadata:{attemptOrdinal:1,retryOf:initial.taskId,retryKey:"retry_request_1",outputExpected:true}});
    const current=await operations.read("child",ATTEMPT_CURSOR_STRIDE);
    expect(current.watermark).toBe(ATTEMPT_CURSOR_STRIDE+1);
    expect(current.operation.snapshot.text).toBe("new answer");
    expect(current.events.map(event=>event.sequence)).toEqual([ATTEMPT_CURSOR_STRIDE+1]);
    await pubsub.clearTopic(operationOutputTopic(initial.taskId));
    const missingPrior=await operations.read("child",current.watermark);
    expect(missingPrior.operation.snapshot.text).toBe("new answer");
    expect(missingPrior.operation.snapshot.priorAttempts).toMatchObject([{historyUnavailable:true,watermark:null,snapshot:{error:"output_history_unavailable"}}]);
    expect((await operations.retry("child","retry_request_1")).taskId).toBe(a.taskId);
    await expect(operations.retry("child","retry_request_2")).rejects.toThrow("operation_not_retryable");
    await storage.updateTask(a.taskId,{status:"failed"});
    const third=await operations.retry("child","retry_request_2");
    await storage.updateTask(third.taskId,{status:"failed"});
    await expect(operations.retry("child","retry_request_3")).rejects.toThrow("operation_attempt_limit");
    expect((await operations.retry("child","retry_request_1")).taskId).toBe(a.taskId);
    allowed=false;
    await expect(operations.retry("child","retry_request_1")).rejects.toThrow("forbidden");
    expect((await manager.listTasks({toolCallId:"child"})).total).toBe(3);
  }finally{await host.shutdown();}
});
