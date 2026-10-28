import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-backed cases run only when a migrated database is provided, e.g.
// CHAT_FEEDBACK_TEST_DATABASE_URL=postgres://docslurp:docslurp@127.0.0.1:55432/docslurp_test
// They seed (and remove) their own user, organization and workspace unless
// CHAT_FEEDBACK_TEST_USER_ID and CHAT_FEEDBACK_TEST_WORKSPACE_ID name existing rows.
const testDatabaseUrl = process.env.CHAT_FEEDBACK_TEST_DATABASE_URL?.trim();
if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
}

const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const PROVIDED_USER_ID = process.env.CHAT_FEEDBACK_TEST_USER_ID?.trim();
const PROVIDED_WORKSPACE_ID = process.env.CHAT_FEEDBACK_TEST_WORKSPACE_ID?.trim();
const SEED_OWN_ROWS = !PROVIDED_USER_ID || !PROVIDED_WORKSPACE_ID;
const SEED_USER_ID = SEED_OWN_ROWS ? `chat-feedback-user-${runSuffix}` : PROVIDED_USER_ID!;
const SEED_WORKSPACE_ID = SEED_OWN_ROWS ? `chat-feedback-ws-${runSuffix}` : PROVIDED_WORKSPACE_ID!;
const SEED_ORG_ID = `chat-feedback-org-${runSuffix}`;

const getWorkspaceMock = vi.fn();

vi.mock("../services/workspaces.js", () => ({
  archiveWorkspace: vi.fn(),
  cloneWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  getWorkspace: getWorkspaceMock,
  getWorkspaceCockpit: vi.fn(),
  getWorkspaceTraceFeed: vi.fn(),
  listWorkspaceBoardRecords: vi.fn(async () => []),
  listWorkspaceVersions: vi.fn(),
  listWorkspaces: vi.fn(async () => []),
  restoreWorkspace: vi.fn(),
  rollbackWorkspaceVersion: vi.fn(),
  updateWorkspace: vi.fn(),
}));

vi.mock("../services/audit-log.js", () => ({ appendAuditLog: vi.fn() }));

const { workspacesRoutes } = await import("../routes/workspaces.js");
const { sql } = await import("../db.js");

function buildApp() {
  const app = new Hono();
  app.use("/workspaces/*", async (c, next) => {
    c.set("sessionUser", { id: SEED_USER_ID, email: `${SEED_USER_ID}@example.test`, name: "Admin" });
    await next();
  });
  app.route("/workspaces", workspacesRoutes);
  return app;
}

