import { nativeOperations } from "../agent-runtime/runtime.js";
import { sql } from "../db.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { getRequestActor, loadActorScopedProject, resolveActorProjectId } from "../lib/request-actor.js";
import { authorizedChatOperationSnapshot, authorizeChatOperation } from "../services/chat-operation-access.js";
import { cancelChatOperation, launchChatOperation, readChatOperation } from "../services/chat-operations.js";
import { projectChatDisabledBody } from "../services/project-chat.js";
import { revalidateRealtimeSession } from "../realtime/session.js";

const launchSchema = z.object({ q: z.string().trim().min(1).max(64_000), project: z.string().max(128).optional(), sessionId: z.string().max(128).optional(), model: z.string().max(128).optional() }).strict();
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
      try { await authorizeChatOperation(actor,row.id); const state = await authorizedChatOperationSnapshot(actor,row.id,0); if (state) operations.push({id:state.operation.id,status:state.operation.status,sequence:state.operation.sequence}); } catch { /* revoked resources never enter discovery */ }
    }
    return c.json({operations});
  })
  .post("/", c => durableChatLaunchHandler(c))
  .post("/:id/tasks", c => durableChatLaunchHandler(c, z.uuid().parse(c.req.param("id"))))
  .post("/:id/retry", async c => {
    const id=z.uuid().parse(c.req.param("id"));
    // No replacement query/model/native identity is accepted on a retry.
    if(Number(c.req.header("content-length")??0)>256)return c.json({error:"input_too_large"},413);
    const reader=c.req.raw.body?.getReader();
    let raw="";let bytes=0;
    if(reader)try {
      const decoder=new TextDecoder();
      for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;
        if(bytes>256){await reader.cancel();return c.json({error:"input_too_large"},413);}raw+=decoder.decode(value,{stream:true});}
      raw+=decoder.decode();
    }finally{reader.releaseLock();}
    const body=z.object({authorizeNewAttempt:z.literal(true),observedAttemptId:z.string().min(1).max(128)}).strict().parse(JSON.parse(raw));
    const actor=getRequestActor(c);
    const project=await authorizeChatOperation(actor,id);
    if(await projectChatDisabledBody(project.id,actor.userId))return c.json({error:"forbidden"},403);
    const accepted=await (await nativeOperations(async()=>actor)).retry(id,c.req.header("Idempotency-Key")??"",body.observedAttemptId);
    return c.json({operationId:accepted.operationId,rootId:accepted.rootId,status:accepted.status},202);
  })
  .get("/:id", async c => {
    const actor = getRequestActor(c);
    await authorizeChatOperation(actor, c.req.param("id"));
    return c.json(await authorizedChatOperationSnapshot(actor, c.req.param("id"), Number(c.req.query("after") ?? 0)));
  })
  .post("/:id/cancel", async c => {
    const actor = getRequestActor(c);
    await authorizeChatOperation(actor, c.req.param("id"));
    const { scope } = z.object({ scope: z.enum(["task", "tree"]) }).strict().parse(await c.req.json());
    const [binding]=await sql`select runtime from chat_operations where id=${c.req.param("id")} and user_id=${actor.userId}`;
    if(binding?.runtime==="mastra")await (await nativeOperations(async()=>actor)).cancel(c.req.param("id"),scope);
    else await cancelChatOperation(actor.userId, c.req.param("id"), scope);
    return c.json({ accepted: true });
  });

export async function durableChatLaunchHandler(c: Context, parentId?: string) {
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
  if (!await revalidateRealtimeSession(actor, AbortSignal.timeout(5000))) throw new Error("operation_forbidden");
  // A child inherits its authorized parent's project and organization. Request
  // selectors never redirect accepted work into a different task tree scope.
  if (parentId && body.project !== undefined) return c.json({ error: "project_inherited" }, 400);
  const parentProject = parentId ? await authorizeChatOperation(actor, parentId) : undefined;
  const id = parentProject?.id ?? await resolveActorProjectId(actor, body.project);
  const project = parentProject ?? await loadActorScopedProject(id, actor);
  if (!project?.orgId || await projectChatDisabledBody(id, actor.userId)) return c.json({ error: "forbidden" }, 403);
  const native=await nativeOperations(async()=>actor);
  const task = await launchChatOperation({ userId: actor.userId, projectId: id, orgId: project.orgId, key: c.req.header("Idempotency-Key") ?? "", input: { ...body, authSessionId: actor.sessionId }, parentId, runtime:"mastra" });
  const accepted=await native.launch(task.id);
  return c.json({operationId:accepted.operationId,rootId:accepted.rootId,status:accepted.status},202);
}
