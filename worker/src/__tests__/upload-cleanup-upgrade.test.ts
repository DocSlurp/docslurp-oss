import { expect, it } from "vitest";
import { applyRemainingMigrations, createMigratedDatabase } from "../test/migrated-db.js";

it("upgrades an already-migrated quarantine database to accept original-upload cleanup", async () => {
  const db = await createMigratedDatabase({ stopBefore: "upload_original_cleanup" });
  const insert = "insert into storage_cleanup_queue (kind, org_id, target, reason) values ('upload_original', 'org', 'user/upload/raw/file', 'sealed_upload')";
  try {
    await expect(db.exec(insert)).rejects.toThrow(/storage_cleanup_queue_kind_check/);
    await applyRemainingMigrations(db, "upload_original_cleanup");
    await db.exec(insert);
    expect((await db.query("select kind from storage_cleanup_queue")).rows).toEqual([{kind: "upload_original"}]);
  } finally {
    await db.close();
  }
}, 60000);
