import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { applyMigration, createMigratedDatabase } from "../test/migrated-db.js";

const tag = "0164_asset_unlinked_repeat";
let db: PGlite;
beforeAll(async () => {
  db = await createMigratedDatabase({ stopBefore: tag });
  await db.exec(`
    insert into "user"(id, name, email) values ('u', 'Test', 'ledger@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('o', 'Test', 'ledger-test', 'u');
    insert into projects(id, org_id, user_id, name) values ('p', 'o', 'u', 'Test');
    insert into documents(id, org_id, project_id, user_id, filename, mime_type, source_key, status)
      values ('d', 'o', 'p', 'u', 'test.pdf', 'application/pdf', 'test', 'completed');
  `);
  // A real pre-migration row must not block installation or be silently changed.
  await insert("p1.1", "unlinked", "p1.2");
  await applyMigration(db, tag);
}, 120_000);
afterAll(async () => { await db?.close(); });

function insert(id: string, status: string, repeat: string | null, org = "o") {
  return db.query(`insert into document_assets
    (document_id, org_id, project_id, asset_id, page_number, kind, fate, status, reason, repeat_of)
    values ('d', $1, 'p', $2, 1, 'picture', 'duplicate', $3,
      case when $3 = 'not-extracted' then 'repeat' else null end, $4)`, [org, id, status, repeat]);
}

it("installs over historical violations and is idempotent", async () => {
  await applyMigration(db, tag);
  expect((await db.query(`select repeat_of from document_assets where asset_id='p1.1'`)).rows)
    .toEqual([{ repeat_of: "p1.2" }]);
  expect((await db.query(`select convalidated from pg_constraint where conname='document_assets_unlinked_repeat_check'`)).rows)
    .toEqual([{ convalidated: false }]);
});

it("rejects new unlinked aliases and updates of historical invalid rows", async () => {
  await expect(insert("p1.3", "unlinked", "p1.2")).rejects.toThrow(/document_assets_unlinked_repeat_check/);
  await expect(db.exec(`update document_assets set fate='watermark' where asset_id='p1.1'`))
    .rejects.toThrow(/document_assets_unlinked_repeat_check/);
  await db.exec(`update document_assets set repeat_of=null where asset_id='p1.1'`);
});

it("allows unlinked rows without aliases and repeat references on not-extracted rows", async () => {
  await insert("p1.4", "unlinked", null);
  await insert("p1.5", "not-extracted", "p1.4");
});

it("keeps tenant scope and bounded reference validation enforced", async () => {
  await expect(insert("p1.6", "unlinked", null, "other-org")).rejects.toThrow();
  await expect(insert("p1.7", "not-extracted", "x".repeat(1000))).rejects.toThrow();
});
