import { it, expect, vi } from "vitest";
import { describeVideoChunk } from "./video-processing.js";
import { videoPolicy } from "./video-policy.js";
import { mediaConfig } from "./config.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { runSpentCents } from "../pipeline/checkpoints.js";
import type { WorkspaceRun } from "../models.js";
import type { MediaJournal, MediaReceipt } from "./types.js";
import type { ArtifactStore } from "../tools/storage.js";
import type { MediaVisionProvider, VisionResult } from "./vision.js";
vi.mock("@docslurp/shared/observability",()=>({withObservation:(_:unknown,run:()=>unknown)=>run(),recordMediaTelemetry:vi.fn(),emitTelemetryLog:vi.fn()}));
function fixture(){
  let receipt:MediaReceipt|undefined;let saved:VisionResult;
  const journal:MediaJournal={admit:vi.fn(async()=>{if(receipt)return {receipt,acquired:false};receipt={id:"vision-receipt",status:"submitting",resultKey:null,costCents:null};return{receipt,acquired:true};}),
    complete:vi.fn(async(_id,key,cost)=>{receipt={id:"vision-receipt",status:"completed",resultKey:key,costCents:cost};}),
    settled:vi.fn(async()=>{}),uncertain:vi.fn(async()=>{if(receipt?.status==="submitting")receipt.status="uncertain";})};
  const provider:MediaVisionProvider={id:"test",model:"vision",reserveUsd:.01,describe:vi.fn(async()=>({text:"Visible",inputTokens:10,outputTokens:5,costUsd:.001,
    accounting:{state:"estimated" as const,basis:"tokens" as const,rateSource:"test",rateVersion:"test",estimatedCostUsd:.001}}))};
  const state=new WorkflowState({id:"r",userId:"u",orgId:"o",workspaceId:"w",stats:{},artifacts:{},spentCents: 0,pipeline:{}} as WorkspaceRun,[]);
  state.store={updateProgress:vi.fn(async()=>{})} as unknown as NonNullable<WorkflowState["store"]>;
  const storage={putJson:vi.fn(async(_key:string,r:VisionResult)=>{saved=r;}),getJson:vi.fn(async()=>saved)} as unknown as ArtifactStore;
  return{state,journal,provider,storage,scope:{orgId:"o",workspaceId:"w",runId:"r",documentId:"d"},frames:[{seconds:0,bytes:new Uint8Array([1])}],policy:videoPolicy("silver",30),config:mediaConfig({})};
}
it("replays a completed visual receipt without paying or charging twice",async()=>{
  const f=fixture();await describeVideoChunk(f);await describeVideoChunk(f);
  expect(f.provider.describe).toHaveBeenCalledTimes(1);expect(f.state.usageLedger.snapshot()).toHaveLength(1);expect(runSpentCents(f.state)).toBeCloseTo(.12);
});
it("retries a failed checkpoint without resending visual inputs",async()=>{
  const f=fixture();vi.mocked(f.state.store!.updateProgress).mockRejectedValueOnce(new Error("db"));
  await expect(describeVideoChunk(f)).rejects.toThrow("reconcile");expect(f.journal.settled).not.toHaveBeenCalled();
  await describeVideoChunk(f);expect(f.provider.describe).toHaveBeenCalledTimes(1);expect(f.state.usageLedger.snapshot()).toHaveLength(1);
});
it("holds a lost visual response and refuses automatic resubmission",async()=>{
  const f=fixture();vi.mocked(f.provider.describe).mockRejectedValue(new Error("timeout"));
  await expect(describeVideoChunk(f)).rejects.toThrow("reconcile");await expect(describeVideoChunk(f)).rejects.toThrow("reconciliation");expect(f.provider.describe).toHaveBeenCalledTimes(1);
});
