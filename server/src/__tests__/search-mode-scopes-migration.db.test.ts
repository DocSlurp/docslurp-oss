import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { LIFT_ONE_ORG_PER_USER_POLICY } from "./helpers/multi-org.js";

// Migration 0138 already ran on this database; its statements are idempotent, so rerun them over legacy rows.
const statements = readFileSync(new URL("../../db/migrations/0138_search_mode_scopes.sql", import.meta.url), "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

let sql: postgres.Sql;
let stop: () => Promise<void>;

beforeAll(async () => {
  const database = await startMigratedPostgres();
  await database.db.exec(LIFT_ONE_ORG_PER_USER_POLICY);
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'search-modes@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'search-modes', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  const key = (id: string, scopes: string[]) => sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes, rate_limit_ppd)
    values (${id}, 'u', 'o', ${`hash-${id}`}, ${id}, 'server', ${sql.array(scopes)}, 10000)`;
  await key("legacy", ["ingest", "search", "chat", "artifacts"]);
  await key("legacy-and-deep", ["search", "search:deep"]);
  await key("keyword-and-deep", ["search:keyword", "search:deep", "chat"]);
  await key("hybrid-and-keyword", ["search:hybrid", "search:keyword"]);
  await key("no-search", ["ingest"]);
  await sql`insert into mcp_oauth_clients (id, name, redirect_uris) values ('client', 'Client', '[]')`;
  await sql`insert into mcp_oauth_grants (id, client_id, user_id, org_id, resource, scopes, api_key_id)
    values ('grant', 'client', 'u', 'o', 'https://example.test/v1/mcp', '["search", "chat"]', 'legacy')`;
  for (const statement of statements) await sql.unsafe(statement);
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

describe("migration 0138: search mode scopes", () => {
  const scopes = async (id: string) => [...(await sql<{ scopes: string[] }[]>`select scopes from api_keys where id = ${id}`)[0]!.scopes].sort();

  it("gives keys holding the retired search scope search:deep, so none loses access", async () => {
    expect(await scopes("legacy")).toEqual(["artifacts", "chat", "ingest", "search:deep"]);
    expect(await scopes("legacy-and-deep")).toEqual(["search:deep"]);
    expect(await scopes("no-search")).toEqual(["ingest"]);
  });

  it("keeps only the narrowest mode on a key holding several", async () => {
    expect(await scopes("keyword-and-deep")).toEqual(["chat", "search:keyword"]);
    expect(await scopes("hybrid-and-keyword")).toEqual(["search:keyword"]);
  });

  it("renames OAuth grants and the column default", async () => {
    const [grant] = await sql<{ scopes: string[] }[]>`select scopes from mcp_oauth_grants where id = 'grant'`;
    expect([...grant!.scopes].sort()).toEqual(["chat", "search:deep"]);
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, rate_limit_ppd) values ('defaulted', 'u', 'o', 'hash-defaulted', 'd', 'server', 10000)`;
    expect(await scopes("defaulted")).toEqual(["artifacts", "ingest", "search:deep"]);
  });
});
