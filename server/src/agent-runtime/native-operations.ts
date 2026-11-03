import type { BackgroundTask, BackgroundTaskManager } from "@mastra/core/background-tasks";
import type { PubSub } from "@mastra/core/events";
import { readNativeOperationOutput } from "./operation-delivery.js";

export interface NativeOperationBinding {
  id: string;
  rootId: string;
  userId: string;
  orgId: string;
  workspaceId: string;
  deadline: Date;
  outputBytes?: number;
}
export interface NativeOperationPolicy {
  /** Resolves from authenticated session and persisted binding, never client scope. */
  authorize(operationId: string): Promise<NativeOperationBinding>;
  /** Database lock shared across API instances; also checks durable cancellation intent. */
  serializeAcceptance<T>(binding: NativeOperationBinding, work: () => Promise<T>): Promise<T>;
  recordCancellation(binding: NativeOperationBinding, scope: "task" | "tree"): Promise<void>;
}
const agentId="docslurp-workspace-chat";
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
    if(accepted[0])return {operationId:binding.id,rootId:binding.rootId,taskId:accepted[0].id,status:publicTask(accepted[0]).status};
    return this.policy.serializeAcceptance(binding,async()=>{
      // Lookup by durable logical identity recovers an enqueue ACK lost before
      // the HTTP response or before the caller stored the native task id.
      const existing=await this.tasks(binding);
      if(existing.length>1)throw new Error("operation_identity_conflict");
      if(existing[0])return {operationId:binding.id,rootId:binding.rootId,taskId:existing[0].id,status:publicTask(existing[0]).status};
      const remaining=binding.deadline.getTime()-Date.now();
      if(remaining<=0)throw new Error("operation_deadline");
      const {task}=await this.manager.enqueue({agentId,runId:binding.rootId,
        toolName:"docslurpWorkspaceChat",toolCallId:binding.id,resourceId:resourceId(binding),threadId:binding.id,
        args:{operationId:binding.id},timeoutMs:Math.min(600000,remaining),maxRetries:0});
      return {operationId:binding.id,rootId:binding.rootId,taskId:task.id,status:publicTask(task).status};
    });
  }
  async read(operationId:string,after:number) {
    const binding=await this.policy.authorize(operationId);
    const [task]=await this.tasks(binding);
    if(!task)throw new Error("operation_not_started");
    const tasks=await this.tasks(binding,true);
    // A parent subscription conveys no permission to otherwise-inaccessible children.
    const scopes=new Map<string,NativeOperationBinding>();
    for(const child of tasks) {
      const scope=await this.policy.authorize(child.toolCallId);
      if(scope.rootId!==binding.rootId||resourceId(scope)!==resourceId(binding))throw new Error("operation_forbidden");
      scopes.set(child.id,scope);
    }
    const recovery=await readNativeOperationOutput(this.pubsub,task,after,(binding.outputBytes ?? 0)>0);
    // Recheck after native storage/cache awaits, before returning any payload.
    await this.policy.authorize(operationId);
    for (const child of tasks) await this.policy.authorize(child.toolCallId);
    return {...recovery,operation:{...publicTask(task),user_id:binding.userId,org_id:binding.orgId,workspace_id:binding.workspaceId,snapshot:recovery.snapshot,sequence:recovery.watermark},tasks:tasks.map(child=>({...publicTask(child),workspace_id:scopes.get(child.id)!.workspaceId,org_id:scopes.get(child.id)!.orgId,user_id:binding.userId})),
      treeSettled:tasks.every(child=>["completed","failed","cancelled","timed_out"].includes(child.status))};
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
function publicTask(task:BackgroundTask) {
  const interrupted=task.status==="failed"&&/worker process terminated|interrupted/i.test(task.error?.message??"");
  const status=interrupted?"interrupted":task.status==="pending"?"queued":task.status==="suspended"?"waiting":task.status==="timed_out"?"interrupted":task.status;
  return {id:task.toolCallId,nativeTaskId:task.id,root_id:task.runId,parent_id:task.toolCallId===task.runId?null:task.runId,status,
    attempt_id:`${task.id}:${task.retryCount}`,retryCount:task.retryCount,
    waiting:task.status==="pending"||task.status==="suspended",
    ...(interrupted?{error:"executor_interrupted"}:{}),
    resultAvailable:task.status==="completed",completedAt:task.completedAt??null};
}
