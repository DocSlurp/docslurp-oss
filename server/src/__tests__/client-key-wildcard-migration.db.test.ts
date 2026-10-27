import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";
import { originMatchesAllowlist } from "../lib/allowed-origins.js";

/**
 * Migration 0088: browser-key entries stored by the old normalizer ("example.com",
 * which matched every subdomain, and which is also what "*.example.com" became)
 * keep that meaning under exact matching by gaining "*.example.com".
 */
const migration = readFileSync(new URL("../../db/migrations/0088_client_key_wildcard_domains.sql", import.meta.url), "utf8");
let stop: () => Promise<void>;
let sql: postgres.Sql;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o1', 'O', 'o1', 'u1')`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

async function key(id: string, keyType: string, domains: string[]) {
  await sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, allowed_domains, scopes)
    values (${id}, 'u1', 'o1', ${id}, ${id}, ${keyType}, ${sql.array(domains)}, ${sql.array(["search"])})`;
}
const domains = async (id: string) => (await sql<{ allowed_domains: string[] }[]>`select allowed_domains from api_keys where id = ${id}`)[0]!.allowed_domains;

it("adds *.<entry> beside each legacy bare entry, keeps the rest, and is idempotent", async () => {
  await key("legacy", "client", ["example.com", "docs.example.org", "*.already.example", "localhost:4321", "https://app.example.net", "10.0.0.1", "localhost"]);
  await key("server", "server", []);
  await key("covered", "client", ["shop.example", "*.shop.example"]);
  await sql.unsafe(migration);
  expect(await domains("legacy")).toEqual([
    "example.com", "*.example.com", "docs.example.org", "*.docs.example.org", "*.already.example",
    "localhost:4321", "https://app.example.net", "10.0.0.1", "localhost",
  ]);
  expect(await domains("server")).toEqual([]);
  expect(await domains("covered")).toEqual(["shop.example", "*.shop.example"]);
  await sql.unsafe(migration);
  expect(await domains("legacy")).toHaveLength(9);
});

it("keeps a legacy example.com entry matching its subdomains after the migration, and nothing else", async () => {
  await key("legacy-match", "client", ["example.com"]);
  await sql.unsafe(migration);
  const migrated = await domains("legacy-match");
  expect(originMatchesAllowlist("https://app.example.com", migrated)).toBe(true);
  expect(originMatchesAllowlist("https://example.com", migrated)).toBe(true);
  expect(originMatchesAllowlist("https://evil-example.com", migrated)).toBe(false);
  expect(originMatchesAllowlist("https://example.com.evil.test", migrated)).toBe(false);
  // Without the migration the bare entry no longer admits subdomains.
  expect(originMatchesAllowlist("https://app.example.com", ["example.com"])).toBe(false);
});
