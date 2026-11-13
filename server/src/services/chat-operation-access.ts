import { realtimeCanaryOrgAllowed } from "../realtime/rollout-scope.js";
import { nativeOperations } from "../agent-runtime/runtime.js";
import { readChatRunDependencies } from "./chat-run-dependencies.js";
import { sql } from "../db.js";
import { loadActorScopedProject, type RequestActor } from "../lib/request-actor.js";
import { operationHub } from "../realtime/operation-hub.js";
import { revalidateOperationScopes } from "../realtime/operation-authorization.js";
import { readChatOperation, type Operation } from "./chat-operations.js";

export async function authorizeChatOperation(actor: RequestActor, id: string) {
  if (actor.type !== "session") throw new Error("operation_forbidden");
  const [row] = await sql<{ project_id: string; org_id: string }[]>`select project_id,org_id from chat_operations where id=${id} and user_id=${actor.userId} and expires_at > now()`;
  const project = row && await loadActorScopedProject(row.project_id, actor);
  if (!project || project.orgId !== row!.org_id) throw new Error("operation_forbidden");
  return project;
}

/** HTTP and socket recovery use identical authorized task summaries and cursor semantics. */
export async function authorizedChatOperationSnapshot(actor: RequestActor, id: string, after: number) {
  await authorizeChatOperation(actor, id);
  const [binding]=await sql<{runtime:string}[]>`select runtime from chat_operations where id=${id} and user_id=${actor.userId}`;
  if(binding?.runtime==="mastra") {
    const recovery=await (await nativeOperations(async()=>actor)).read(id,after);
    const dependencies=await readChatRunDependencies(recovery.operation.root_id,actor.userId);
    for(const dependency of dependencies) {
      const project=await loadActorScopedProject(dependency.project_id,actor);
      if(project?.orgId!==dependency.org_id)throw new Error("operation_forbidden");
    }
    await authorizeChatOperation(actor,id);
    return {...recovery,dependencies,treeSettled:recovery.treeSettled&&dependencies.every(
      task=>["completed","failed","cancelled","interrupted"].includes(task.status))};
  }
  const recovery = await readChatOperation(actor.userId, id, after);
  if (!recovery) throw new Error("operation_expired");
  const tasks = await sql<Omit<Operation, "input" | "request_hash" | "snapshot">[]>`
    select id,root_id,parent_id,user_id,project_id,org_id,status,attempt_id,sequence,cancel_requested,tree_cancel_requested
    from chat_operations where root_id=${recovery.operation.root_id} and user_id=${actor.userId}
      and expires_at>now() order by created_at,id limit 64`;
  const dependencies = await readChatRunDependencies(recovery.operation.root_id, actor.userId);
  const scopes = new Map<string, string>();
  for (const task of [...tasks, ...dependencies]) {
    if (!scopes.has(task.project_id)) {
      const project = await loadActorScopedProject(task.project_id, actor);
      if (!project) throw new Error("operation_forbidden");
      scopes.set(task.project_id, project.orgId);
    }
    if (scopes.get(task.project_id) !== task.org_id) throw new Error("operation_forbidden");
  }
  return { ...recovery, tasks, dependencies, treeSettled: dependencies.every(task => ["completed","failed","cancelled","interrupted"].includes(task.status)) && tasks.every(task => ["completed","failed","cancelled","interrupted"].includes(task.status)) };
}

/** Socket host must supply a callback that revalidates the live session (including revocation).
 * No credentials are stored by this provider. Each read and delivery reauthorizes.
 */
export function createChatOperationProvider(resolveActor: (userId: string) => Promise<RequestActor | null>) {
  return {
    async subscribe(input: {
      userId: string; resource: { kind: "operation"; operationId: string; after: number }; signal: AbortSignal;
      observer: { snapshot(data: unknown, sequence: number): Promise<void>; append(data: unknown, sequence: number): Promise<void>; resync(data: unknown, sequence: number, code: string): Promise<void> };
    }) {
      let closed = false;
      let cursor = input.resource.after;
      let first = true;
      let detach: (() => void) | undefined;
      const verification = new AbortController();
      const close = async () => { closed = true; verification.abort(); detach?.(); input.signal.removeEventListener("abort", close); };
      const authorize = async (id: string) => {
        const actor = await resolveActor(input.userId);
        if (!actor || actor.userId !== input.userId) throw new Error("operation_forbidden");
        const project = await authorizeChatOperation(actor, id);
        if (!realtimeCanaryOrgAllowed(project.orgId)) throw new Error("operation_forbidden");
      };
      const tick = async () => {
        if (closed || input.signal.aborted) return null;
        const actor = await resolveActor(input.userId);
        if (!actor || actor.userId !== input.userId) throw new Error("operation_forbidden");
        const recovery = await operationHub.shareRecovery(JSON.stringify([actor.userId, input.resource.operationId, cursor]),
          () => authorizedChatOperationSnapshot(actor, input.resource.operationId, cursor));
        await authorize(input.resource.operationId);
        await revalidateOperationScopes(actor.userId, input.resource.operationId, verification.signal);
        if (closed || input.signal.aborted) return null;
        if (Buffer.byteLength(JSON.stringify(recovery)) > 524_288) throw new Error("operation_snapshot_limit");
        if (recovery.resync) await input.observer.resync(recovery, recovery.watermark, "cursor_invalid");
        else if (first) await input.observer.snapshot(recovery, recovery.events.at(-1)?.sequence ?? cursor);
        else await input.observer.append(recovery, recovery.events.at(-1)?.sequence ?? cursor);
        first = false;
        cursor = recovery.resync ? recovery.watermark : recovery.events.at(-1)?.sequence ?? cursor;
        return recovery;
      };
      input.signal.addEventListener("abort", close, { once: true });
      try {
        const initial = await tick();
        if (initial && !closed && !input.signal.aborted) detach = operationHub.watch({
          rootId: initial.operation.root_id, userId: input.userId,
          refresh: async () => (await tick())?.hasMore ?? false,
          failed: async () => { await close(); await input.observer.resync({ error: "operation_unavailable" }, cursor, "operation_unavailable"); },
        });
      } catch (error) { await close(); throw error; }
      return { close, revalidate: async () => {
        if (closed || input.signal.aborted) throw new Error("operation_forbidden");
        const actor = await resolveActor(input.userId);
        if (!actor || actor.type !== "session" || actor.userId !== input.userId) throw new Error("operation_forbidden");
        // Read identities only: no Redis output, page-ledger projection, or
        // operation-hub dependency. Idle revocation must work if those stall.
        await revalidateOperationScopes(actor.userId, input.resource.operationId, verification.signal);
        if (closed || input.signal.aborted) throw new Error("operation_forbidden");
      } };
    },
  };
}
