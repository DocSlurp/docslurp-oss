import type { BackgroundTask, BackgroundTaskManager } from "@mastra/core/background-tasks";
import type { PubSub } from "@mastra/core/events";
import { randomUUID } from "node:crypto";
import { readNativeOperationOutput } from "./operation-delivery.js";
import { operationAttempts, attemptOrdinal, MAX_OPERATION_ATTEMPTS, ATTEMPT_CURSOR_STRIDE } from "./native-attempts.js";

export interface NativeOperationBinding {
  id: string;
  rootId: string;
  parentId: string | null;
  userId: string;
  orgId: string;
  projectId: string;
  deadline: Date;
  outputBytes?: number;
  cancelRequested: boolean;
  treeCancelled: boolean;
  authSessionId?: string;
}
export interface NativeOperationPolicy {
  /** Resolves from authenticated session and persisted binding, never client scope. */
  authorize(operationId: string): Promise<NativeOperationBinding>;
  /** Bounded application identities, including intent not yet accepted by Mastra. */
  listTree(binding: NativeOperationBinding): Promise<string[]>;
  /** Database lock shared across API instances; also checks durable cancellation intent. */
  serializeAcceptance<T>(binding: NativeOperationBinding, work: (admitNewAttempt:()=>Promise<void>) => Promise<T>): Promise<T>;
  recordCancellation(binding: NativeOperationBinding, scope: "task" | "tree"): Promise<void>;
}
const agentId="docslurp-project-chat";
const resourceId=(binding:NativeOperationBinding)=>JSON.stringify([binding.orgId,binding.userId]);
const expectsOutput=(task:BackgroundTask,binding:NativeOperationBinding)=>task.metadata?.outputExpected===undefined
  ? (binding.outputBytes??0)>0
  : task.metadata.outputExpected===true&&(task.metadata.outputAccepted===true||["completed","failed","cancelled","timed_out"].includes(task.status));

/** Native task lifecycle plus application identity/permission policy. This class
 * owns no queue, lease, retry loop, task journal or socket lifetime callback.
 */
