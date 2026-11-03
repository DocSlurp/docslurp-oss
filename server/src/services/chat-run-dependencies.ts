import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql } from "../db.js";
import type { Operation } from "./chat-operations.js";

// Server-only execution context: never accept operation identity from a tool argument.
type RunOwner = Pick<Operation, "id" | "user_id" | "org_id"> & {attempt_id?:string|null;nativeTaskId?:string;nativeOwnerId?:string};
const owner = new AsyncLocalStorage<RunOwner>();
export function withChatRunOwner<T>(task: Operation, work: () => Promise<T>) { return owner.run(task, work); }

export function withNativeChatRunOwner<T>(task: RunOwner & {nativeTaskId:string;nativeOwnerId:string}, work:()=>Promise<T>) {return owner.run(task,work);}

/** Acceptance and run allocation commit together under the root cancellation lock.
 * Already accepted page work is a shared dependency, not a cancellable child.
 * Its existing Temporal/page locks, deadlines and credit caps remain authoritative.
 */
export async function acceptChatRunDependency<T>(scope: {
  userId: string; orgId: string; workspaceId: string; documentId: string; pages: number[];
}, allocate: (tx: postgres.Sql | postgres.TransactionSql) => Promise<{ runId: string; value: T }>): Promise<T> {
  const task = owner.getStore();
  if (!task) return (await allocate(sql)).value;
  return sql.begin(async tx => {
    if (task) {
      if (task.user_id !== scope.userId || task.org_id !== scope.orgId) throw new Error("dependency_forbidden");
      const [root] = await tx`select r.id from chat_operations c join chat_operations r on r.id=c.root_id
        where c.id=${task.id} for update of r`;
      const [active] = task.nativeTaskId ? await tx`
        select c.id from chat_operations c join docslurp_mastra.mastra_background_tasks t on t.tool_call_id=c.id
        where c.id=${task.id} and c.runtime='mastra' and not c.cancel_requested and c.deadline>clock_timestamp()
          and t.id=${task.nativeTaskId} and t."ownerId"=${task.nativeOwnerId!}
          and t.status='running' and t."leaseExpiresAtZ">clock_timestamp()
          and not exists(select 1 from chat_operations where id=${root?.id ?? ""} and tree_cancel_requested)
        for share of t` : await tx`select id from chat_operations where id=${task.id} and attempt_id=${task.attempt_id ?? null}
        and status='running' and not cancel_requested and deadline>clock_timestamp() and lease_until>clock_timestamp()
        and not exists(select 1 from chat_operations where id=${root?.id ?? ""} and tree_cancel_requested)`;
      const [document] = await tx`select d.id from documents d join workspaces w on w.id=d.workspace_id
        where d.id=${scope.documentId} and d.workspace_id=${scope.workspaceId} and w.org_id=${scope.orgId}`;
      if (!root || !active || !document) throw new Error("dependency_forbidden_or_cancelled");
      const [count] = await tx`select (select count(*) from chat_operations where root_id=${root.id}) +
        (select count(*) from chat_run_dependencies d join chat_operations c on c.id=d.operation_id where c.root_id=${root.id}) as n`;
      if (Number(count!.n)>=64 || !scope.pages.length || scope.pages.length>256) throw new Error("dependency_limit");
    }
    const result = await allocate(tx);
    if (task) await tx`insert into chat_run_dependencies(id,operation_id,run_id,document_id,pages)
      values (${randomUUID()},${task.id},${result.runId},${scope.documentId},${tx.array(scope.pages,23)})`;
    return result.value;
  }) as Promise<T>;
}

/** Caller authorizes every returned workspace before delivery. No artifact bytes or URLs. */
export async function readChatRunDependencies(rootId: string, userId: string) {
  return sql`select d.id, d.operation_id as parent_id, c.root_id, r.id as run_id, r.workspace_id, r.org_id,
    case when r.stats->>'deduplicated'='true' then null else r.execution_generation end as attempt_id, r.status as run_status, r.stage, r.control_state,
    d.document_id, d.pages, jsonb_build_object('documentId',d.document_id,'pages',d.pages) as result_ref,
    coalesce(p.attempts,0)::int as page_attempts, greatest(r.updated_at,p.updated_at) as revision, r.stats->>'deduplicated' as deduplicated,
    coalesce(p.ready,0)::int as ready_pages, coalesce(p.failed,0)::int as failed_pages,
    'shared' as ownership, 'observe_only' as cancellation,
    case when coalesce(p.ready,0)=cardinality(d.pages) then 'completed'
      when coalesce(p.ready,0)+coalesce(p.failed,0)=cardinality(d.pages) and coalesce(p.failed,0)>0 then 'failed'
      when r.status in ('failed','cancelled') then r.status
      when d.created_at+interval '15 minutes'<now() then 'interrupted'
      else 'waiting' end as status
    from chat_run_dependencies d join chat_operations c on c.id=d.operation_id
    join workspace_runs r on r.id=d.run_id
    left join lateral (select count(*) filter(where state='indexed') as ready,
      count(*) filter(where state in ('failed','blocked-pii')) as failed, max(attempts) as attempts, max(updated_at) as updated_at
      from document_page_states where document_id=d.document_id and page_number=any(d.pages)) p on true
    where c.root_id=${rootId} and c.user_id=${userId} and c.expires_at>now()
    order by d.created_at,d.id limit 64`;
}
