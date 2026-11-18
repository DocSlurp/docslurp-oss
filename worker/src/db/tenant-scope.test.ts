import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DocumentNotFoundError, DocumentOutOfScopeError } from "./missing-document.js";
import { Store } from "./store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/** Document loads and project graph scopes name their tenant: a wrong organization or run finds nothing. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com'), ('u2', 'B', 'b@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'One', 'one', 'u1'), ('o2', 'Two', 'two', 'u2');
    insert into projects(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'Board packs'), ('w2', 'o2', 'u2', 'Other');
    insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents) values
      (100, 'r1', 'o1', 'u1', 'w1', 'upload', 'processing', 'extract', '{}', 1),
      (100, 'r1b', 'o1', 'u1', 'w1', 'upload', 'processing', 'extract', '{}', 0),
      (100, 'r2', 'o2', 'u2', 'w2', 'upload', 'processing', 'extract', '{}', 0);
    insert into documents(id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('d1', 'o1', 'u1', 'w1', 'r1', 'a.pdf', 'application/pdf', 'k', 'queued', 2);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, {
    poolMax: 1,
    workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 },
  });
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

describe("PostgresRunLedger.loadDocument", () => {
  it("loads a document within its run or its organization", async () => {
    expect((await store.loadDocument("d1", { runId: "r1" })).id).toBe("d1");
    expect((await store.loadDocument("d1", { orgId: "o1" })).id).toBe("d1");
  }, 60_000);

  it("refuses another organization, another run, or no organization with a scope error, never a deletion", async () => {
    for (const scope of [{ runId: "r1b" }, { runId: "r2" }, { orgId: "o2" }, { orgId: null }]) {
      await expect(store.loadDocument("d1", scope)).rejects.toBeInstanceOf(DocumentOutOfScopeError);
    }
  }, 60_000);

  it("reports a missing document as not found", async () => {
    await expect(store.loadDocument("gone", { orgId: "o1" })).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(store.loadDocument("gone", { runId: "r1" })).rejects.toBeInstanceOf(DocumentNotFoundError);
  }, 60_000);
});

describe("PostgresKnowledgeGraph.projectGraphScope", () => {
  it("reads the project's definition only within its organization", async () => {
    expect(await store.graph.projectGraphScope({ orgId: "o1", projectId: "w1" })).toContain("Board packs");
    // Another organization (or none) gets the generic scope, never the project's name.
    expect(await store.graph.projectGraphScope({ orgId: "o2", projectId: "w1" })).toBe("Project");
    expect(await store.graph.projectGraphScope({ orgId: null, projectId: "w1" })).toBe("Project");
  }, 60_000);
});
