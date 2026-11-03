import { createHash, randomUUID } from "node:crypto";
import { sql } from "../db.js";

export const CHAT_OPERATION_LIMITS = { outputBytes: 262_144, treeOutputBytes: 524_288, tasks: 64, activeRoots: 8, replay: 256, recoveryBytes: 393_216, retentionDays: 7 } as const;
export type OperationStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
export interface Operation {
  id: string; root_id: string; parent_id: string | null; user_id: string; workspace_id: string; org_id: string;
  status: OperationStatus; attempt_id: string | null; sequence: number; snapshot: Record<string, unknown>;
  cancel_requested: boolean; tree_cancel_requested: boolean; request_hash: string; input: Record<string, unknown>;
}
export class OperationConflict extends Error {}
export const terminalOperation = (status: OperationStatus) => ["completed", "failed", "cancelled", "interrupted"].includes(status);

/** The caller must resolve workspace permission before launch. Root locking serializes child launch/cancel. */
export async function launchChatOperation(args: { userId: string; workspaceId: string; orgId: string; key: string; input: Record<string, unknown>; parentId?: string }) {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(args.key) || Buffer.byteLength(JSON.stringify(args.input)) > 128_000) throw new OperationConflict("Invalid launch size or idempotency key");
  const { authSessionId: _authSessionId, ...semanticInput } = args.input;
  const hash = createHash("sha256").update(JSON.stringify(semanticInput)).digest("hex");
  return sql.begin(async tx => {
    // Tenant owner lock also bounds concurrent root launches and duplicate keys.
    await tx`select id from "user" where id = ${args.userId} for update`;
    const [existing] = await tx<Operation[]>`select * from chat_operations where user_id=${args.userId} and workspace_id=${args.workspaceId} and idempotency_key=${args.key}`;
    if (existing) {
      if (existing.request_hash !== hash || existing.parent_id !== (args.parentId ?? null)) throw new OperationConflict("Idempotency key reused with different input");
      return existing;
    }
    const id = randomUUID();
    let rootId: string = id;
    if (args.parentId) {
      const [parent] = await tx<Operation[]>`select * from chat_operations where id=${args.parentId} and user_id=${args.userId} and workspace_id=${args.workspaceId} and org_id=${args.orgId}`;
      if (!parent) throw new OperationConflict("Parent unavailable");
      const [root] = await tx<Operation[]>`select * from chat_operations where id=${parent.root_id} for update`;
      const [currentParent] = await tx<Operation[]>`select * from chat_operations where id=${parent.id}`;
      if (!root || root.tree_cancel_requested || currentParent!.cancel_requested || currentParent!.status === "interrupted") throw new OperationConflict("Tree cancelled or interrupted");
      const [{ count }] = await tx<{ count: number }[]>`select count(*)::int as count from chat_operations where root_id=${root.id}`;
      if (count >= CHAT_OPERATION_LIMITS.tasks) throw new OperationConflict("Task tree limit");
      rootId = root.id;
    }
    // Parent completion does not release a tree's capacity while children run.
    // Apply the same bound when a child would reactivate a settled tree.
    const [{ count, alreadyActive }] = await tx<{ count: number; alreadyActive: boolean }[]>`
      select count(distinct root_id)::int as count, coalesce(bool_or(root_id=${rootId}),false) as "alreadyActive"
      from chat_operations where user_id=${args.userId} and status in ('queued','running','waiting')`;
    if (!alreadyActive && count >= CHAT_OPERATION_LIMITS.activeRoots) throw new OperationConflict("Active operation limit");
    const [row] = await tx<Operation[]>`insert into chat_operations (id, root_id, parent_id, user_id, workspace_id, org_id, idempotency_key, request_hash, input)
      values (${id}, ${rootId}, ${args.parentId ?? null}, ${args.userId}, ${args.workspaceId}, ${args.orgId}, ${args.key}, ${hash}, ${tx.json(args.input as never)}) returning *`;
    if (args.parentId) await tx`update chat_operations set deadline=(select deadline from chat_operations where id=${rootId}), expires_at=(select expires_at from chat_operations where id=${rootId}) where id=${id}`;
    return row!;
  });
}

