import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "../test/migrated-db.js";

/**
 * org_spend_status() (migration 0044) is the spend rule the API's
 * assertCanSpend and the worker's mid-run check share.
 */
describe("org_spend_status", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    await db.exec(`
      insert into "user" (id, name, email) values ('u1', 'U', 'u1@example.com');
      insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents, included_credits_remaining)
        values ('org-1', 'One', 'one', 'u1', 3, 0), ('org-2', 'Two', 'two', 'u1', 10, 0);
      insert into workspaces (id, org_id, user_id, name) values ('ws-1', 'org-1', 'u1', 'W'), ('ws-2', 'org-2', 'u1', 'X');
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, input_cost_cents) values
        ('fresh', 'org-1', 'u1', 'ws-1', 'bulk-upload', 'processing', 'embed', '{}', 0),
        ('half-spent', 'org-1', 'u1', 'ws-1', 'bulk-upload', 'queued', 'queued', '{}', 0.25),
        ('spent', 'org-1', 'u1', 'ws-1', 'bulk-upload', 'processing', 'embed', '{}', 5),
        ('done', 'org-1', 'u1', 'ws-1', 'bulk-upload', 'completed', 'completed', '{}', 0);
      select enqueue_org_credit_debit('org-1', 1, 'u1', 'usage', null, null, '{}'::jsonb);
    `);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  async function status(org: string | null, workspace: string | null, reserve = 0) {
    const { rows } = await db.query<Record<string, unknown>>(
      "select * from org_spend_status($1, $2, $3)",
      [org, workspace, reserve],
    );
    return rows[0];
  }

  it("reports available credits net of pending debits, resolving the org from the workspace", async () => {
    expect(await status(null, "ws-1")).toMatchObject({
      org_id: "org-1", plan_id: "free", reserved: "0",
      workspace_budget_paused: false, org_budget_paused: false, workspace_in_org: true,
    });
    expect(Number((await status(null, "ws-1"))!.available)).toBe(2);
  });

  it("sums the unspent part of each in-flight run's reservation", async () => {
    // fresh 0.5, half-spent 0.25, spent 0, completed not counted.
    expect(Number((await status("org-1", "ws-1", 0.5))!.reserved)).toBeCloseTo(0.75);
  });

  it("flags a workspace outside the org and budget pauses", async () => {
    expect((await status("org-1", "ws-2"))!.workspace_in_org).toBe(false);
    await db.exec("update workspaces set budget_paused = true where id = 'ws-1'");
    await db.exec("update organizations set budget_paused = true where id = 'org-1'");
    expect(await status("org-1", "ws-1")).toMatchObject({ workspace_budget_paused: true, org_budget_paused: true });
    expect(await status("missing", null)).toBeUndefined();
  });
});
