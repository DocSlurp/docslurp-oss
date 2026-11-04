import { revalidateRealtimeSession } from "../realtime/session.js";
import { sql } from "../db.js";
import { loadActorScopedProject, type RequestActor } from "../lib/request-actor.js";
import type { NativeOperationBinding, NativeOperationPolicy } from "./native-operations.js";

/** Application binding policy. The chat_operations row is identity/idempotency,
 * tenant scope, cancellation intent and budget metadata; Mastra owns execution.
 */
export function createNativeOperationPolicy(resolveActor: () => Promise<RequestActor | null>): NativeOperationPolicy {
  const authorize = async (id: string): Promise<NativeOperationBinding> => {
    const actor = await resolveActor();
    if (!actor || actor.type !== "session") throw new Error("operation_forbidden");
    if (!await revalidateRealtimeSession(actor,AbortSignal.timeout(5000))) throw new Error("operation_forbidden");
    const [row] = await sql<{id:string;root_id:string;user_id:string;org_id:string;project_id:string;deadline:Date;output_bytes:number}[]>`
      select id,root_id,user_id,org_id,project_id,deadline,output_bytes from chat_operations
      where id=${id} and user_id=${actor.userId} and expires_at>clock_timestamp()`;
    if (!row) throw new Error("operation_forbidden");
    const project=await loadActorScopedProject(row.project_id,actor,{refineNames:false});
    if (!project || project.orgId!==row.org_id)throw new Error("operation_forbidden");
    return {id:row.id,rootId:row.root_id,userId:row.user_id,orgId:row.org_id,projectId:row.project_id,deadline:row.deadline,outputBytes:row.output_bytes};
  };
  return {
    authorize,
    async serializeAcceptance(binding,work) {
      const actor=await resolveActor();
      if(actor?.type!=="session"||actor.userId!==binding.userId)throw new Error("operation_forbidden");
      return sql.begin(async tx=>{
        const [root]=await tx`select id,tree_cancel_requested from chat_operations where id=${binding.rootId} and user_id=${binding.userId} for update`;
        if(!await revalidateRealtimeSession(actor,AbortSignal.timeout(5000),tx))throw new Error("operation_forbidden");
        const [access]=await tx`select w.id from projects w join organizations o on o.id=w.org_id
          left join org_memberships om on om.org_id=w.org_id and om.user_id=${actor.userId}
          left join project_members wm on wm.project_id=w.id and wm.user_id=${actor.userId}
          where w.id=${binding.projectId} and w.org_id=${binding.orgId} and (
            (om.user_id is not null and (w.user_id=${actor.userId} or w.is_default or om.role in ('owner','admin') or wm.user_id is not null))
            or (wm.user_id is not null and o.is_personal))`;
        if(!access)throw new Error("operation_forbidden");
        const [current]=await tx`select id from chat_operations where id=${binding.id} and user_id=${binding.userId}
          and not cancel_requested and deadline>clock_timestamp() and expires_at>clock_timestamp()`;
        if(!root||root.tree_cancel_requested||!current)throw new Error("operation_cancelled_or_expired");
        return work();
      }) as ReturnType<typeof work>;
    },
    async recordCancellation(binding,scope) {
      await sql.begin(async tx=>{
        await tx`select id from chat_operations where id=${binding.rootId} and user_id=${binding.userId} for update`;
        if(scope==="tree")await tx`update chat_operations set tree_cancel_requested=true where id=${binding.rootId} and user_id=${binding.userId}`;
        await tx`update chat_operations set cancel_requested=true
          where user_id=${binding.userId} and (id=${binding.id} or (${scope==="tree"} and root_id=${binding.rootId}))`;
      });
    },
  };
}
