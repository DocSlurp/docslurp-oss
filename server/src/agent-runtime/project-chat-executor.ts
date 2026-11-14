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

/** Bound on one output publish while the publish transaction holds the session share lock (see publish()). */
const PUBLISH_TIMEOUT_MS=3_000;
async function publishWithin<T>(ms:number,promise:Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("operation_publish_timeout")),ms);})]);
  } finally { if(timer)clearTimeout(timer); }
}

/** Per-operation and per-root (whole tree) output quotas, in bytes. */
const OPERATION_OUTPUT_LIMIT=262144;
const ROOT_OUTPUT_LIMIT=524288;
/** An idle turn whose authorization recheck has stalled this long aborts. */
const AUTHORIZATION_TIMEOUT_MS=5000;
/** Buffered text flushes early at this size, and the model then waits for the append. */
const OUTPUT_FLUSH_BYTES=16384;
/**
 * Text deltas coalesce this long before one fenced append
 * (DOCSLURP_CHAT_OUTPUT_FLUSH_MS, 10 to 2000 ms; default 250). Every append
 * re-reads authorization, so the interval also bounds statements per answer.
 */
function outputFlushMs() {
  const parsed=Number(process.env.DOCSLURP_CHAT_OUTPUT_FLUSH_MS);
  return Number.isInteger(parsed)&&parsed>=10&&parsed<=2000 ? parsed : 250;
}

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
      // Access decision only (membership, project, org); not the full project aggregate.
      const access=await loadActorScopedProjectAccess(binding.project_id,actor);
      if(access?.orgId!==binding.org_id)throw new Error("project_revoked");
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
      // Separate statement: the fence below then reads with a snapshot taken
      // after the root lock, so a committed cancellation is always visible.
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
    const publish=async(kind:"text"|"tool"|"evidence"|"result",payload:unknown)=>{
      signal.throwIfAborted();
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
      // This cannot share a transaction with the publish below: the commit is
      // the durability point, and a rollback on a failed ACK would refund it.
      await sql.begin(async tx=>{
        await lockAndFence(tx);
        let budgetPayload=payload;
        if(kind==="result"&&payload&&typeof payload==="object"&&"answer" in payload&&payload.answer===text) {
          const {answer:_answer,...metadata}=payload;budgetPayload=metadata;
        }
        const bytes=Buffer.byteLength(JSON.stringify(budgetPayload));
        // The root lock serializes every reservation in the tree, so the sum is current.
        const [accepted]=await tx`update chat_operations set output_bytes=output_bytes+${bytes}
          where id=${binding.id} and output_bytes+${bytes}<=${OPERATION_OUTPUT_LIMIT}
            and (select coalesce(sum(output_bytes),0) from chat_operations where root_id=${binding.root_id})+${bytes}<=${ROOT_OUTPUT_LIMIT}
          returning id`;
        if(!accepted)throw new Error("operation_output_limit");
      });
      // Authorization is re-read for every append, immediately before it is
      // published: a session or project access revoked since the last check
      // (the timer's or an earlier append's) publishes nothing more. A refusal
      // rejects the append, which aborts the turn. Session revocation is also
      // fenced inside the publish transaction below; a membership or share
      // removed in the milliseconds between this check and that commit can still
      // let this one append through (operation reads re-authorize the reader).
      await check();
      // Recheck under the cancellation lock after the reservation commits.
      // Reservations are conservative and never refunded on uncertain output.
      await sql.begin(async tx=>{
        // The share lock below must never outlive a stalled Redis: Postgres itself ends this transaction (releasing
        // the lock, so sign-out and session refresh proceed) if it sits idle waiting on the publish for 3 s, and the
        // client gives up on the publish at the same bound. A publish that times out is an uncertain write, handled
        // like any other failed publication (quota stays reserved; the turn fails).
        await tx`set local idle_in_transaction_session_timeout = '3s'`;
        await lockAndFence(tx);
        // Revocation fence: share-lock the session row, then re-validate it in this
        // transaction. A sign-out or session revocation (a delete or update of that
        // row) either committed first, and is seen here, or waits for this publish to
        // commit. One exception: a publish that times out (above) releases the lock
        // while its Redis command may still complete later, so that single payload can
        // appear after a revocation; readers of the operation are authorized separately.
        const [held]=await tx`select id from session where id=${actor.sessionId} and "userId"=${actor.userId} for share`;
        if(!held||!await revalidateRealtimeSession(actor,signal,tx))throw new Error("session_revoked");
        publicationAttempted=true;
        await publishWithin(PUBLISH_TIMEOUT_MS,publishOperationOutput(pubsub,task.id,{kind,payload}));
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
    };
    /** One serialized chain: events publish in exactly the order they were queued. */
    const enqueue=(kind:"text"|"tool"|"evidence"|"result",payload:unknown)=>{
      pending=pending.then(()=>publish(kind,payload));
      void pending.catch(error=>local.abort(error));
      return pending;
    };
    // Text deltas are coalesced: one fenced append per flush interval or byte
    // threshold, and always before any other event, so the client sees the same
    // text in the same order relative to tool, evidence and result events.
    const flushMs=outputFlushMs();
    let buffered="";
    let bufferedBytes=0;
    let flushTimer:ReturnType<typeof setTimeout>|undefined;
    const flushText=()=>{
      if(flushTimer){clearTimeout(flushTimer);flushTimer=undefined;}
      if(!buffered)return pending;
      // Snapshot at queue time: text arriving later can never jump ahead of an event queued now.
      const chunk=buffered;buffered="";bufferedBytes=0;
      return enqueue("text",{text:chunk});
    };
    const append=(kind:"tool"|"evidence"|"result",payload:unknown)=>{
      flushText();
      return enqueue(kind,payload);
    };
    const onTextDelta=(delta:string)=>{
      signal.throwIfAborted();
      if(!delta)return;
      buffered+=delta;bufferedBytes+=Buffer.byteLength(delta);
      // Backpressure: past the threshold the model waits for the append (and sees its failure).
      if(bufferedBytes>=OUTPUT_FLUSH_BYTES)return flushText();
      flushTimer??=setTimeout(()=>{flushTimer=undefined;void flushText().catch(()=>{});},flushMs);
    };
    // Buffered text is never published after cancellation, abort or failure.
    signal.addEventListener("abort",()=>{
      if(flushTimer){clearTimeout(flushTimer);flushTimer=undefined;}
      buffered="";bufferedBytes=0;
    },{once:true});
    // The timer stops idle work (a model or tool call that publishes nothing)
    // after revocation or cancellation; publishing never relies on it.
    let checking=false;
    const timer=setInterval(()=>{
      if(Date.now()-verifiedAt>AUTHORIZATION_TIMEOUT_MS)local.abort(new Error("authorization_timeout"));
      if(checking||signal.aborted)return;checking=true;
      void check().catch(error=>local.abort(error)).finally(()=>{checking=false;});
    },2000);
    try {
      await check();
      if(await projectChatDisabledBody(binding.project_id,binding.user_id))throw new Error("chat_disabled");
      let result:Awaited<ReturnType<typeof chatProject>>;
      try {
        result=await withNativeChatRunOwner({...binding,sessionId:actor.sessionId,signal,nativeTaskId:task.id,nativeOwnerId:manager.ownerId},
          ()=>withDeferredContext({signal},()=>chatProject({
            projectId:binding.project_id,userId:binding.user_id,query:String(binding.input.q),
            // The operation's bound org; check() above re-verified the project is still in it.
            scope:searchAccessScopeFor(actor,{orgId:binding.org_id})!,
            sessionId:binding.input.sessionId as string|undefined,model:binding.input.model as string|undefined,
            ...durableChatTurnOptions(binding.input,actor),
            // Signed-in app turn: "/status" gets the free ingest report, as in the streaming route.
            answerIngestReport:true,
            actor,allowAgentTools:env.publicChatAgentEnabled,allowConfiguration:false,signal,
            onTextDelta,
            onToolActivity:event=>{void append("tool",event);},onEvidence:event=>{void append("evidence",event);},
          })));
      } catch(error) {
        // Text streamed before a model or tool failure is still output, as it
        // was before coalescing; after cancellation or abort the buffer is gone.
        if(!signal.aborted)await flushText().catch(()=>{});
        throw error;
      }
      await flushText();await pending;signal.throwIfAborted();
      await append("result",result);
      const events=await pubsub.getHistory(operationOutputTopic(task.id));
      return {result:{...result,tools,...(evidence===undefined?{}:{evidence})},watermark:(events.at(-1)?.index ?? -1)+1};
    } finally {
      clearInterval(timer);if(flushTimer)clearTimeout(flushTimer);buffered="";
      await pending.catch(()=>{});
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
