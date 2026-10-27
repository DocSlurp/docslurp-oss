import { afterAll, beforeAll, expect, it } from "vitest";
import { createMigratedDatabase } from "@docslurp/worker/testing";
import type { Pool } from "pg";
import { createSsoSessionRevocation, findSsoOrgForEmail } from "../lib/sso-enforcement.js";

let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
let pool: Pick<Pool, "query">;
beforeAll(async () => {
  db = await createMigratedDatabase();
  pool = { query: (sql: string, params: unknown[]) => db.query(sql, params) } as unknown as Pick<Pool, "query">;
}, 120_000);
afterAll(async () => { await db?.close(); });

it("revokes only exact verified, enabled, enforced domains and honors issuing organization", async () => {
  for (const [name, enabled, enforced, verified] of [
    ["enforced", true, true, true], ["optional", true, false, true],
    ["disabled", false, true, true], ["unverified", true, true, false],
  ] as const) {
    const email = `member@${name}.test`;
    await db.query('insert into "user" (id,name,email) values ($1,$1,$2)', [name, email]);
    await db.query('insert into organizations (id,name,slug,created_by_user_id,sso_config) values ($1,$1,$1,$1,$2)', [name, JSON.stringify({ enabled, enforceSso: enforced, emailDomain: `${name}.test` })]);
    await db.query('insert into sso_domains (org_id,domain,verification_token,verified_at) values ($1,$2,$3,$4)', [name, `${name}.test`, "test", verified ? new Date() : null]);
    expect(Boolean(await findSsoOrgForEmail(pool, email, true))).toBe(enabled && enforced && verified);
    await db.query('insert into session (id,"userId",token,"expiresAt") values ($1,$1,$1,now()+interval \'1 day\')', [name]);
    await createSsoSessionRevocation(pool)(name);
    const result = await db.query('select token from session where id=$1', [name]);
    expect(result.rows.length, name).toBe(name === "enforced" ? 0 : 1);
  }
  for (const org of ["enforced", "other-org"]) {
    const token = `sso_${Buffer.from(org).toString("hex")}_randomtoken`;
    await db.query('insert into session (id,"userId",token,"expiresAt") values ($1,\'enforced\',$1,now()+interval \'1 day\')', [token]);
    await createSsoSessionRevocation(pool)(token);
    expect((await db.query('select token from session where token=$1', [token])).rows.length).toBe(org === "enforced" ? 1 : 0);
  }
});