export class NativeOperations {
  constructor(private manager: BackgroundTaskManager, private pubsub: PubSub, private policy: NativeOperationPolicy) {}
  private async tasks(binding:NativeOperationBinding, root=false) {
    const result=await this.manager.listTasks({agentId,resourceId:resourceId(binding),
      ...(root?{runId:binding.rootId}:{toolCallId:binding.id}),perPage:64*MAX_OPERATION_ATTEMPTS,page:0});
    if(result.total>64*MAX_OPERATION_ATTEMPTS) throw new Error("operation_tree_limit");
    return result.tasks;
  }
  async launch(operationId:string) {
    const binding=await this.policy.authorize(operationId);
    const accepted=operationAttempts(await this.tasks(binding));
    // Pending recovery belongs to the cancellable worker sweep. HTTP retries
    // return the same handle without holding locks across another restart call.
    if(accepted[0]) {
      return {operationId:binding.id,rootId:binding.rootId,taskId:accepted[0].id,status:publicTask(accepted[0],binding).status};
    }
    const handle=await this.policy.serializeAcceptance(binding,async(admitNewAttempt)=>{
      // Lookup by durable logical identity recovers an enqueue ACK lost before
      // the HTTP response or before the caller stored the native task id.
      const existing=operationAttempts(await this.tasks(binding));
      if(existing[0]) {
        return {operationId:binding.id,rootId:binding.rootId,taskId:existing[0].id,status:publicTask(existing[0],binding).status};
      }
      await admitNewAttempt();
      const remaining=binding.deadline.getTime()-Date.now();
      if(remaining<=0)throw new Error("operation_deadline");
      const {task}=await this.manager.enqueue({agentId,runId:binding.rootId,
        toolName:"docslurpProjectChat",toolCallId:binding.id,resourceId:resourceId(binding),threadId:binding.id,
        args:{operationId:binding.id,attemptOrdinal:0,attemptNonce:randomUUID()},metadata:{attemptOrdinal:0,outputExpected:false},timeoutMs:Math.min(600000,remaining),maxRetries:0});
      return {operationId:binding.id,rootId:binding.rootId,taskId:task.id,status:publicTask(task,binding).status};
    });
    return handle;
  }
  /** One authenticated mutation authorizes one new invocation, never recovery. */
  async retry(operationId:string,key:string) {
    if(!/^[a-zA-Z0-9_-]{8,128}$/.test(key))throw new Error("invalid_retry_key");
    const binding=await this.policy.authorize(operationId);
    if(!binding.parentId)throw new Error("child_required");
    return this.policy.serializeAcceptance(binding,async(admitNewAttempt)=>{
      const attempts=operationAttempts(await this.tasks(binding));
      const existing=attempts.find(task=>task.metadata?.retryKey===key);
      if(existing)return {operationId:binding.id,rootId:binding.rootId,taskId:existing.id,status:publicTask(existing,binding).status};
      const previous=attempts.at(-1);
      if(!previous||!["failed","timed_out"].includes(previous.status))throw new Error("operation_not_retryable");
      if(attempts.length>=MAX_OPERATION_ATTEMPTS)throw new Error("operation_attempt_limit");
      await admitNewAttempt();
      if(previous.metadata?.outputExpected===undefined) {
        const storage=await this.manager.getStorage();
        if(!await storage.updateTask(previous.id,{metadata:{...previous.metadata,outputExpected:(binding.outputBytes??0)>0}},
          {expectedStatus:previous.status}))throw new Error("operation_attempt_changed");
      }
      const remaining=binding.deadline.getTime()-Date.now();
      if(remaining<=0)throw new Error("operation_deadline");
      const {task}=await this.manager.enqueue({agentId,runId:binding.rootId,
        toolName:"docslurpProjectChat",toolCallId:binding.id,resourceId:resourceId(binding),threadId:binding.id,
        args:{operationId:binding.id,authSessionId:binding.authSessionId,attemptOrdinal:attempts.length,attemptNonce:randomUUID()},
        metadata:{attemptOrdinal:attempts.length,retryOf:previous.id,retryKey:key,outputExpected:false},
        timeoutMs:Math.min(600000,remaining),maxRetries:0});
      return {operationId:binding.id,rootId:binding.rootId,taskId:task.id,status:publicTask(task,binding).status};
    });
  }
  async read(operationId:string,after:number) {
    const binding=await this.policy.authorize(operationId);
    if(!Number.isSafeInteger(after)||after<0)throw new Error("invalid_cursor");
    const accepted=operationAttempts(await this.tasks(binding));
    const task=accepted.at(-1);
    const tasks=await this.tasks(binding,true);
    const nativeByOperation=new Map<string,BackgroundTask>();
    for(const child of tasks){
      const siblings=tasks.filter(candidate=>candidate.toolCallId===child.toolCallId);
      nativeByOperation.set(child.toolCallId,operationAttempts(siblings).at(-1)!);
    }
    const ids=new Set([binding.id,...await this.policy.listTree(binding),...nativeByOperation.keys()]);
    if(ids.size>64)throw new Error("operation_tree_limit");
    // A parent subscription conveys no permission to otherwise-inaccessible children.
    const scopes=new Map<string,NativeOperationBinding>();
    for(const id of ids) {
      const scope=await this.policy.authorize(id);
      if(scope.rootId!==binding.rootId||resourceId(scope)!==resourceId(binding))throw new Error("operation_forbidden");
      scopes.set(id,scope);
    }
    if(!task&&(binding.outputBytes??0)>0)throw new Error("operation_history_unavailable");
    const offset=task?attemptOrdinal(task)*ATTEMPT_CURSOR_STRIDE:0;
    const recovery=task?await readNativeOperationOutput(this.pubsub,task,Math.max(0,after-offset),
      expectsOutput(task,binding))
      :{events:[],watermark:0,snapshot:{},resync:after!==0,hasMore:false};
    const priorAttempts=[];
    for(const previous of accepted.slice(0,-1)) {
      try {
        const output=await readNativeOperationOutput(this.pubsub,previous,0,expectsOutput(previous,binding));
        priorAttempts.push({...publicTask(previous,binding),canRetry:false,snapshot:output.snapshot,watermark:attemptOrdinal(previous)*ATTEMPT_CURSOR_STRIDE+output.watermark,historyUnavailable:false});
      }catch(error){
        if(!(error instanceof Error)||!["output_history_unavailable","output_history_gap"].includes(error.message))throw error;
        // Preserve the failed history reference and explicit error without
        // hiding a separately retained current answer. Never invent old output.
        priorAttempts.push({...publicTask(previous,binding),canRetry:false,snapshot:{error:error.message},watermark:null,historyUnavailable:true});
      }
    }
    recovery.watermark+=offset;
    recovery.events=recovery.events.map(event=>({...event,sequence:event.sequence+offset}));
    recovery.resync ||= after<offset;
    if(recovery.resync)recovery.events=[];
    recovery.snapshot={...recovery.snapshot,priorAttempts};
    // Recheck after native storage/cache awaits, before returning any payload.
    await this.policy.authorize(operationId);
    for (const id of ids) await this.policy.authorize(id);
    if((operationAttempts(await this.tasks(binding)).at(-1)?.id)!==task?.id)throw new Error("operation_attempt_changed");
    const summaries=[...scopes.values()].map(scope=>({...publicTask(nativeByOperation.get(scope.id),scope),project_id:scope.projectId,org_id:scope.orgId,user_id:binding.userId}));
    const {snapshot,...delivery}=recovery;
    const response={...delivery,operation:{...publicTask(task,binding),user_id:binding.userId,org_id:binding.orgId,project_id:binding.projectId,snapshot,sequence:recovery.watermark},tasks:summaries,
      treeSettled:summaries.every(child=>["completed","failed","cancelled","interrupted"].includes(child.status))};
    // Account for the complete envelope and all attempt snapshots. The output
    // snapshot has one canonical location, rather than two serialized copies.
    if(Buffer.byteLength(JSON.stringify(response))>393216){response.events=[];response.resync=true;response.hasMore=false;}
    if(Buffer.byteLength(JSON.stringify(response))>524288)throw new Error("operation_snapshot_limit");
    return response;
  }
  async cancel(operationId:string,scope:"task"|"tree") {
    const binding=await this.policy.authorize(operationId);
    if(scope==="tree"&&binding.id!==binding.rootId)throw new Error("root_required");
    await this.policy.recordCancellation(binding,scope);
    const tasks=await this.tasks(binding,scope==="tree");
    for(const task of tasks) {
      await this.policy.authorize(task.toolCallId);
      if(["pending","running","suspended"].includes(task.status))await this.manager.cancel(task.id);
    }
  }
}
function publicTask(task:BackgroundTask|undefined,binding:NativeOperationBinding) {
  if(!task){
    const status=binding.cancelRequested||binding.treeCancelled?"cancelled":binding.deadline.getTime()<=Date.now()||(binding.outputBytes??0)>0?"interrupted":"waiting";
    return {id:binding.id,nativeTaskId:null,root_id:binding.rootId,parent_id:binding.parentId,status,
      cancel_requested:binding.cancelRequested,tree_cancel_requested:binding.treeCancelled,
      attempt_id:null,attemptOrdinal:0,canRetry:false,retryCount:0,waiting:status==="waiting",resultAvailable:false,completedAt:null,
      ...(status==="interrupted"?{error:"native_task_not_accepted"}:{})};
  }
  const interrupted=task.status==="failed"&&/worker process terminated|interrupted/i.test(task.error?.message??"");
  const status=interrupted?"interrupted":task.status==="pending"?"queued":task.status==="suspended"?"waiting":task.status==="timed_out"?"interrupted":task.status;
  return {id:task.toolCallId,nativeTaskId:task.id,root_id:binding.rootId,parent_id:binding.parentId,status,
    cancel_requested:binding.cancelRequested,tree_cancel_requested:binding.treeCancelled,
    attempt_id:`${task.id}:${task.retryCount}`,attemptOrdinal:attemptOrdinal(task),retryCount:task.retryCount,
    canRetry:!!binding.parentId&&!binding.cancelRequested&&!binding.treeCancelled&&binding.deadline.getTime()>Date.now()
      &&(binding.outputBytes??0)<262144&&["failed","timed_out"].includes(task.status)&&attemptOrdinal(task)<MAX_OPERATION_ATTEMPTS-1,
    waiting:task.status==="pending"||task.status==="suspended",
    ...(interrupted?{error:"executor_interrupted"}:{}),
    resultAvailable:task.status==="completed",completedAt:task.completedAt??null};
}