/** Claim once. An expired running attempt is interrupted, never queued for another paid call. */
export async function claimChatOperation() {
  return sql.begin(async tx => {
    await tx`with changed as (
      update chat_operations set status='interrupted', sequence=sequence+1, lease_until=null, snapshot=snapshot || '{"error":"executor_interrupted"}'::jsonb
      where status='running' and lease_until < now() returning id,sequence
    ) insert into chat_operation_events select id,sequence,'interrupted','{"code":"executor_interrupted"}'::jsonb from changed`;
    await tx`with changed as (
      update chat_operations set status='cancelled',sequence=sequence+1 where status in ('queued','waiting') and (cancel_requested or deadline < now()) returning id,sequence
    ) insert into chat_operation_events select id,sequence,'cancelled','{"code":"cancelled_or_deadline"}'::jsonb from changed`;
    const [row] = await tx<Operation[]>`select * from chat_operations where status='queued' and expires_at > now() order by created_at for update skip locked limit 1`;
    if (!row) return null;
    const [claimed] = await tx<Operation[]>`update chat_operations set status='running', attempt_id=${randomUUID()}, lease_until=clock_timestamp()+interval '30 seconds' where id=${row.id} returning *`;
    return claimed!;
  });
}

/** Each accepted chunk is committed before its sequence can be returned to any observer. */
export async function appendChatOperation(id: string, attempt: string, kind: string, payload: unknown, status?: OperationStatus) {
  const terminalError = kind === "error" && (status === "failed" || status === "cancelled" || status === "interrupted");
  return sql.begin(async tx => {
    const [task] = await tx<Operation[]>`select * from chat_operations where id=${id}`;
    if (!task) throw new OperationConflict("Operation unavailable");
    await tx`select id from chat_operations where id=${task.root_id} for update`;
    const [current] = await tx<Operation[]>`select * from chat_operations where id=${id} for update`;
    // Store the final answer once: streamed text already owns its budget and replay.
    let storedPayload = payload;
    if (kind === "result" && payload && typeof payload === "object" && "answer" in payload
      && typeof payload.answer === "string" && payload.answer === current!.snapshot.text) {
      const { answer: _answer, ...metadata } = payload;
      storedPayload = { ...metadata, __answerFromText: true };
    }
    const encoded = JSON.stringify(storedPayload);
    const [{ bytes }] = await tx<{ bytes: number }[]>`select coalesce(sum(output_bytes),0)::int as bytes from chat_operations where root_id=${task.root_id}`;
    if (bytes + Buffer.byteLength(encoded) > CHAT_OPERATION_LIMITS.treeOutputBytes && kind !== "error") throw new OperationConflict("Tree output budget exhausted");
    const [row] = await tx<Operation[]>`update chat_operations set sequence=sequence+1, output_bytes=output_bytes+${Buffer.byteLength(encoded)},
      snapshot=case
        when ${kind}='result' then snapshot || ${tx.json(storedPayload as never)}
        when ${kind}='text' then jsonb_set(snapshot,'{text}',to_jsonb(coalesce(snapshot->>'text','') || coalesce(${tx.json(storedPayload as never)}->>'text','')))
        when ${kind}='tool' then jsonb_set(snapshot,'{tools}',coalesce(snapshot->'tools','[]'::jsonb) || jsonb_build_array(${tx.json(storedPayload as never)}))
        else jsonb_set(snapshot,array[${kind}::text],${tx.json(storedPayload as never)}) end,
      status=case when ${terminalError} and (cancel_requested or deadline <= clock_timestamp())
        then 'cancelled' else coalesce(${status ?? null}, status) end
      where id=${id} and attempt_id=${attempt} and status='running' and lease_until > clock_timestamp()
        and (${terminalError} or (not cancel_requested and deadline > clock_timestamp()))
        and (output_bytes+${Buffer.byteLength(encoded)} <= ${CHAT_OPERATION_LIMITS.outputBytes} or ${kind === "error"})
      returning *`;
    if (!row) throw new OperationConflict("Execution lease lost or output limit reached");
    await tx`insert into chat_operation_events values (${id},${row.sequence},${kind},${tx.json(storedPayload as never)})`;
    return row.sequence;
  });
}

