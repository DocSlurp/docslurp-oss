import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { admitConfiguredAdminUser, configuredAdminEmails } from "../lib/admin-emails.js";

afterEach(() => vi.unstubAllEnvs());
describe("ADMIN_EMAILS admission", () => {
  it("normalizes CSV addresses and rejects wildcard/domain entries", () => {
    expect(configuredAdminEmails(" Admin@Example.com, second@example.org ,ADMIN@example.com,,*@example.org,@example.com, invalid ")).toEqual(["admin@example.com", "second@example.org"]);
  });
  it("does no database work when the allowlist is empty", async () => {
    vi.stubEnv("ADMIN_EMAILS", "");
    const pool = { query: vi.fn() };
    expect(await admitConfiguredAdminUser(pool as unknown as Pool, "user-1")).toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });
  it("checks the authoritative verified identity and promotes existing memberships", async () => {
    vi.stubEnv("ADMIN_EMAILS", " Admin@Example.com ");
    const pool = { query: vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ is_admin: true }] })) };
    expect(await admitConfiguredAdminUser(pool as unknown as Pool, "user-1")).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('"emailVerified" = true'), ["user-1", ["admin@example.com"]]);
    const statement = pool.query.mock.calls[0]?.[0];
    expect(statement).toContain("role not in ('owner', 'admin')");
    expect(statement).toContain("update workspace_members set role = 'admin'");
  });
  it("does not grant status when no verified allowlisted identity matches", async () => {
    vi.stubEnv("ADMIN_EMAILS", "admin@example.com");
    const pool = { query: vi.fn(async () => ({ rows: [{ is_admin: false }] })) };
    expect(await admitConfiguredAdminUser(pool as unknown as Pool, "user-2")).toBe(false);
  });
});
