import { sql } from "../db.js";
import { loadActorScopedWorkspace, type RequestActor } from "../lib/request-actor.js";
import { readChatOperation } from "./chat-operations.js";

export async function authorizeChatOperation(actor: RequestActor, id: string) {
  if (actor.type !== "session") throw new Error("operation_forbidden");
  const [row] = await sql<{ workspace_id: string; org_id: string }[]>`select workspace_id,org_id from chat_operations where id=${id} and user_id=${actor.userId} and expires_at > now()`;
  const workspace = row && await loadActorScopedWorkspace(row.workspace_id, actor);
  if (!workspace || workspace.orgId !== row!.org_id) throw new Error("operation_forbidden");
  return workspace;
}

/** HTTP and socket recovery use identical authorized task summaries and cursor semantics. */
export async function authorizedChatOperationSnapshot(actor: RequestActor, id: string, after: number) {
  await authorizeChatOperation(actor, id);
  const recovery = await readChatOperation(actor.userId, id, after);
  if (!recovery) throw new Error("operation_expired");
  const children = await sql<{ id: string }[]>`select id from chat_operations where root_id=${recovery.operation.root_id} and user_id=${actor.userId} order by created_at limit 64`;
  const tasks = [];
  for (const child of children) {
    await authorizeChatOperation(actor, child.id);
    const state = await readChatOperation(actor.userId, child.id, Number.MAX_SAFE_INTEGER);
    if (state) { const { snapshot: _snapshot, ...summary } = state.operation; tasks.push(summary); }
  }
  return { ...recovery, tasks, treeSettled: tasks.every(task => ["completed","failed","cancelled","interrupted"].includes(task.status)) };
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const close = async () => { closed = true; clearTimeout(timer); input.signal.removeEventListener("abort", close); };
      const authorize = async (id: string) => {
        const actor = await resolveActor(input.userId);
        if (!actor || actor.userId !== input.userId) throw new Error("operation_forbidden");
        await authorizeChatOperation(actor, id);
      };
      const tick = async () => {
        if (closed || input.signal.aborted) return;
        await authorize(input.resource.operationId);
        const actor = await resolveActor(input.userId);
        if (!actor || actor.userId !== input.userId) throw new Error("operation_forbidden");
        const recovery = await authorizedChatOperationSnapshot(actor, input.resource.operationId, cursor);
        await authorize(input.resource.operationId);
        if (closed || input.signal.aborted) return;
        if (Buffer.byteLength(JSON.stringify(recovery)) > 524_288) throw new Error("operation_snapshot_limit");
        if (recovery.resync) await input.observer.resync(recovery, recovery.watermark, "cursor_invalid");
        else if (first) await input.observer.snapshot(recovery, recovery.events.at(-1)?.sequence ?? cursor);
        else await input.observer.append(recovery, recovery.events.at(-1)?.sequence ?? cursor);
        first = false;
        cursor = recovery.resync ? recovery.watermark : recovery.events.at(-1)?.sequence ?? cursor;
        timer = setTimeout(() => { void tick().catch(async () => { await close(); await input.observer.resync({ error: "operation_unavailable" }, cursor, "operation_unavailable"); }); }, recovery.hasMore ? 0 : 1000);
        timer.unref?.();
      };
      input.signal.addEventListener("abort", close, { once: true });
      try { await tick(); } catch (error) { await close(); throw error; }
      return { close };
    },
  };
}
