import type { Server } from "node:http";
import { attachRealtimeServer } from "./node.js";
import { realtimeBackend } from "./backend.js";
import { resolveBetterAuthSessionActor } from "../lib/request-actor.js";
import { sql } from "../db.js";
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
    allowedOrigins: env.corsAllowedOrigins,
    backend: realtimeBackend,
    operations: options.operations,
    async authenticate(headers) {
      if (headers.has("authorization") || headers.has("x-api-key")) return null;
      const actor = await resolveBetterAuthSessionActor(headers);
      if (!actor) return null;
      // Better Auth may cache cookies. Never use that cache as revocation proof.
      const [session] = await sql`select id from session where id = ${actor.sessionId}
        and "userId" = ${actor.userId} and "expiresAt" > now()`;
      return session ? { userId: actor.userId, sessionId: actor.sessionId } : null;
    },
  });
}
