import { expect, it } from "vitest";
import type { BackgroundTask } from "@mastra/core/background-tasks";
import { operationAttempts, executionAttempt } from "./native-attempts.js";

const task=(id:string,overrides:Partial<BackgroundTask>={}):BackgroundTask=>({id,status:"failed",toolName:"chat",toolCallId:"logical-child",args:{},agentId:"chat",runId:"root",resourceId:"owner",createdAt:new Date(),retryCount:0,maxRetries:0,timeoutMs:600000,...overrides});
it("orders distinct native attempts without replacing logical identity or accepting implicit native retries",()=>{
  const first=task("first");
  const second=task("second",{metadata:{attemptOrdinal:1,retryOf:"first",retryKey:"explicit_retry"}});
  expect(operationAttempts([second,first]).map(value=>value.id)).toEqual(["first","second"]);
  expect(operationAttempts([second,first]).every(value=>value.toolCallId==="logical-child")).toBe(true);
});
it("rejects a stale dispatch borrowing a newer task owned by the same worker",()=>{
  const old=task("old",{args:{attemptNonce:"old-nonce",attemptOrdinal:0}});
  const current=task("current",{status:"running",ownerId:"worker",args:{attemptNonce:"new-nonce",attemptOrdinal:1},metadata:{attemptOrdinal:1,retryOf:"old",retryKey:"retry"}});
  expect(()=>executionAttempt([old,current],old.args,"worker")).toThrow("native_execution_fence");
  expect(executionAttempt([old,current],current.args,"worker").id).toBe("current");
  expect(()=>executionAttempt([old,current],current.args,"another-worker")).toThrow("native_execution_fence");
});
it.each([
  [task("first"),task("duplicate")],
  [task("first"),task("gap",{metadata:{attemptOrdinal:2,retryOf:"first",retryKey:"retry"}})],
  [task("first"),task("foreign",{metadata:{attemptOrdinal:1,retryOf:"other-task",retryKey:"retry"}})],
  [task("first",{status:"running"}),task("second",{metadata:{attemptOrdinal:1,retryOf:"first",retryKey:"retry"}})],
  [task("automatic",{maxRetries:1})],
  [task("recovered",{retryCount:1})],
  [task("invalid",{metadata:{attemptOrdinal:-1}})],
  [task("invalid",{metadata:{attemptOrdinal:"0"}})],
])("rejects ambiguous, overlapping or unapproved attempt identities (%#)",(...values)=>{
  expect(()=>operationAttempts(values)).toThrow("operation_attempt_conflict");
});
