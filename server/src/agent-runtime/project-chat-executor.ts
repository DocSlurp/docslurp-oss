import type { BackgroundTaskManager, ToolExecutor } from "@mastra/core/background-tasks";
import type postgres from "postgres";
import type { PubSub } from "@mastra/core/events";
import { sql } from "../db.js";
import { env } from "../config.js";
import { revalidateRealtimeSession } from "../realtime/session.js";
import { loadActorScopedProjectAccess, type SessionRequestActor } from "../lib/request-actor.js";
import { searchAccessScopeFor } from "../search/access-scope.js";
import { chatProject, projectChatDisabledBody } from "../services/project-chat.js";
import { withDeferredContext } from "../search/deferred/deferred-context.js";
import { withNativeChatRunOwner } from "../services/chat-run-dependencies.js";
import { operationOutputTopic, publishOperationOutput } from "./operation-delivery.js";
import { executionAttempt } from "./native-attempts.js";
import { durableChatTurnOptions } from "./chat-turn-options.js";

/** Native static executor: reconstructs application policy after cross-process
 * dispatch. Native task leases, timeouts, cancellation and stale-worker recovery
 * own execution; observer signals are never accepted here.
 */
export function createProjectChatExecutor(manager:BackgroundTaskManager,pubsub:PubSub):ToolExecutor {
  return {async execute(args,options) {
    if(typeof args.operationId!=="string")throw new Error("invalid_operation");
    const [binding]=await sql<{id:string;root_id:string;user_id:string;org_id:string;project_id:string;input:Record<string,unknown>}[]>`
      select id,root_id,user_id,org_id,project_id,input from chat_operations
      where id=${args.operationId} and runtime='mastra'`;
    if(!binding)throw new Error("operation_unavailable");
    const matches=await manager.listTasks({agentId:"docslurp-project-chat",toolCallId:binding.id,
      resourceId:JSON.stringify([binding.org_id,binding.user_id]),perPage:4});
    if(matches.total!==matches.tasks.length)throw new Error("native_execution_fence");
    const task=executionAttempt(matches.tasks,args,manager.ownerId);
    const local=new AbortController();
    const signal=options?.abortSignal ? AbortSignal.any([options.abortSignal,local.signal]) : local.signal;
    const actor:SessionRequestActor={type:"session",userId:binding.user_id,sessionId:String(task.args.authSessionId??binding.input.authSessionId),
      user:{id:binding.user_id,email:"",name:""}};
    const check=async()=>{
      signal.throwIfAborted();
      if(!await revalidateRealtimeSession(actor,signal))throw new Error("session_revoked");
      // Access only (one indexed query, every 2 s): the project record's corpus and activity summary is not needed.
      const project=await loadActorScopedProjectAccess(binding.project_id,actor);
      if(project?.orgId!==binding.org_id)throw new Error("project_revoked");
      const [active]=await sql`
        select c.id from chat_operations c join chat_operations root on root.id=c.root_id
        join docslurp_mastra.mastra_background_tasks t on t.tool_call_id=c.id
        where c.id=${binding.id} and not c.cancel_requested and not root.tree_cancel_requested
          and c.deadline>clock_timestamp() and root.deadline>clock_timestamp()
          and c.expires_at>clock_timestamp() and root.expires_at>clock_timestamp() and t.id=${task.id} and t.status='running'
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
    let outputMarked=task.metadata?.outputExpected===true;
    let outputAccepted=task.metadata?.outputAccepted===true;
    let publicationAttempted=false;
    const lockAndFence=async(tx:postgres.TransactionSql)=>{
      await tx`select id from chat_operations where id=${binding.root_id} for update`;
      const [active]=await tx`
        select c.id from chat_operations c join chat_operations root on root.id=c.root_id
        join docslurp_mastra.mastra_background_tasks t on t.tool_call_id=c.id
        where c.id=${binding.id} and not c.cancel_requested and not root.tree_cancel_requested
          and c.deadline>clock_timestamp() and root.deadline>clock_timestamp()
          and c.expires_at>clock_timestamp() and root.expires_at>clock_timestamp() and t.id=${task.id} and t.status='running'
          and t."ownerId"=${manager.ownerId} and t."leaseExpiresAtZ">clock_timestamp()
        for share of t`;
      if(!active)throw new Error("operation_cancelled_or_expired");
      signal.throwIfAborted();
    };
    const append=(kind:"text"|"tool"|"evidence"|"result",payload:unknown)=>{
      pending=pending.then(async()=>{
        await check();
        if(!outputMarked) {
          // Conservative persisted marker precedes output. A storage failure
          // cannot later masquerade as an attempt that never accepted output.
          const storage=await manager.getStorage();
          if(!await storage.updateTask(task.id,{metadata:{...task.metadata,outputExpected:true}},
            {expectedStatus:"running",expectedOwnerId:manager.ownerId}))throw new Error("native_execution_fence");
          outputMarked=true;
        }
        // Reserve the quota durably before touching Redis. An ACK failure after
        // the retained append must not roll back its quota and permit free replay.
        await sql.begin(async tx=>{
          await lockAndFence(tx);
          let budgetPayload=payload;
          if(kind==="result"&&payload&&typeof payload==="object"&&"answer" in payload&&payload.answer===text) {
            const {answer:_answer,...metadata}=payload;budgetPayload=metadata;
          }
          const bytes=Buffer.byteLength(JSON.stringify(budgetPayload));
          const [total]=await tx`select coalesce(sum(output_bytes),0)::int as bytes from chat_operations where root_id=${binding.root_id}`;
          const [accepted]=await tx`update chat_operations set output_bytes=output_bytes+${bytes}
            where id=${binding.id} and output_bytes+${bytes}<=262144 and ${Number(total!.bytes)+bytes}<=524288 returning id`;
          if(!accepted)throw new Error("operation_output_limit");
        });
        // Recheck under the cancellation lock after the reservation commits.
        // Reservations are conservative and never refunded on uncertain output.
        await sql.begin(async tx=>{
          await lockAndFence(tx);
          publicationAttempted=true;
          await publishOperationOutput(pubsub,task.id,{kind,payload});
          if(kind==="tool")tools.push(payload);
          if(kind==="evidence")evidence=payload;
          if(kind==="text"&&payload&&typeof payload==="object"&&"text" in payload)text+=String(payload.text);
        });
        if(!outputAccepted) {
          const storage=await manager.getStorage();
          if(!await storage.updateTask(task.id,{metadata:{...task.metadata,outputExpected:true,outputAccepted:true}},
            {expectedStatus:"running",expectedOwnerId:manager.ownerId}))throw new Error("native_execution_fence");
          outputAccepted=true;
        }
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
      if(await projectChatDisabledBody(binding.project_id,binding.user_id))throw new Error("chat_disabled");
      const result=await withNativeChatRunOwner({...binding,sessionId:actor.sessionId,signal,nativeTaskId:task.id,nativeOwnerId:manager.ownerId},
        ()=>withDeferredContext({signal},()=>chatProject({
          projectId:binding.project_id,userId:binding.user_id,query:String(binding.input.q),
          // The operation's bound org; check() above re-verified the project is still in it.
          scope:searchAccessScopeFor(actor,{orgId:binding.org_id})!,
          sessionId:binding.input.sessionId as string|undefined,model:binding.input.model as string|undefined,
          ...durableChatTurnOptions(binding.input,actor),
          // Signed-in app turn: "/status" gets the free ingest report, as in the streaming route.
          answerIngestReport:true,
          actor,allowAgentTools:env.publicChatAgentEnabled,allowConfiguration:false,signal,
          onTextDelta:text=>append("text",{text}),
          onToolActivity:event=>{void append("tool",event);},onEvidence:event=>{void append("evidence",event);},
        })));
      await pending;signal.throwIfAborted();
      await append("result",result);
      const events=await pubsub.getHistory(operationOutputTopic(task.id));
      return {result:{...result,tools,...(evidence===undefined?{}:{evidence})},watermark:(events.at(-1)?.index ?? -1)+1};
    } finally {
      clearInterval(timer);await pending.catch(()=>{});
      if(!publicationAttempted)try {
        // A quota/fence refusal before calling PubSub is known not to have
        // accepted output. Do not turn that refusal into a permanent history gap.
        const storage=await manager.getStorage();const current=await storage.getTask(task.id);
        if(current?.metadata?.outputExpected===true&&(current.ownerId===manager.ownerId||
          !current.ownerId&&["failed","cancelled","timed_out"].includes(current.status))) {
          await storage.updateTask(task.id,{metadata:{...current.metadata,outputExpected:false,outputAccepted:false}},
            {expectedStatus:current.status,expectedOwnerId:current.ownerId??null});
        }
      }catch{console.error("[native-chat] output_marker_cleanup_failed");}
    }
  }};
}