export async function heartbeatChatOperation(id: string, attempt: string) {
  const [row] = await sql`update chat_operations set lease_until=clock_timestamp()+interval '30 seconds'
    where id=${id} and attempt_id=${attempt} and status='running' and lease_until > clock_timestamp() and not cancel_requested and deadline > clock_timestamp() returning id`;
  return !!row;
}

/** Internal data adapter: authorization is mandatory in the exported socket/HTTP adapter. */
export async function readChatOperation(userId: string, id: string, after: number) {
  if (!Number.isSafeInteger(after) || after < 0) throw new OperationConflict("Invalid cursor");
  return sql.begin(async tx => {
    const [operation] = await tx<Operation[]>`select * from chat_operations where id=${id} and user_id=${userId} and expires_at > now() for share`;
    if (!operation) return null;
    const events = await tx<{ sequence: number; kind: string; payload: unknown }[]>`select sequence,kind,payload from chat_operation_events where operation_id=${id} and sequence::bigint > ${after}::bigint and sequence <= ${operation.sequence} order by sequence limit ${CHAT_OPERATION_LIMITS.replay}`;
    // Expired/future cursors receive a replacement snapshot, never silently omit output.
    let resync = after > operation.sequence || (after < operation.sequence && events[0]?.sequence !== after + 1);
    const hydrateResult = (value: unknown): unknown => {
      if (!value || typeof value !== "object" || !("__answerFromText" in value) || value.__answerFromText !== true) return value;
      const { __answerFromText: _reference, ...metadata } = value;
      return { ...metadata, answer: operation.snapshot.text };
    };
    let output = resync ? [] : events.map(event => event.kind === "result" ? { ...event, payload: hydrateResult(event.payload) } : event);
    operation.snapshot = hydrateResult(operation.snapshot) as Record<string, unknown>;
    // A final snapshot needs only the authoritative answer, not a second text copy.
    if (operation.snapshot.answer === operation.snapshot.text) delete operation.snapshot.text;
    // Large replay pages recover from the authoritative watermark instead of
    // overflowing the socket. Leave space for the bounded task-tree envelope.
    if (Buffer.byteLength(JSON.stringify({ snapshot: operation.snapshot, events: output })) > CHAT_OPERATION_LIMITS.recoveryBytes) {
      resync = true;
      output = [];
    }
    const { input: _input, request_hash: _hash, ...safe } = operation;
    return { operation: safe, events: output, resync, watermark: operation.sequence, hasMore: !resync && events.length === CHAT_OPERATION_LIMITS.replay && events.at(-1)!.sequence < operation.sequence };
  });
}

export async function cancelChatOperation(userId: string, id: string, scope: "task" | "tree") {
  return sql.begin(async tx => {
    const [task] = await tx<Operation[]>`select * from chat_operations where id=${id} and user_id=${userId}`;
    if (!task) return false;
    await tx`select id from chat_operations where id=${task.root_id} for update`;
    if (scope === "tree" && task.id !== task.root_id) throw new OperationConflict("Tree cancellation requires root");
    if (scope === "tree") await tx`update chat_operations set tree_cancel_requested=true where id=${id}`;
    await tx`with changed as (
      update chat_operations set cancel_requested=true, sequence=sequence+1,
        status=case when status in ('queued','waiting') then 'cancelled' else status end
      where user_id=${userId} and not cancel_requested and (id=${id} or (${scope === "tree"} and root_id=${id})) returning id,sequence
    ) insert into chat_operation_events select id,sequence,'cancel_requested','{}'::jsonb from changed`;
    return true;
  });
}

export async function cleanupChatOperations() {
  // Whole trees expire together: never cascade a live child's history away.
  await sql`delete from chat_operations r where r.parent_id is null and r.expires_at < now()
    and not exists (select 1 from chat_operations c where c.root_id=r.id and c.status in ('queued','running','waiting'))`;
}
