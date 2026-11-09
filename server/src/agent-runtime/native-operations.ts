import type { BackgroundTask, BackgroundTaskManager } from "@mastra/core/background-tasks";
import type { PubSub } from "@mastra/core/events";
import { readNativeOperationOutput } from "./operation-delivery.js";

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
}
export interface NativeOperationPolicy {
  /** Resolves from authenticated session and persisted binding, never client scope. */
  authorize(operationId: string): Promise<NativeOperationBinding>;
  /** Bounded application identities, including intent not yet accepted by Mastra. */
  listTree(binding: NativeOperationBinding): Promise<string[]>;
  /** Database lock shared across API instances; also checks durable cancellation intent. */
  serializeAcceptance<T>(binding: NativeOperationBinding, work: () => Promise<T>): Promise<T>;
  recordCancellation(binding: NativeOperationBinding, scope: "task" | "tree"): Promise<void>;
}
const agentId="docslurp-project-chat";
const resourceId=(binding:NativeOperationBinding)=>JSON.stringify([binding.orgId,binding.userId]);

/** Native task lifecycle plus application identity/permission policy. This class
 * owns no queue, lease, retry loop, task journal or socket lifetime callback.
 */
export class NativeOperations {
  constructor(private manager: BackgroundTaskManager, private pubsub: PubSub, private policy: NativeOperationPolicy) {}
  private async tasks(binding:NativeOperationBinding, root=false) {
    const result=await this.manager.listTasks({agentId,resourceId:resourceId(binding),
      ...(root?{runId:binding.rootId}:{toolCallId:binding.id}),perPage:64,page:0});
    if(result.total>64) throw new Error("operation_tree_limit");
    return result.tasks;
  }
  async launch(operationId:string) {
    const binding=await this.policy.authorize(operationId);
    const accepted=await this.tasks(binding);
    if(accepted.length>1)throw new Error("operation_identity_conflict");
    // Pending recovery belongs to the cancellable worker sweep. HTTP retries
    // return the same handle without holding locks across another restart call.
    if(accepted[0]) {
      return {operationId:binding.id,rootId:binding.rootId,taskId:accepted[0].id,status:publicTask(accepted[0],binding).status};
    }
    const handle=await this.policy.serializeAcceptance(binding,async()=>{
      // Lookup by durable logical identity recovers an enqueue ACK lost before
      // the HTTP response or before the caller stored the native task id.
      const existing=await this.tasks(binding);
      if(existing.length>1)throw new Error("operation_identity_conflict");
      if(existing[0]) {
        return {operationId:binding.id,rootId:binding.rootId,taskId:existing[0].id,status:publicTask(existing[0],binding).status};
      }
      const remaining=binding.deadline.getTime()-Date.now();
      if(remaining<=0)throw new Error("operation_deadline");
      const {task}=await this.manager.enqueue({agentId,runId:binding.rootId,
        toolName:"docslurpProjectChat",toolCallId:binding.id,resourceId:resourceId(binding),threadId:binding.id,
        args:{operationId:binding.id},timeoutMs:Math.min(600000,remaining),maxRetries:0});
      return {operationId:binding.id,rootId:binding.rootId,taskId:task.id,status:publicTask(task,binding).status};
    });
    return handle;
  }
  async read(operationId:string,after:number) {
    const binding=await this.policy.authorize(operationId);
    if(!Number.isSafeInteger(after)||after<0)throw new Error("invalid_cursor");
    const accepted=await this.tasks(binding);
    if(accepted.length>1)throw new Error("operation_identity_conflict");
    const task=accepted[0];
    const tasks=await this.tasks(binding,true);
    const nativeByOperation=new Map<string,BackgroundTask>();
    for(const child of tasks){
      if(nativeByOperation.has(child.toolCallId))throw new Error("operation_identity_conflict");
      nativeByOperation.set(child.toolCallId,child);
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
    const recovery=task?await readNativeOperationOutput(this.pubsub,task,after,(binding.outputBytes ?? 0)>0)
      :{events:[],watermark:0,snapshot:{},resync:after!==0,hasMore:false};
    // Recheck after native storage/cache awaits, before returning any payload.
    await this.policy.authorize(operationId);
    for (const id of ids) await this.policy.authorize(id);
    const summaries=[...scopes.values()].map(scope=>({...publicTask(nativeByOperation.get(scope.id),scope),project_id:scope.projectId,org_id:scope.orgId,user_id:binding.userId}));
    return {...recovery,operation:{...publicTask(task,binding),user_id:binding.userId,org_id:binding.orgId,project_id:binding.projectId,snapshot:recovery.snapshot,sequence:recovery.watermark},tasks:summaries,
      treeSettled:summaries.every(child=>["completed","failed","cancelled","interrupted"].includes(child.status))};
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
      attempt_id:null,retryCount:0,waiting:status==="waiting",resultAvailable:false,completedAt:null,
      ...(status==="interrupted"?{error:"native_task_not_accepted"}:{})};
  }
  const interrupted=task.status==="failed"&&/worker process terminated|interrupted/i.test(task.error?.message??"");
  const status=interrupted?"interrupted":task.status==="pending"?"queued":task.status==="suspended"?"waiting":task.status==="timed_out"?"interrupted":task.status;
  return {id:task.toolCallId,nativeTaskId:task.id,root_id:binding.rootId,parent_id:binding.parentId,status,
    attempt_id:`${task.id}:${task.retryCount}`,retryCount:task.retryCount,
    waiting:task.status==="pending"||task.status==="suspended",
    ...(interrupted?{error:"executor_interrupted"}:{}),
    resultAvailable:task.status==="completed",completedAt:task.completedAt??null};
}
