import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/** embedding_reuse_refs on a migrated database: org-scoped pointers to embedding artifacts. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'One', 'one', 'u1'), ('o2', 'Two', 'two', 'u1');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000, {
    poolMax: 1,
    workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 },
  });
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

describe("embedding reuse refs", () => {
  it("upserts to the newest artifact, isolates organizations and forgets stale pointers", async () => {
    await store.recordEmbeddingReuseRefs("o1", [
      { key: "k1", artifactUri: "s3://b/old.json", chunkIndex: 0 },
      { key: "k2", artifactUri: "s3://b/old.json", chunkIndex: 1 },
      // A repeated key in one batch keeps the last ref instead of failing the upsert.
      { key: "k2", artifactUri: "s3://b/old.json", chunkIndex: 3 },
      { key: "ctx:doc", artifactUri: "s3://b/old.json", chunkIndex: -1 },
    ]);
    await store.recordEmbeddingReuseRefs("o1", [{ key: "k1", artifactUri: "s3://b/new.json", chunkIndex: 5 }]);

    const refs = await store.findEmbeddingReuseRefs("o1", ["k1", "k2", "ctx:doc", "missing"]);
    expect(refs.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "ctx:doc", artifactUri: "s3://b/old.json", chunkIndex: -1 },
      { key: "k1", artifactUri: "s3://b/new.json", chunkIndex: 5 },
      { key: "k2", artifactUri: "s3://b/old.json", chunkIndex: 3 },
    ]);
    expect(await store.findEmbeddingReuseRefs("o2", ["k1", "k2"])).toEqual([]);

    // Only the pointer to the stale artifact is removed.
    await store.forgetEmbeddingReuseRefs("o1", "s3://b/old.json", ["k1", "k2"]);
    expect((await store.findEmbeddingReuseRefs("o1", ["k1", "k2"])).map((ref) => ref.key)).toEqual(["k1"]);

    // Deleting an organization deletes its refs.
    await db.exec(`delete from organizations where id = 'o1'`);
    expect(await store.findEmbeddingReuseRefs("o1", ["k1", "ctx:doc"])).toEqual([]);
  }, 60_000);
});
