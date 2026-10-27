import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Per-key-type controls against a migrated database (migration 0093): browser
 * keys hold only search/chat and default to a 1,000-token chat output cap;
 * server keys can expire, be limited to IP ranges, rotate with an overlap and
 * set their own output cap.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let keys: typeof import("../services/api-keys.js");
let orgId: string;
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  keys = await import("../services/api-keys.js");
  // A server key creates the personal organization; the docs workspace lives in it.
  const seed = await keys.createApiKey("u1", "seed");
  orgId = seed.key.orgId!;
  await sql`insert into workspaces (id, org_id, user_id, name) values (${WORKSPACE}, ${orgId}, 'u1', 'Docs')`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

const browser = (extra: Record<string, unknown> = {}) =>
  keys.createApiKey("u1", "widget", { keyType: "client", allowedDomains: ["docs.example.com"], workspaceIds: [WORKSPACE], scopes: ["search", "chat"], ...extra });

describe("browser keys", () => {
  it("can't be created with a server scope, and default to a 1,000-token output cap", async () => {
    for (const scopes of [["ingest"], ["search", "artifacts"], ["workspaces:manage"]]) {
      await expect(browser({ scopes })).rejects.toMatchObject({ status: 400, code: "invalid_key_scope" });
    }
    const { rawKey, key } = await browser();
    expect(key.maxOutputTokens).toBeNull();
    expect((await keys.validateApiKey(rawKey, { origin: "https://docs.example.com" }))?.maxOutputTokens).toBe(1000);
    // Only the browser choices; 4000 and "no cap" are server-key settings.
    await expect(browser({ maxOutputTokens: 4000 })).rejects.toMatchObject({ code: "invalid_max_output_tokens" });
    const small = await browser({ maxOutputTokens: 500 });
    expect((await keys.validateApiKey(small.rawKey, { origin: "https://docs.example.com" }))?.maxOutputTokens).toBe(500);
  });

  it("can't have an IP allowlist (visitors' addresses vary)", async () => {
    await expect(browser({ ipAllowlist: ["203.0.113.0/24"] })).rejects.toMatchObject({ code: "invalid_ip_allowlist" });
  });

  it.each(["ingest", "artifacts", "web", "empty"])("never grants search to a narrowed legacy key (%j), even on save or rotation", async (stored) => {
    const scopes = stored === "empty" ? [] : [stored];
    const { rawKey, key } = await browser();
    await sql`update api_keys set scopes = ${sql.array(scopes)} where id = ${key.id}`;
    const context = { origin: "https://docs.example.com" };
    expect((await keys.validateApiKey(rawKey, context))?.scopes).toEqual([]);
    expect((await keys.getLiveApiKeyById(key.id))?.scopes).toEqual([]);
    expect((await keys.updateApiKey(key.id, "u1", { name: "Same permissions" }))?.scopes).toEqual([]);
    expect((await keys.validateApiKey(rawKey, context))?.scopes).toEqual([]);
    const rotated = await keys.rotateApiKey(key.id, "u1");
    expect(rotated?.key.scopes).toEqual([]);
    expect((await keys.validateApiKey(rotated!.rawKey, context))?.scopes).toEqual([]);
    const overlap = await keys.rotateApiKey(key.id, "u1", { overlapSeconds: 3600 });
    expect(overlap?.key.scopes).toEqual([]);
    expect(overlap?.previous?.scopes).toEqual([]);
    expect((await keys.validateApiKey(overlap!.rawKey, context))?.scopes).toEqual([]);
  });

  it("drops legacy server scopes from a stored browser key at request time", async () => {
    const { rawKey, key } = await browser();
    await sql`update api_keys set scopes = ${sql.array(["search", "ingest", "artifacts"])} where id = ${key.id}`;
    expect((await keys.validateApiKey(rawKey, { origin: "https://docs.example.com" }))?.scopes).toEqual(["search"]);
  });
});

