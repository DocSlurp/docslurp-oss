import { sql } from "../db.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { getRequestActor, loadActorScopedWorkspace, resolveActorWorkspaceId } from "../lib/request-actor.js";
import { authorizedChatOperationSnapshot, authorizeChatOperation } from "../services/chat-operation-access.js";
import { cancelChatOperation, launchChatOperation, readChatOperation } from "../services/chat-operations.js";
import { workspaceChatDisabledBody } from "../services/workspace-chat.js";

const launchSchema = z.object({ q: z.string().trim().min(1).max(64_000), workspace: z.string().max(128).optional(), sessionId: z.string().max(128).optional(), model: z.string().max(128).optional() }).strict();
/** Session-only, opt-in route. Legacy API-key chat retains its existing contract. */
export const chatOperationRoutes = new Hono()
  .onError((_error,c) => c.json({error:"operation_unavailable"},409))
  .use("*", async (c, next) => {
    if (process.env.DOCSLURP_DURABLE_CHAT !== "1") return c.json({ error: "not_enabled" }, 404);
    if (getRequestActor(c).type !== "session") return c.json({ error: "session_required" }, 403);
    try { await next(); } catch { return c.json({ error: "operation_unavailable" }, 409); }
  })
  .get("/", async c => {
    const actor = getRequestActor(c);
    const rows = await sql<{id:string}[]>`select id from chat_operations where user_id=${actor.userId} and parent_id is null and expires_at > now() order by created_at desc limit 64`;
    const operations = [];
    for (const row of rows) {
      try { await authorizeChatOperation(actor,row.id); const state = await readChatOperation(actor.userId,row.id,0); if (state) operations.push({id:state.operation.id,status:state.operation.status,sequence:state.operation.sequence}); } catch { /* revoked resources never enter discovery */ }
    }
    return c.json({operations});
  })
  .post("/", durableChatLaunchHandler)
  .get("/:id", async c => {
    const actor = getRequestActor(c);
    await authorizeChatOperation(actor, c.req.param("id"));
    return c.json(await authorizedChatOperationSnapshot(actor, c.req.param("id"), Number(c.req.query("after") ?? 0)));
  })
  .post("/:id/cancel", async c => {
    const actor = getRequestActor(c);
    await authorizeChatOperation(actor, c.req.param("id"));
    const { scope } = z.object({ scope: z.enum(["task", "tree"]) }).strict().parse(await c.req.json());
    await cancelChatOperation(actor.userId, c.req.param("id"), scope);
    return c.json({ accepted: true });
  });

export async function durableChatLaunchHandler(c: Context) {
  if (Number(c.req.header("content-length") ?? 0) > 128_000) return c.json({ error: "input_too_large" }, 413);
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const {done,value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 128_000) { await reader.cancel(); return c.json({error:"input_too_large"},413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = launchSchema.parse(JSON.parse(raw));
  const actor = getRequestActor(c);
  if (actor.type !== "session") return c.json({ error: "forbidden" }, 403);
  const id = await resolveActorWorkspaceId(actor, body.workspace);
  const workspace = await loadActorScopedWorkspace(id, actor);
  if (!workspace?.orgId || await workspaceChatDisabledBody(id, actor.userId)) return c.json({ error: "forbidden" }, 403);
  const task = await launchChatOperation({ userId: actor.userId, workspaceId: id, orgId: workspace.orgId, key: c.req.header("Idempotency-Key") ?? "", input: { ...body, authSessionId: actor.sessionId } });
  return c.json({ operationId: task.id, rootId: task.root_id, status: task.status }, 202);
}