function putFeedback(app: Hono, workspaceId: string, body: unknown) {
  return app.request(`/workspaces/${workspaceId}/chat/feedback`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteFeedback(app: Hono, workspaceId: string, messageId: string) {
  return app.request(`/workspaces/${workspaceId}/chat/feedback/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
  });
}

describe("chat feedback routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    getWorkspaceMock.mockReset();
    getWorkspaceMock.mockImplementation(async (workspaceId: string) =>
      workspaceId === SEED_WORKSPACE_ID ? { id: workspaceId } : null,
    );
  });

  it("returns 400 for invalid bodies", async () => {
    const invalidBodies = [
      { rating: "up" },
      { messageId: "", rating: "up" },
      { messageId: "m1", rating: "meh" },
      { messageId: "m1" },
      { messageId: "x".repeat(201), rating: "up" },
      { messageId: "m1", rating: "down", comment: "x".repeat(2001) },
      { messageId: "m1", rating: "down", answer: "x".repeat(8001) },
    ];
    for (const body of invalidBodies) {
      const response = await putFeedback(app, SEED_WORKSPACE_ID, body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(getWorkspaceMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace is not accessible", async () => {
    const put = await putFeedback(app, "someone-elses-workspace", { messageId: "m1", rating: "up" });
    expect(put.status).toBe(404);
    expect(await put.json()).toEqual({ error: { code: "workspace_not_found", message: "Workspace not found" } });

    const del = await deleteFeedback(app, "someone-elses-workspace", "m1");
    expect(del.status).toBe(404);
  });

  describe.skipIf(!testDatabaseUrl)("persistence (real database)", () => {
    const messageId = `test-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    beforeAll(async () => {
      if (!SEED_OWN_ROWS) return;
      await sql`INSERT INTO "user" (id, name, email) VALUES (${SEED_USER_ID}, 'Chat Feedback', ${`${SEED_USER_ID}@example.test`})`;
      await sql`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES (${SEED_ORG_ID}, 'Chat Feedback Org', ${SEED_ORG_ID}, ${SEED_USER_ID})`;
      await sql`INSERT INTO workspaces (id, org_id, user_id, name) VALUES (${SEED_WORKSPACE_ID}, ${SEED_ORG_ID}, ${SEED_USER_ID}, 'Chat Feedback')`;
    });

    afterAll(async () => {
      try {
        await sql`DELETE FROM chat_message_feedback WHERE message_id = ${messageId}`;
        if (SEED_OWN_ROWS) {
          await sql`DELETE FROM workspaces WHERE id = ${SEED_WORKSPACE_ID}`;
          await sql`DELETE FROM organizations WHERE id = ${SEED_ORG_ID}`;
          await sql`DELETE FROM "user" WHERE id = ${SEED_USER_ID}`;
        }
      } finally {
        await sql.end({ timeout: 5 });
      }
    });

    it("upserts ratings, preserves omitted comments, and deletes idempotently", async () => {
      const first = await putFeedback(app, SEED_WORKSPACE_ID, {
        messageId,
        threadId: "thread-1",
        rating: "up",
        question: "What is the termination clause?",
        answer: "Thirty days notice.",
        model: "test-model",
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(firstBody.feedback).toMatchObject({ messageId, rating: "up", comment: null });
      expect(typeof firstBody.feedback.id).toBe("string");
      expect(typeof firstBody.feedback.updatedAt).toBe("string");

      const commented = await putFeedback(app, SEED_WORKSPACE_ID, {
        messageId,
        rating: "down",
        comment: "  Missed the renewal clause.  ",
      });
      expect(commented.status).toBe(200);
      const commentedBody = await commented.json();
      expect(commentedBody.feedback).toMatchObject({
        id: firstBody.feedback.id,
        rating: "down",
        comment: "Missed the renewal clause.",
      });

      // Comment key absent -> existing comment kept; rating still changes.
      const flipped = await putFeedback(app, SEED_WORKSPACE_ID, { messageId, rating: "up" });
      expect((await flipped.json()).feedback).toMatchObject({
        id: firstBody.feedback.id,
        rating: "up",
        comment: "Missed the renewal clause.",
      });

      // Optional context fields were not wiped by the rating-only resends.
      const [row] = await sql<{ question: string | null; model: string | null; thread_id: string | null }[]>`
        SELECT question, model, thread_id FROM chat_message_feedback WHERE message_id = ${messageId}
      `;
      expect(row).toEqual({
        question: "What is the termination clause?",
        model: "test-model",
        thread_id: "thread-1",
      });

      // Empty comment clears it.
      const cleared = await putFeedback(app, SEED_WORKSPACE_ID, { messageId, rating: "up", comment: "   " });
      expect((await cleared.json()).feedback.comment).toBeNull();

      const del1 = await deleteFeedback(app, SEED_WORKSPACE_ID, messageId);
      expect(del1.status).toBe(200);
      expect(await del1.json()).toEqual({ ok: true });
      const del2 = await deleteFeedback(app, SEED_WORKSPACE_ID, messageId);
      expect(del2.status).toBe(200);
      expect(await del2.json()).toEqual({ ok: true });

      const remaining = await sql`SELECT 1 FROM chat_message_feedback WHERE message_id = ${messageId}`;
      expect(remaining).toHaveLength(0);
    });
  });
});
