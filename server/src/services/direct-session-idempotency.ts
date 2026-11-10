import { getCachedIdempotentResponse, hashIdempotencyPayload, IdempotencyConflictError, scopedIdempotencyKey, storeIdempotentResponse, type IdempotencyScope } from "./idempotency.js";
import { withDirectUploadLock } from "./direct-upload-session.js";
import { ProjectIntakeError } from "./project-intake.js";
import { sql } from "../db.js";
import { canContributeToProject, getProjectAccess } from "./organizations.js";

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
  lock: (name, run) => withDirectUploadLock(name, run, "A request with this Idempotency-Key is still being processed; retry shortly", "idempotency_in_flight"),
};

/**
 * A remembered session may be handed back (with fresh upload URLs) only to the credential that made it: the same organization,
 * the same API key (or a browser session for a session made without one), inside that key's project allowlist, and still open.
 * Throws a 409 otherwise, so a replay never returns another credential's URLs or a session that can no longer take bytes.
 */
export function assertSessionReplayable(
  session: { org_id: string | null; api_key_id?: string | null; project_id: string | null; status: string },
  caller: { orgId: string | null; apiKeyId: string | null; allowedProjectIds?: readonly string[] | null },
): void {
  const inAllowlist = !caller.allowedProjectIds?.length || Boolean(session.project_id && caller.allowedProjectIds.includes(session.project_id));
  if ((session.org_id ?? null) !== (caller.orgId ?? null) || (session.api_key_id ?? null) !== (caller.apiKeyId ?? null) || !inAllowlist) {
    throw new ProjectIntakeError("This Idempotency-Key belongs to an upload session this credential cannot use; use a new Idempotency-Key", 409, undefined, "idempotency_key_reused");
  }
  if (["failed", "aborted"].includes(session.status)) {
    throw new ProjectIntakeError(`The upload session created with this Idempotency-Key was ${session.status}; create a new one with a new Idempotency-Key`, 409, undefined, "upload_session_closed");
  }
}

/** May `userId` upload into `projectId` now (a live share or membership with contribute rights)? */
async function mayContributeNow(projectId: string, userId: string): Promise<boolean> {
  const access = await getProjectAccess(projectId, userId);
  return access !== null && canContributeToProject(access, userId);
}

/** Is `userId` still a member of `orgId` (a session whose confirm creates its project there)? */
async function isOrgMemberNow(orgId: string, userId: string): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    select 1 as one from org_memberships om join organizations o on o.id = om.org_id and o.deleted_at is null
    where om.org_id = ${orgId} and om.user_id = ${userId} limit 1`;
  return rows.length > 0;
}

/**
 * The live access check before anything hands out upload URLs for, or ingests into, an existing session (the idempotent replay,
 * GET /direct/sessions/:id, part signing, file completion, confirm): the session's project must still accept uploads from
 * this user, or, for a session whose confirm creates its project, the user must still belong to the session's organization.
 * A share or membership revoked or demoted since the session was made gets no URLs (403). Fails closed on a session with
 * neither a project nor an organization.
 */
export async function assertSessionProjectStillContributable(
  session: { project_id: string | null; org_id?: string | null },
  userId: string,
  mayContribute: (projectId: string, userId: string) => Promise<boolean> = mayContributeNow,
  isMember: (orgId: string, userId: string) => Promise<boolean> = isOrgMemberNow,
): Promise<void> {
  const allowed = session.project_id
    ? await mayContribute(session.project_id, userId)
    : session.org_id === undefined ? true : session.org_id !== null && await isMember(session.org_id, userId);
  if (!allowed) {
    throw new ProjectIntakeError("You can no longer upload into this upload session's project", 403);
  }
}

type CreatedSession = { sessionId: string; rejected?: readonly unknown[] };

/**
 * Creates a direct-upload session once per Idempotency-Key. A client that timed out and sends the same request with the same key gets
 * the session the first request made (with fresh signed URLs), never a second session. The key is scoped to organization, user,
 * API key and target project, and the request hash covers that scope too: another key (with another project allowlist) can
 * never replay this one's session, and the same key with a different request body is a conflict. `describe` is the replay's
 * authorization point: it must apply the same organization and allowlist checks as the session routes, and throw when the
 * remembered session cannot be handed back (closed, or not this caller's).
 */
export async function createSessionIdempotently<T extends CreatedSession>(args: {
  key: string | null;
  scope: IdempotencyScope;
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
      // Only the conflict is the caller's to see; a database fault stays a server error with its detail in telemetry.
      if (error instanceof IdempotencyConflictError) throw new ProjectIntakeError(error.message, 409, undefined, "idempotency_key_reused");
      throw error;
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