describe("server keys", () => {
  it("stop authenticating once expired", async () => {
    const { rawKey, key } = await keys.createApiKey("u1", "expiring", { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(await keys.validateApiKey(rawKey)).not.toBeNull();
    await sql`update api_keys set expires_at = now() - interval '1 second' where id = ${key.id}`;
    expect(await keys.validateApiKey(rawKey)).toBeNull();
    expect(await keys.getLiveApiKeyById(key.id)).toBeNull();
    await expect(keys.createApiKey("u1", "past", { expiresAt: new Date(Date.now() - 1_000).toISOString() })).rejects.toMatchObject({ code: "invalid_key_expiry" });
    await expect(keys.createApiKey("u1", "far", { expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })).rejects.toMatchObject({ code: "invalid_key_expiry" });
  });

  it("work only from their IP allowlist, and never from an unknown address", async () => {
    const { rawKey } = await keys.createApiKey("u1", "office", { ipAllowlist: ["203.0.113.0/24", "2001:db8::/32"] });
    expect(await keys.validateApiKey(rawKey, { ip: "203.0.113.7" })).not.toBeNull();
    expect(await keys.validateApiKey(rawKey, { ip: "2001:db8:1::5" })).not.toBeNull();
    await expect(keys.validateApiKey(rawKey, { ip: "198.51.100.1" })).rejects.toMatchObject({ status: 403, code: "api_key_ip_not_allowed" });
    await expect(keys.validateApiKey(rawKey, {})).rejects.toMatchObject({ code: "api_key_ip_not_allowed" });
    await expect(keys.createApiKey("u1", "bad", { ipAllowlist: ["not-an-ip"] })).rejects.toMatchObject({ code: "invalid_ip_allowlist" });
    await expect(keys.createApiKey("u1", "open", { ipAllowlist: ["0.0.0.0/0"] })).rejects.toMatchObject({ code: "invalid_ip_allowlist" });
  });

  it("rotate with an overlap: both secrets work until the old one expires, then only the new one", async () => {
    const original = await keys.createApiKey("u1", "deploy", { scopes: ["search", "chat"], maxOutputTokens: 4000, ipAllowlist: [] });
    const rotated = await keys.rotateApiKey(original.key.id, "u1", { overlapSeconds: 3600 });
    expect(rotated?.key.id).not.toBe(original.key.id);
    expect(rotated?.key).toMatchObject({ rotatedFromKeyId: original.key.id, scopes: ["search", "chat"], maxOutputTokens: 4000 });
    expect(rotated?.previous?.expiresAt).toEqual(expect.any(String));
    expect(await keys.validateApiKey(original.rawKey)).toMatchObject({ keyId: original.key.id });
    expect(await keys.validateApiKey(rotated!.rawKey)).toMatchObject({ keyId: rotated!.key.id, maxOutputTokens: 4000 });
    // The overlap ends.
    await sql`update api_keys set expires_at = now() - interval '1 second' where id = ${original.key.id}`;
    expect(await keys.validateApiKey(original.rawKey)).toBeNull();
    expect(await keys.validateApiKey(rotated!.rawKey)).not.toBeNull();
    await expect(keys.rotateApiKey(rotated!.key.id, "u1", { overlapSeconds: 8 * 86_400 })).rejects.toMatchObject({ code: "invalid_rotation_overlap" });
  });

  it("rotate without an overlap replaces the secret at once", async () => {
    const original = await keys.createApiKey("u1", "instant");
    const rotated = await keys.rotateApiKey(original.key.id, "u1");
    expect(rotated?.key.id).toBe(original.key.id);
    expect(await keys.validateApiKey(original.rawKey)).toBeNull();
    expect(await keys.validateApiKey(rotated!.rawKey)).not.toBeNull();
  });

  it("set an output cap from the server choices, or none", async () => {
    const none = await keys.createApiKey("u1", "uncapped");
    expect((await keys.validateApiKey(none.rawKey))?.maxOutputTokens).toBeNull();
    await expect(keys.createApiKey("u1", "odd", { maxOutputTokens: 1500 })).rejects.toMatchObject({ code: "invalid_max_output_tokens" });
    const updated = await keys.updateApiKey(none.key.id, "u1", { maxOutputTokens: 2000, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(updated).toMatchObject({ maxOutputTokens: 2000, expiresAt: expect.any(String) });
    expect((await keys.updateApiKey(none.key.id, "u1", { maxOutputTokens: null, expiresAt: null }))).toMatchObject({ maxOutputTokens: null, expiresAt: null });
  });
});
