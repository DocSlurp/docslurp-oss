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
    const [row] = await sql<{id:string;root_id:string;parent_id:string|null;user_id:string;org_id:string;project_id:string;deadline:Date;output_bytes:number;cancel_requested:boolean;tree_cancel_requested:boolean}[]>`
      select c.id,c.root_id,c.parent_id,c.user_id,c.org_id,c.project_id,c.deadline,c.output_bytes,c.cancel_requested,root.tree_cancel_requested
      from chat_operations c join chat_operations root on root.id=c.root_id and root.user_id=c.user_id and root.org_id=c.org_id
      where c.id=${id} and c.user_id=${actor.userId} and c.expires_at>clock_timestamp()`;
    if (!row) throw new Error("operation_forbidden");
    const project=await loadActorScopedProject(row.project_id,actor,{refineNames:false});
    if (!project || project.orgId!==row.org_id)throw new Error("operation_forbidden");
    return {id:row.id,rootId:row.root_id,parentId:row.parent_id,userId:row.user_id,orgId:row.org_id,projectId:row.project_id,deadline:row.deadline,outputBytes:row.output_bytes,cancelRequested:row.cancel_requested,treeCancelled:row.tree_cancel_requested};
  };
  return {
    authorize,
    async listTree(binding) {
      const rows=await sql<{id:string}[]>`select id from chat_operations where root_id=${binding.rootId}
        and user_id=${binding.userId} and runtime='mastra' and expires_at>clock_timestamp() order by created_at,id limit 65`;
      if(rows.length>64)throw new Error("operation_tree_limit");
      return rows.map(row=>row.id);
    },
    async serializeAcceptance(binding,work) {
      const actor=await resolveActor();
      if(actor?.type!=="session"||actor.userId!==binding.userId)throw new Error("operation_forbidden");
      return sql.begin(async tx=>{
        const [root]=await tx`select id,tree_cancel_requested from chat_operations where id=${binding.rootId} and user_id=${binding.userId} for update`;
        if(!await revalidateRealtimeSession(actor,AbortSignal.timeout(5000),tx))throw new Error("operation_forbidden");
        const [access]=await tx`select w.id from projects w
          where w.id=${binding.projectId} and w.org_id=${binding.orgId}
            and docslurp_project_access(w.id,${actor.userId})`;
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
