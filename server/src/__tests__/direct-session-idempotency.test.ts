import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../db.js")>(), sql: vi.fn() }));

import { assertSessionReplayable, assertSessionWorkspaceStillContributable, createSessionIdempotently, type DirectSessionIdempotencyDeps } from "../services/direct-session-idempotency.js";
import { hashIdempotencyPayload, IdempotencyConflictError, parseIdempotencyKey, scopedIdempotencyKey } from "../services/idempotency.js";

/** An in-memory idempotency cache and an uncontended lock, with the cache keyed exactly as the real one (key + route). */
function memoryDeps() {
  const cache = new Map<string, { requestHash: string; status: number; body: Record<string, unknown> }>();
  const held = new Set<string>();
  const deps: DirectSessionIdempotencyDeps = {
    getCached: async ({ idempotencyKey, routeKey, requestHash }) => {
      const row = cache.get(`${idempotencyKey}|${routeKey}`);
      if (!row) return null;
      if (row.requestHash !== requestHash) throw new IdempotencyConflictError();
      return { status: row.status, body: row.body };
    },
    store: async ({ idempotencyKey, routeKey, requestHash, status, body }) => { cache.set(`${idempotencyKey}|${routeKey}`, { requestHash, status, body }); },
    lock: async (name, run) => {
      if (held.has(name)) throw Object.assign(new Error("busy"), { statusCode: 409 });
      held.add(name);
      try { return await run(); } finally { held.delete(name); }
    },
  };
  return { deps, cache, held };
}

function sessions() {
  let count = 0;
  const create = vi.fn(async () => ({ sessionId: `session-${++count}`, files: [{ id: "f", index: 0 }], rejected: undefined as undefined | Array<{ index: number }> }));
  const describe = vi.fn(async (sessionId: string) => ({ sessionId, files: [{ id: "f", index: 0 }] }));
  return { create, describe };
}

