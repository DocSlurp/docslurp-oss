import type { BackgroundTaskManager, ToolExecutor } from "@mastra/core/background-tasks";
import type { PubSub } from "@mastra/core/events";
import { sql } from "../db.js";
import { env } from "../config.js";
import { revalidateRealtimeSession } from "../realtime/session.js";
import { loadActorScopedWorkspace, type SessionRequestActor } from "../lib/request-actor.js";
import { chatWorkspace, workspaceChatDisabledBody } from "../services/workspace-chat.js";
import { withDeferredContext } from "../search/deferred/deferred-context.js";
import { withNativeChatRunOwner } from "../services/chat-run-dependencies.js";
import { operationOutputTopic, publishOperationOutput } from "./operation-delivery.js";

/** Native static executor: reconstructs application policy after cross-process
 * dispatch. Native task leases, timeouts, cancellation and stale-worker recovery
 * own execution; observer signals are never accepted here.
 */
export function createWorkspaceChatExecutor(manager:BackgroundTaskManager,pubsub:PubSub):ToolExecutor {
  return {async execute(args,options) {
    if(typeof args.operationId!=="string")throw new Error("invalid_operation");
    const [binding]=await sql<{id:string;root_id:string;user_id:string;org_id:string;workspace_id:string;input:Record<string,unknown>}[]>`
      select id,root_id,user_id,org_id,workspace_id,input from chat_operations
      where id=${args.operationId} and runtime='mastra'`;
    if(!binding)throw new Error("operation_unavailable");
    const matches=await manager.listTasks({agentId:"docslurp-workspace-chat",toolCallId:binding.id,
      resourceId:JSON.stringify([binding.org_id,binding.user_id]),perPage:2});
    const task=matches.tasks[0];
    if(matches.total!==1||!task||task.status!=="running"||task.ownerId!==manager.ownerId)throw new Error("native_execution_fence");
    const local=new AbortController();
    const signal=options?.abortSignal ? AbortSignal.any([options.abortSignal,local.signal]) : local.signal;
    const actor:SessionRequestActor={type:"session",userId:binding.user_id,sessionId:String(binding.input.authSessionId),
      user:{id:binding.user_id,email:"",name:""}};
    const check=async()=>{
      signal.throwIfAborted();
      if(!await revalidateRealtimeSession(actor,signal))throw new Error("session_revoked");
      const workspace=await loadActorScopedWorkspace(binding.workspace_id,actor,{refineNames:false});
      if(workspace?.orgId!==binding.org_id)throw new Error("workspace_revoked");
      const [active]=await sql`
        select c.id from chat_operations c join chat_operations root on root.id=c.root_id
        join docslurp_mastra.mastra_background_tasks t on t.tool_call_id=c.id
        where c.id=${binding.id} and not c.cancel_requested and not root.tree_cancel_requested
          and c.deadline>clock_timestamp() and t.id=${task.id} and t.status='running'
          and t."ownerId"=${manager.ownerId} and t."leaseExpiresAtZ">clock_timestamp()`;
      if(!active)throw new Error("operation_cancelled_or_expired");
      signal.throwIfAborted();
      verifiedAt=Date.now();
    };
    let pending=Promise.resolve();
    let text="";
    const tools:unknown[]=[];
    let evidence:unknown;
    let verifiedAt=Date.now();
    const append=(kind:"text"|"tool"|"evidence"|"result",payload:unknown)=>{
      pending=pending.then(async()=>{
        await check();
        // Serialize policy acceptance against root cancellation. Native storage
        // remains the owner of the task lease and output cache.
        await sql.begin(async tx=>{
          await tx`select id from chat_operations where id=${binding.root_id} for update`;
          const [active]=await tx`
            select c.id from chat_operations c join chat_operations root on root.id=c.root_id
            join docslurp_mastra.mastra_background_tasks t on t.tool_call_id=c.id
            where c.id=${binding.id} and not c.cancel_requested and not root.tree_cancel_requested
              and c.deadline>clock_timestamp() and t.id=${task.id} and t.status='running'
              and t."ownerId"=${manager.ownerId} and t."leaseExpiresAtZ">clock_timestamp()
            for share of t`;
          if(!active)throw new Error("operation_cancelled_or_expired");
          signal.throwIfAborted();
          let budgetPayload=payload;
          if(kind==="result"&&payload&&typeof payload==="object"&&"answer" in payload&&payload.answer===text) {
            const {answer:_answer,...metadata}=payload;budgetPayload=metadata;
          }
          const bytes=Buffer.byteLength(JSON.stringify(budgetPayload));
          const [total]=await tx`select coalesce(sum(output_bytes),0)::int as bytes from chat_operations where root_id=${binding.root_id}`;
          const [accepted]=await tx`update chat_operations set output_bytes=output_bytes+${bytes}
            where id=${binding.id} and output_bytes+${bytes}<=262144 and ${Number(total!.bytes)+bytes}<=524288 returning id`;
          if(!accepted)throw new Error("operation_output_limit");
          await publishOperationOutput(pubsub,task.id,{kind,payload});
          if(kind==="tool")tools.push(payload);
          if(kind==="evidence")evidence=payload;
          if(kind==="text"&&payload&&typeof payload==="object"&&"text" in payload)text+=String(payload.text);
        });
      });
      void pending.catch(error=>local.abort(error));
      return pending;
    };
    let checking=false;
    const timer=setInterval(()=>{
      if(Date.now()-verifiedAt>5000)local.abort(new Error("authorization_timeout"));
      if(checking||signal.aborted)return;checking=true;
      void check().catch(error=>local.abort(error)).finally(()=>{checking=false;});
    },2000);
    try {
      await check();
      if(await workspaceChatDisabledBody(binding.workspace_id,binding.user_id))throw new Error("chat_disabled");
      const result=await withNativeChatRunOwner({...binding,sessionId:actor.sessionId,signal,nativeTaskId:task.id,nativeOwnerId:manager.ownerId},
        ()=>withDeferredContext({signal},()=>chatWorkspace({
          workspaceId:binding.workspace_id,userId:binding.user_id,query:String(binding.input.q),
          sessionId:binding.input.sessionId as string|undefined,model:binding.input.model as string|undefined,
          actor,allowAgentTools:env.publicChatAgentEnabled,allowConfiguration:false,signal,
          onTextDelta:text=>append("text",{text}),
          onToolActivity:event=>{void append("tool",event);},onEvidence:event=>{void append("evidence",event);},
        })));
      await pending;signal.throwIfAborted();
      await append("result",result);
      const events=await pubsub.getHistory(operationOutputTopic(task.id));
      return {result:{...result,tools,...(evidence===undefined?{}:{evidence})},watermark:(events.at(-1)?.index ?? -1)+1};
    } finally {clearInterval(timer);await pending.catch(()=>{});}
  }};
}
