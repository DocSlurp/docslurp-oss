import { getCachedIdempotentResponse, hashIdempotencyPayload, scopedIdempotencyKey, storeIdempotentResponse } from "./idempotency.js";
import { withDirectUploadLock } from "./direct-upload-session.js";
import { WorkspaceIntakeError } from "./workspace-intake.js";

export const DIRECT_SESSION_ROUTE_KEY = "uploads.direct-session";

export interface DirectSessionIdempotencyDeps {
  getCached: typeof getCachedIdempotentResponse;
  store: typeof storeIdempotentResponse;
  /** Serializes same-key requests; a second concurrent one is told to retry. */
  lock: <T>(name: string, run: () => Promise<T>) => Promise<T>;
}

const defaultDeps: DirectSessionIdempotencyDeps = {
  getCached: getCachedIdempotentResponse,
  store: storeIdempotentResponse,
  lock: (name, run) => withDirectUploadLock(name, run, "A request with this Idempotency-Key is still being processed; retry shortly"),
};

type CreatedSession = { sessionId: string; rejected?: readonly unknown[] };

/**
 * Creates a direct-upload session once per Idempotency-Key. A client that timed out and sends the same request with the same key gets
 * the session the first request made (with fresh signed URLs), never a second session. The key is scoped to organization and user;
 * the same key with a different request body is a conflict.
 */
export async function createSessionIdempotently<T extends CreatedSession>(args: {
  key: string | null;
  scope: { orgId?: string | null; userId: string };
  request: unknown;
  create: () => Promise<T>;
  /** The session as a client would see it now, or null when it no longer exists. */
  describe: (sessionId: string) => Promise<Omit<T, "rejected"> | null>;
}, deps: DirectSessionIdempotencyDeps = defaultDeps): Promise<{ body: T; status: 200 | 201; replayed: boolean }> {
  if (!args.key) return { body: await args.create(), status: 201, replayed: false };
  const scoped = scopedIdempotencyKey(args.scope, args.key);
  const requestHash = hashIdempotencyPayload({ scope: args.scope, request: args.request });
  return await deps.lock(`idem:${scoped}`, async () => {
    let cached;
    try {
      cached = await deps.getCached({ idempotencyKey: scoped, routeKey: DIRECT_SESSION_ROUTE_KEY, requestHash });
    } catch (error) {
      throw new WorkspaceIntakeError(error instanceof Error ? error.message : "Idempotency conflict", 409);
    }
    const cachedId = typeof cached?.body.sessionId === "string" ? cached.body.sessionId : null;
    if (cachedId) {
      const described = await args.describe(cachedId);
      if (described) {
        const rejected = Array.isArray(cached!.body.rejected) ? (cached!.body.rejected as unknown[]) : undefined;
        return { body: { ...described, ...(rejected?.length ? { rejected } : {}) } as T, status: 200 as const, replayed: true };
      }
    }
    const created = await args.create();
    await deps.store({
      idempotencyKey: scoped,
      routeKey: DIRECT_SESSION_ROUTE_KEY,
      requestHash,
      userId: args.scope.userId,
      status: 201,
      body: { sessionId: created.sessionId, ...(created.rejected?.length ? { rejected: created.rejected } : {}) },
    });
    return { body: created, status: 201 as const, replayed: false };
  });
}
