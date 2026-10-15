import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "../test/migrated-db.js";

/** billing_runtime is how workers learn that the app enforces metering (Stripe configured). */
describe("billing_runtime", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDatabase();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("starts with one unenforced row and stays a singleton", async () => {
    const { rows } = await db.query<{ metering_enforced: boolean }>("select metering_enforced from billing_runtime");
    expect(rows).toEqual([{ metering_enforced: false }]);
    await expect(db.query("insert into billing_runtime (id) values (false)")).rejects.toThrow();
  });

  it("accepts the app's upsert and rejects unknown Stripe modes", async () => {
    await db.query(`
      insert into billing_runtime (id, metering_enforced, stripe_mode, updated_at)
      values (true, true, 'test', now())
      on conflict (id) do update set metering_enforced = excluded.metering_enforced, stripe_mode = excluded.stripe_mode
    `);
    const { rows } = await db.query<{ metering_enforced: boolean; stripe_mode: string }>("select metering_enforced, stripe_mode from billing_runtime where id = true");
    expect(rows).toEqual([{ metering_enforced: true, stripe_mode: "test" }]);
    await expect(db.query("update billing_runtime set stripe_mode = 'prod'")).rejects.toThrow();
  });
});
