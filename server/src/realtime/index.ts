import { revalidateRealtimeSession } from "./session.js";
import type { Server } from "node:http";
import { attachRealtimeServer } from "./node.js";
import { realtimeBackend } from "./backend.js";
import { resolveBetterAuthSessionActor } from "../lib/request-actor.js";
import { sql } from "../db.js";
import { createChatOperationProvider } from "../services/chat-operation-access.js";
import { env } from "../config.js";
import type { RealtimeOperationProvider } from "../services/realtime-operation.js";
export { attachRealtimeServer } from "./node.js";
export type { RealtimeHostOptions, RealtimeSession } from "./node.js";
export type { RealtimeOperationProvider, RealtimeOperationObserver, RealtimeOperationSubscription } from "../services/realtime-operation.js";
export { realtimeMetrics } from "./broker.js";
export { revisionMaintenanceMetrics } from "./revision-maintenance.js";

/** First-party standalone and mounted-host entrypoint. The caller must pass the
 * actual Node server; mounting Hono's fetch handler alone cannot handle Upgrade.
 */
export function attachFirstPartyRealtime(server: Server, options: { operations?: RealtimeOperationProvider } = {}) {
  return attachRealtimeServer(server, {
    enabled: process.env.REALTIME_ENABLED === "true",
    allowedOrigins: process.env.CORS_ALLOWED_ORIGINS ? env.corsAllowedOrigins : [new URL(env.appUrl).origin],
    backend: realtimeBackend,
    operations: options.operations,
    authenticate: authenticateRealtimeSession,
    revalidate: revalidateRealtimeSession,
    operationsForSession: (headers, session) => {
      if (options.operations || process.env.DOCSLURP_DURABLE_CHAT !== "1") return options.operations;
      return createChatOperationProvider(async userId => {
        if(userId!==session.userId||!await revalidateRealtimeSession(session,AbortSignal.timeout(5000)))return null;
        // The session identity came from authenticated Upgrade. Native operation
        // policy needs scope, not repeated cookie parsing/admin decoration.
        return {type:"session" as const,...session,user:{id:session.userId,email:"",name:""}};
      });
    },
  });
}

/** Explicit database liveness defeats stale Better Auth cookie caches. */
async function authenticateRealtimeActor(headers: Headers, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (headers.has("authorization") || headers.has("x-api-key")) return null;
  const actor = await resolveBetterAuthSessionActor(headers, { signal });
  signal?.throwIfAborted();
  if (!actor) return null;
  const query = sql`select id from session where id = ${actor.sessionId}
    and "userId" = ${actor.userId} and "expiresAt" > now()`;
  const cancel = () => { void Promise.resolve(query.cancel()).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const [session] = await query;
    signal?.throwIfAborted();
    return session ? actor : null;
  } finally { signal?.removeEventListener("abort", cancel); }
}

export async function authenticateRealtimeSession(headers: Headers, signal?: AbortSignal) {
  const actor = await authenticateRealtimeActor(headers, signal);
  return actor ? { userId: actor.userId, sessionId: actor.sessionId } : null;
}