describe("createSessionIdempotently", () => {
  const request = { files: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1 }] };

  it("creates one session for a retried create with the same key, and replays it with fresh descriptors", async () => {
    const { deps } = memoryDeps();
    const { create, describe } = sessions();
    const args = { key: "retry-1", scope: { orgId: "org-1", userId: "user-1" }, request, create, describe };
    const first = await createSessionIdempotently(args, deps);
    const second = await createSessionIdempotently(args, deps);
    expect(create).toHaveBeenCalledTimes(1);
    expect([first.status, first.replayed]).toEqual([201, false]);
    expect([second.status, second.replayed]).toEqual([200, true]);
    expect(second.body.sessionId).toBe(first.body.sessionId);
    expect(describe).toHaveBeenCalledWith("session-1");
  });

  it("replays the per-file rejections of the first request", async () => {
    const { deps } = memoryDeps();
    const create = vi.fn(async () => ({ sessionId: "s1", rejected: [{ index: 1, filename: "x.exe" }] }));
    const describe = vi.fn(async (sessionId: string) => ({ sessionId }));
    const args = { key: "k", scope: { orgId: "org-1", userId: "u" }, request, create, describe };
    await createSessionIdempotently(args, deps);
    const replay = await createSessionIdempotently(args, deps);
    expect(replay.body).toMatchObject({ sessionId: "s1", rejected: [{ index: 1, filename: "x.exe" }] });
  });

  it("never shares a key between organizations: the same key in another org creates its own session", async () => {
    const { deps } = memoryDeps();
    const { create, describe } = sessions();
    const a = await createSessionIdempotently({ key: "same", scope: { orgId: "org-a", userId: "user-a" }, request, create, describe }, deps);
    const b = await createSessionIdempotently({ key: "same", scope: { orgId: "org-b", userId: "user-b" }, request, create, describe }, deps);
    expect(create).toHaveBeenCalledTimes(2);
    expect(b.replayed).toBe(false);
    expect(b.body.sessionId).not.toBe(a.body.sessionId);
    expect(describe).not.toHaveBeenCalled();
  });

  it("refuses the same key with a different request", async () => {
    const { deps } = memoryDeps();
    const { create, describe } = sessions();
    const scope = { orgId: "org-1", userId: "user-1" };
    await createSessionIdempotently({ key: "k", scope, request, create, describe }, deps);
    const error = await createSessionIdempotently({ key: "k", scope, request: { files: [] }, create, describe }, deps).catch((caught) => caught);
    expect(error.statusCode).toBe(409);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("creates a fresh session when the remembered one is gone", async () => {
    const { deps } = memoryDeps();
    const { create } = sessions();
    const describe = vi.fn(async () => null);
    const scope = { orgId: "org-1", userId: "user-1" };
    await createSessionIdempotently({ key: "k", scope, request, create, describe }, deps);
    const again = await createSessionIdempotently({ key: "k", scope, request, create, describe }, deps);
    expect(create).toHaveBeenCalledTimes(2);
    expect(again.replayed).toBe(false);
  });

  it("serializes concurrent creates of one key: the second is told to retry, not given a second session", async () => {
    const { deps, held } = memoryDeps();
    const { create, describe } = sessions();
    const scope = { orgId: "org-1", userId: "user-1" };
    held.add(`idem:${scopedIdempotencyKey(scope, "k")}`);
    await expect(createSessionIdempotently({ key: "k", scope, request, create, describe }, deps)).rejects.toMatchObject({ statusCode: 409 });
    expect(create).not.toHaveBeenCalled();
  });

  it("without a key creates every time", async () => {
    const { deps } = memoryDeps();
    const { create, describe } = sessions();
    await createSessionIdempotently({ key: null, scope: { userId: "u" }, request, create, describe }, deps);
    await createSessionIdempotently({ key: null, scope: { userId: "u" }, request, create, describe }, deps);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe("idempotency keys", () => {
  it("scopes the stored key to organization and user", () => {
    const a = scopedIdempotencyKey({ orgId: "org-a", userId: "u" }, "k");
    expect(a).not.toBe(scopedIdempotencyKey({ orgId: "org-b", userId: "u" }, "k"));
    expect(a).not.toBe(scopedIdempotencyKey({ orgId: "org-a", userId: "v" }, "k"));
    expect(a).toBe(scopedIdempotencyKey({ orgId: "org-a", userId: "u" }, "k"));
    expect(a).not.toContain("org-a");
  });

  it("validates the header", () => {
    expect(parseIdempotencyKey("  abc-123  ")).toEqual({ key: "abc-123" });
    expect(parseIdempotencyKey(undefined)).toEqual({ key: null });
    expect(parseIdempotencyKey("has space")).toHaveProperty("error");
    expect(parseIdempotencyKey("x".repeat(256))).toHaveProperty("error");
    expect(hashIdempotencyPayload({ a: 1, b: 2 })).toBe(hashIdempotencyPayload({ b: 2, a: 1 }));
  });
});


describe("upload-session idempotency across credentials", () => {
  const request = { files: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1 }] };
  const base = { orgId: "org-1", userId: "user-1" };

  it("never replays one API key's session to another key of the same user (different workspace allowlists)", async () => {
    const { deps } = memoryDeps();
    const { create, describe } = sessions();
    const keyA = await createSessionIdempotently({ key: "retry", scope: { ...base, apiKeyId: "key-a", workspace: "ws-1" }, request, create, describe }, deps);
    const keyB = await createSessionIdempotently({ key: "retry", scope: { ...base, apiKeyId: "key-b", workspace: "ws-2" }, request, create, describe }, deps);
    expect(create).toHaveBeenCalledTimes(2);
    expect(keyB.replayed).toBe(false);
    expect(keyB.body.sessionId).not.toBe(keyA.body.sessionId);
    expect(describe).not.toHaveBeenCalled();
  });

  it("separates the same key and body aimed at two workspaces, and the same key from a browser session and an API key", async () => {
    const { deps } = memoryDeps();
    const { create, describe } = sessions();
    await createSessionIdempotently({ key: "k", scope: { ...base, apiKeyId: "key-a", workspace: "ws-1" }, request, create, describe }, deps);
    await createSessionIdempotently({ key: "k", scope: { ...base, apiKeyId: "key-a", workspace: "ws-2" }, request, create, describe }, deps);
    await createSessionIdempotently({ key: "k", scope: { ...base, apiKeyId: null, workspace: "ws-1" }, request, create, describe }, deps);
    expect(create).toHaveBeenCalledTimes(3);
    expect(describe).not.toHaveBeenCalled();
  });

  it("still replays for the same key and workspace", async () => {
    const { deps } = memoryDeps();
    const { create, describe } = sessions();
    const args = { key: "k", scope: { ...base, apiKeyId: "key-a", workspace: "ws-1" }, request, create, describe };
    await createSessionIdempotently(args, deps);
    expect((await createSessionIdempotently(args, deps)).replayed).toBe(true);
  });

  it("lets the replay's authorization refuse: a describe that throws leaves the session unreturned and creates nothing", async () => {
    const { deps } = memoryDeps();
    const { create } = sessions();
    const scope = { ...base, apiKeyId: "key-a", workspace: "ws-1" };
    await createSessionIdempotently({ key: "k", scope, request, create, describe: async (id) => ({ sessionId: id, files: [] }) }, deps);
    const denied = Object.assign(new Error("not yours"), { statusCode: 409 });
    await expect(createSessionIdempotently({ key: "k", scope, request, create, describe: async () => { throw denied; } }, deps)).rejects.toBe(denied);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not turn a database error into a 409 carrying its text", async () => {
    const { deps } = memoryDeps();
    deps.getCached = async () => { throw new Error('connection to "db-prod-3.internal:5432" refused'); };
    const { create, describe } = sessions();
    const error = await createSessionIdempotently({ key: "k", scope: base, request, create, describe }, deps).catch((caught) => caught);
    expect(error.statusCode).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it("reports a reused key as a coded conflict", async () => {
    const { deps } = memoryDeps();
    const { create, describe } = sessions();
    await createSessionIdempotently({ key: "k", scope: base, request, create, describe }, deps);
    await expect(createSessionIdempotently({ key: "k", scope: base, request: { files: [] }, create, describe }, deps)).rejects.toMatchObject({ statusCode: 409, code: "idempotency_key_reused" });
  });
});

describe("assertSessionReplayable", () => {
  const session = { org_id: "org-1", api_key_id: "key-a", workspace_id: "ws-1", status: "uploading" };
  const caller = { orgId: "org-1", apiKeyId: "key-a", allowedWorkspaceIds: ["ws-1"] };

  it("hands back an open session to the key that made it", () => {
    expect(() => assertSessionReplayable(session, caller)).not.toThrow();
    expect(() => assertSessionReplayable({ ...session, status: "pending" }, { ...caller, allowedWorkspaceIds: null })).not.toThrow();
  });

  it.each([
    ["another key", { ...caller, apiKeyId: "key-b" }],
    ["a browser session for a key's session", { ...caller, apiKeyId: null }],
    ["another organization", { ...caller, orgId: "org-2" }],
    ["a key whose allowlist excludes the workspace", { ...caller, allowedWorkspaceIds: ["ws-2"] }],
  ])("refuses %s with a 409 and never returns the session", (_label, other) => {
    expect(() => assertSessionReplayable(session, other)).toThrowError(expect.objectContaining({ statusCode: 409, code: "idempotency_key_reused" }));
  });

  it("refuses a session that is unassigned to a workspace for an allowlisted key", () => {
    expect(() => assertSessionReplayable({ ...session, workspace_id: null }, caller)).toThrowError(expect.objectContaining({ statusCode: 409 }));
  });

  it.each(["failed", "aborted"])("says a %s session cannot be resumed instead of returning it without upload URLs", (status) => {
    expect(() => assertSessionReplayable({ ...session, status }, caller)).toThrowError(expect.objectContaining({ statusCode: 409, code: "upload_session_closed" }));
  });
});

describe("assertSessionWorkspaceStillContributable", () => {
  it("refuses the replay with 403 once the user may no longer upload into the session's workspace", async () => {
    const mayContribute = vi.fn(async () => false);
    await expect(assertSessionWorkspaceStillContributable({ workspace_id: "w" }, "u", mayContribute)).rejects.toMatchObject({ statusCode: 403 });
    expect(mayContribute).toHaveBeenCalledWith("w", "u");
    await expect(assertSessionWorkspaceStillContributable({ workspace_id: "w" }, "u", async () => true)).resolves.toBeUndefined();
  });

  it("a replay whose describe refuses returns no session and creates none", async () => {
    const { deps } = memoryDeps();
    const create = vi.fn(async () => ({ sessionId: "s1" }));
    let revoked = false;
    const describe = vi.fn(async (sessionId: string) => {
      await assertSessionWorkspaceStillContributable({ workspace_id: "w" }, "u", async () => !revoked);
      return { sessionId, files: [{ uploadUrl: "https://signed" }] };
    });
    const args = { key: "k", scope: { orgId: "o", userId: "u" }, request: {}, create, describe };
    await createSessionIdempotently(args, deps);
    revoked = true;
    await expect(createSessionIdempotently(args, deps)).rejects.toMatchObject({ statusCode: 403 });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
