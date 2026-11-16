import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { createMigratedDatabase } from "../../test/migrated-db.js";
import { serveOnRandomPort } from "../../test/migrated-postgres.js";
import { PostgresPageReaderOrgBudget } from "../page-reader-budget.js";

let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
let server: Awaited<ReturnType<typeof serveOnRandomPort>>["server"];
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1, prepare: false });
}, 120_000);
afterAll(async () => { await sql?.end(); await server?.stop(); await db?.close(); });
beforeEach(async () => { await sql`delete from ocr_page_reader_org_spend`; });

it("admits within the org's daily cap and refuses the job that would pass it", async () => {
  const budget = new PostgresPageReaderOrgBudget(sql);
  const first = await budget.admit({ orgId: "org-a", reserveCents: 40, capCents: 100 });
  const second = await budget.admit({ orgId: "org-a", reserveCents: 40, capCents: 100 });
  expect(first.admitted && second.admitted).toBe(true);
  expect(await budget.admit({ orgId: "org-a", reserveCents: 40, capCents: 100 })).toEqual({ admitted: false, committedCents: 80 });
  // Another organization is untouched.
  expect((await budget.admit({ orgId: "org-b", reserveCents: 40, capCents: 100 })).admitted).toBe(true);
  // Settling replaces a reservation with the recorded cost, freeing the difference.
  if (first.admitted) await budget.settle(first.ticket, 5);
  expect((await budget.admit({ orgId: "org-a", reserveCents: 40, capCents: 100 })).admitted).toBe(true);
});

// PGlite serves one session at a time, so this checks the counting under interleaved callers; cross-worker exclusion is the
// organization's advisory transaction lock (the same pattern as the vision ledger).
it("concurrent admissions never pass the cap together", async () => {
  const budget = new PostgresPageReaderOrgBudget(sql);
  const results = await Promise.all(Array.from({ length: 10 }, () => budget.admit({ orgId: "org-race", reserveCents: 30, capCents: 100 })));
  expect(results.filter((result) => result.admitted)).toHaveLength(3);
});

it("keeps an unsettled reservation for the day and ignores earlier days", async () => {
  const budget = new PostgresPageReaderOrgBudget(sql);
  await sql`insert into ocr_page_reader_org_spend (id, org_id, day, reserved_cents, cost_cents, settled)
    values ('yesterday', 'org-a', (now() at time zone 'utc')::date - 1, 0, 90, true)`;
  expect((await budget.admit({ orgId: "org-a", reserveCents: 90, capCents: 100 })).admitted).toBe(true); // a crashed job's ticket
  expect((await budget.admit({ orgId: "org-a", reserveCents: 20, capCents: 100 })).admitted).toBe(false);
  // A cap of 0 sends nothing.
  expect((await budget.admit({ orgId: "org-z", reserveCents: 0, capCents: 0 })).admitted).toBe(false);
});
