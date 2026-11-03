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
    operationsForSession: (headers, session) => {
      if (options.operations || process.env.DOCSLURP_DURABLE_CHAT !== "1") return options.operations;
      return createChatOperationProvider(async userId => {
        const actor = await authenticateRealtimeActor(headers);
        if (!actor || actor.userId !== userId || actor.userId !== session.userId || actor.sessionId !== session.sessionId) return null;
        return actor;
      });
    },
  });
}

/** Explicit database liveness defeats stale Better Auth cookie caches. */
async function authenticateRealtimeActor(headers: Headers) {
  if (headers.has("authorization") || headers.has("x-api-key")) return null;
  const actor = await resolveBetterAuthSessionActor(headers);
  if (!actor) return null;
  const [session] = await sql`select id from session where id = ${actor.sessionId}
    and "userId" = ${actor.userId} and "expiresAt" > now()`;
  return session ? actor : null;
}

export async function authenticateRealtimeSession(headers: Headers) {
  const actor = await authenticateRealtimeActor(headers);
  return actor ? { userId: actor.userId, sessionId: actor.sessionId } : null;
}
