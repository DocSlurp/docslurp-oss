import { withChatRunOwner } from "./chat-run-dependencies.js";
import { env } from "../config.js";
import { sql } from "../db.js";
import { withDeferredContext } from "../search/deferred/deferred-context.js";
import { loadActorScopedWorkspace, type SessionRequestActor } from "../lib/request-actor.js";
import { chatWorkspace, workspaceChatDisabledBody } from "./workspace-chat.js";
import { appendChatOperation, claimChatOperation, cleanupChatOperations, heartbeatChatOperation, type Operation } from "./chat-operations.js";

/** No request signal is accepted here. The durable claim owns cancellation. */
export async function executeChatOperation(task: Operation) {
  const abort = new AbortController();
  const attempt = task.attempt_id!;
  let pending: Promise<void> = Promise.resolve();
  const append = (kind: string, payload: unknown) => {
    pending = pending.then(async () => { await appendChatOperation(task.id, attempt, kind, payload); });
    // Stop the provider if persistence fails; never advertise unpersisted output.
    void pending.catch(error => abort.abort(error));
    return pending;
  };
  const check = async () => {
    // Session revocation/expiry is an explicit executor policy, checked at most every 2s.
    const [session] = await sql`select s.id from "session" s join "user" u on u.id=s."userId"
      where s.id=${String(task.input.authSessionId)} and s."userId"=${task.user_id} and s."expiresAt" > now() and u.deleted_at is null
        and (not u."twoFactorEnabled" or s."mfaVerified")
        and (s."mfaVerified" or not exists (
          select 1 from org_memberships m join organizations o on o.id=m.org_id
          where m.user_id=${task.user_id} and o.require_mfa and o.deleted_at is null
            and greatest(coalesce(o.require_mfa_since,now()),m.created_at)+make_interval(days=>o.mfa_grace_period_days) <= now()
        ))`;

    const actor: SessionRequestActor = { type: "session", userId: task.user_id, sessionId: String(task.input.authSessionId), user: { id: task.user_id, email: "", name: "" } };
    const workspace = session && await loadActorScopedWorkspace(task.workspace_id, actor);
    if (!workspace || workspace.orgId !== task.org_id || !await heartbeatChatOperation(task.id, attempt)) throw new Error("operation_cancelled_or_access_revoked");
    return actor;
  };
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void check().catch(error => abort.abort(error)).finally(() => { checking = false; });
  }, 2000);
  try {
    const actor = await check();
    const disabled = await workspaceChatDisabledBody(task.workspace_id, task.user_id);
    if (disabled) throw new Error("chat_disabled");
    const result = await withChatRunOwner({...task,signal:abort.signal}, () => withDeferredContext({ signal: abort.signal }, () => chatWorkspace({ workspaceId: task.workspace_id, userId: task.user_id, query: String(task.input.q),
      sessionId: task.input.sessionId as string | undefined, model: task.input.model as string | undefined,
      actor, allowAgentTools: env.publicChatAgentEnabled, allowConfiguration: false, signal: abort.signal,
      onTextDelta: text => append("text", { text }),
      onToolActivity: event => { void append("tool", event); }, onEvidence: event => { void append("evidence", event); },
    })));
    await pending;
    if (abort.signal.aborted) throw abort.signal.reason;
    await appendChatOperation(task.id, attempt, "result", result, "completed");
  } catch (error) {
    await pending.catch(() => undefined);
    // Persist an honest terminal outcome; a lease stolen by reconciliation fails closed.
    const cancelled = abort.signal.aborted && abort.signal.reason instanceof Error && abort.signal.reason.message === "operation_cancelled_or_access_revoked";
    await appendChatOperation(task.id, attempt, "error", { code: cancelled ? "cancelled_or_access_revoked" : "execution_failed" }, cancelled ? "cancelled" : "failed");
  } finally { clearInterval(timer); }
}

/** Dedicated queue owner, not an HTTP callback. Never retries a claimed provider attempt. */
export async function runChatOperationExecutor(signal: AbortSignal) {
  while (!signal.aborted) {
    const task = await claimChatOperation();
    if (task) await executeChatOperation(task).catch(() => undefined);
    else {
      await cleanupChatOperations();
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, 1000); signal.addEventListener("abort", done, { once: true }); });
    }
  }
}
