import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBlockedPrivacyAuditEntry } from "@docslurp/shared";

import { Store } from "../db/store.js";
import { allowHostedCallForWorkspace, openRouterTextCall } from "../lib/privacy-guard.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql<Record<string, unknown>>;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000);
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
  await sql`insert into workspaces(id, org_id, user_id, name, pipeline) values ('w', 'o1', 'u1', 'Private', '{}'::jsonb)`;
}, 60_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

describe("privacy_audit_log writes", () => {
  it("persists blocked attempts from the run store", async () => {
    await store.recordPrivacyAudit([
      buildBlockedPrivacyAuditEntry({
        privacyMode: "strict-privacy",
        call: openRouterTextCall("document-summary", "vendor/model"),
        workspaceId: "w",
      }),
    ]);
    const rows = await sql<{ workspace_id: string; model_id: string; endpoint: string; privacy_mode: string }[]>`
      select workspace_id, model_id, endpoint, privacy_mode from privacy_audit_log where endpoint = 'blocked:worker.text.document-summary'
    `;
    expect(rows).toEqual([{ workspace_id: "w", model_id: "openrouter/vendor/model", endpoint: "blocked:worker.text.document-summary", privacy_mode: "strict-privacy" }]);
  });

  it("gates background jobs and audits only strict-privacy", async () => {
    const call = openRouterTextCall("graph-extraction", "vendor/model");
    expect(await allowHostedCallForWorkspace(sql, { privacyMode: "standard", workspaceId: "w", call })).toBe(true);
    expect(await allowHostedCallForWorkspace(sql, { privacyMode: "local-only", workspaceId: "w", call })).toBe(false);
    expect(await allowHostedCallForWorkspace(sql, { privacyMode: "strict-privacy", workspaceId: "w", call })).toBe(false);
    const rows = await sql<{ privacy_mode: string }[]>`
      select privacy_mode from privacy_audit_log where endpoint = 'blocked:worker.text.graph-extraction'
    `;
    expect(rows.map((row) => row.privacy_mode)).toEqual(["strict-privacy"]);
  });
});
