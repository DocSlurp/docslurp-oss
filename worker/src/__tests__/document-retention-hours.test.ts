import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { pageImageWebpEffort } from "../pipeline/page-image-format.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

/** One workspace per retention case, each with one run and one document (doc-<workspace>). */
const workspaces = [
  { id: "w-default", artifact: "null", run: "30" },
  { id: "w-kept", artifact: "null", run: "null" },
  // Artifact retention purges run-recorded URIs, not raster-cache keys: page images stay.
  { id: "w-artifact-only", artifact: "1", run: "null" },
  { id: "w-long", artifact: "2", run: "400" },
];

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    ${workspaces.map((w) => `
    insert into workspaces(id, org_id, user_id, name, artifact_retention_days, run_retention_days)
      values ('${w.id}', 'o1', 'u1', '${w.id}', ${w.artifact}, ${w.run});
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('run-${w.id}', 'o1', 'u1', '${w.id}', 'upload', 'processing', 'embed', '{}', 1);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('doc-${w.id}', 'o1', 'u1', '${w.id}', 'run-${w.id}', 'a.pdf', 'application/pdf', 'k-${w.id}', 'processing', 1);`).join("\n")}
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1 });
}, 60_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

describe("Document.artifactRetentionHours", () => {
  it.each([
    ["w-default", 720, 1],
    ["w-kept", null, 6],
    ["w-artifact-only", null, 6],
    ["w-long", 9_600, 6],
  ] as const)("%s loads %s hours and encodes at effort %s", async (workspaceId, hours, effort) => {
    const loaded = await store.loadDocument(`doc-${workspaceId}`);
    const [forRun] = await store.loadDocumentsForRun(`run-${workspaceId}`);
    expect(loaded.artifactRetentionHours).toBe(hours);
    expect(forRun!.artifactRetentionHours).toBe(hours);
    expect(pageImageWebpEffort({ retentionHours: loaded.artifactRetentionHours }, {})).toBe(effort);
  });
});
