import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

import { InvalidListCursorError, encodeListCursor } from "../lib/list-cursor.js";
import { LIFT_ONE_ORG_PER_USER_POLICY } from "./helpers/multi-org.js";

/**
 * Documents and run history page by keyset cursor: every row appears exactly
 * once across pages, rows added mid-listing never shift a page, and a cursor
 * carries no authority (scope is re-applied on every page).
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let documents: typeof import("../services/documents.js");
let runs: typeof import("../services/runs.js");

beforeAll(async () => {
  const database = await startMigratedPostgres();
  await database.db.exec(LIFT_ONE_ORG_PER_USER_POLICY);
  stop = database.stop;
  sql = postgres(database.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  await sql`insert into "user" (id, name, email) values ('alice', 'A', 'alice@example.test'), ('bob', 'B', 'bob@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('org-a', 'A', 'org-a', 'alice'), ('org-b', 'B', 'org-b', 'bob'), ('org-c', 'C', 'org-c', 'alice')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('org-a', 'alice', 'owner'), ('org-b', 'bob', 'owner'), ('org-c', 'alice', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('wa', 'org-a', 'alice', 'A'), ('wb', 'org-b', 'bob', 'B'), ('wc', 'org-c', 'alice', 'C')`;
  // 23 documents in wa, several sharing a created_at (ties must not drop or repeat rows); one in each other project.
  for (let index = 0; index < 23; index += 1) {
    const at = `2026-01-01 00:00:${String(Math.floor(index / 3)).padStart(2, "0")}.123456+00`;
    await sql`insert into documents (id, org_id, user_id, project_id, filename, mime_type, source_key, status, created_at)
      values (${`a-${String(index).padStart(2, "0")}`}, 'org-a', 'alice', 'wa', ${`a${index}.pdf`}, 'application/pdf', ${`ka-${index}`}, 'completed', ${at}::timestamptz)`;
  }
  await sql`insert into documents (id, org_id, user_id, project_id, filename, mime_type, source_key, status) values
    ('b-0', 'org-b', 'bob', 'wb', 'b.pdf', 'application/pdf', 'kb', 'completed'),
    ('c-0', 'org-c', 'alice', 'wc', 'c.pdf', 'application/pdf', 'kc', 'completed')`;
  for (let index = 0; index < 12; index += 1) {
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, job_id, priority, created_at)
      values (${`run-a-${String(index).padStart(2, "0")}`}, 'org-a', 'alice', 'wa', 'upload', 'completed', 'completed', 'j', ${index % 2},
        ${`2026-01-01 00:00:${String(Math.floor(index / 2)).padStart(2, "0")}+00`}::timestamptz)`;
  }
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, job_id) values
    ('run-b-0', 'org-b', 'bob', 'wb', 'upload', 'completed', 'completed', 'j'),
    ('run-c-0', 'org-c', 'alice', 'wc', 'upload', 'completed', 'completed', 'j')`;
  documents = await import("../services/documents.js");
  runs = await import("../services/runs.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

async function allDocumentIds(args: Parameters<typeof documents.listDocumentsWithFilters>[0], limit: number) {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await documents.listDocumentsWithFilters({ ...args, limit, cursor });
    seen.push(...page.documents.map((doc) => doc.id));
    expect(page.hasMore).toBe(page.nextCursor !== null);
    if (!page.nextCursor) return seen;
    cursor = page.nextCursor;
  }
  throw new Error("cursor never ended");
}

describe("documents", () => {
  it("returns every document exactly once across pages, newest first, even when timestamps tie", async () => {
    const ids = await allDocumentIds({ userId: "alice", projectId: "wa" }, 5);
    expect(ids).toHaveLength(23);
    expect(new Set(ids).size).toBe(23);
    const unpaged = (await documents.listDocumentsWithFilters({ userId: "alice", projectId: "wa", limit: 250 })).documents.map((doc) => doc.id);
    expect(ids).toEqual(unpaged);
  });

  it("is not shifted by documents added while paging", async () => {
    const first = await documents.listDocumentsWithFilters({ userId: "alice", projectId: "wa", limit: 5 });
    await sql`insert into documents (id, org_id, user_id, project_id, filename, mime_type, source_key, status, created_at)
      values ('a-late', 'org-a', 'alice', 'wa', 'late.pdf', 'application/pdf', 'kl', 'completed', now())`;
    try {
      const second = await documents.listDocumentsWithFilters({ userId: "alice", projectId: "wa", limit: 5, cursor: first.nextCursor! });
      expect(second.documents.map((doc) => doc.id)).not.toContain("a-late");
      expect(second.documents.map((doc) => doc.id).filter((id) => first.documents.some((doc) => doc.id === id))).toEqual([]);
    } finally {
      await sql`delete from documents where id = 'a-late'`;
    }
  });

  it("never pages into another tenant, however the cursor is forged", async () => {
    expect(await allDocumentIds({ userId: "alice" }, 7)).not.toContain("b-0");
    expect(await allDocumentIds({ userId: "bob" }, 7)).toEqual(["b-0"]);
    // A cursor from a far-future position still only walks the caller's own rows.
    const forged = encodeListCursor("documents", { createdAt: "2999-01-01 00:00:00+00", id: "zzz" });
    const page = await documents.listDocumentsWithFilters({ userId: "bob", limit: 250, cursor: forged });
    expect(page.documents.map((doc) => doc.id)).toEqual(["b-0"]);
    // Org-scoped (API key) listings stay inside the key's organization.
    expect(await allDocumentIds({ userId: "alice", orgId: "org-c" }, 3)).toEqual(["c-0"]);
  });

  it("refuses a cursor that is not a documents cursor", async () => {
    await expect(documents.listDocumentsWithFilters({ userId: "alice", cursor: encodeListCursor("runs", { priority: 0, createdAt: "x", id: "y" }) })).rejects.toBeInstanceOf(InvalidListCursorError);
    await expect(documents.listDocumentsWithFilters({ userId: "alice", cursor: "garbage" })).rejects.toBeInstanceOf(InvalidListCursorError);
    await expect(documents.listDocumentsWithFilters({ userId: "alice", cursor: encodeListCursor("documents", { createdAt: "not a time", id: "y" }) })).rejects.toBeInstanceOf(InvalidListCursorError);
    // Values that parse as strings and numbers but would fail the query's cast are a 400 too, not a 500.
    for (const createdAt of ["2026-13-45 00:00:00+00", "2026-02-30T00:00:00Z", "2026-11-04'; drop table documents; --", "2026-11-04T25:00:00Z"]) {
      await expect(documents.listDocumentsWithFilters({ userId: "alice", cursor: encodeListCursor("documents", { createdAt, id: "y" }) })).rejects.toBeInstanceOf(InvalidListCursorError);
    }
    for (const priority of [1.5, 1e20, -1e10]) {
      await expect(runs.listRunsPage("alice", { cursor: encodeListCursor("runs", { priority, createdAt: "2026-11-04 00:00:00+00", id: "y" }) })).rejects.toBeInstanceOf(InvalidListCursorError);
    }
  });
});

describe("run history", () => {
  async function allRunIds(userId: string, orgId: string | null, limit: number) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 50; pages += 1) {
      const page = await runs.listRunsPage(userId, { orgId, limit, cursor });
      seen.push(...page.runs.map((run) => run.id));
      if (!page.nextCursor) return seen;
      cursor = page.nextCursor;
    }
    throw new Error("cursor never ended");
  }

  it("pages by priority, then newest, without gaps or repeats", async () => {
    const ids = await allRunIds("alice", "org-a", 4);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(ids).toEqual((await runs.listRunsPage("alice", { orgId: "org-a", limit: 100 })).runs.map((run) => run.id));
    // Priority 1 runs come before every priority 0 run.
    const priorities = (await runs.listRunsPage("alice", { orgId: "org-a", limit: 100 })).runs.map((run) => (run as unknown as { priority?: number }).priority ?? 0);
    expect(priorities).toEqual([...priorities].sort((x, y) => y - x));
  });

  it("applies the organization before the page, not after it", async () => {
    // alice reaches org-a and org-c; a key for org-c must see its one run even though org-a has newer, more runs.
    expect(await allRunIds("alice", "org-c", 1)).toEqual(["run-c-0"]);
    expect((await allRunIds("alice", null, 5)).sort()).toEqual([...(await allRunIds("alice", "org-a", 100)), "run-c-0"].sort());
  });

  it("never pages into another tenant", async () => {
    expect(await allRunIds("bob", null, 5)).toEqual(["run-b-0"]);
    expect(await allRunIds("alice", null, 5)).not.toContain("run-b-0");
    const forged = encodeListCursor("runs", { priority: 999, createdAt: "2999-01-01 00:00:00+00", id: "zzz" });
    expect((await runs.listRunsPage("bob", { limit: 100, cursor: forged })).runs.map((run) => run.id)).toEqual(["run-b-0"]);
    await expect(runs.listRunsPage("alice", { cursor: encodeListCursor("documents", { createdAt: "x", id: "y" }) })).rejects.toBeInstanceOf(InvalidListCursorError);
  });
});
