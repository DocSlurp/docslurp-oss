import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const query = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => []);
  return { query, begin: vi.fn(), end: vi.fn(async () => {}), connect: vi.fn() };
});
vi.mock("postgres", () => ({ default: database.connect }));
vi.mock("better-auth/crypto", () => ({ hashPassword: vi.fn(async (password: string) => `hash:${password}`) }));

import { seedNonProductionUsers } from "./seed-users.js";

describe("automatic seed users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.query.mockResolvedValue([]);
    database.begin.mockImplementation(async (callback) => callback(database.query));
    database.connect.mockReturnValue({ begin: database.begin, end: database.end });
    vi.stubEnv("SEED_ADMIN_EMAIL", "admin@docslurp.local");
    vi.stubEnv("SEED_MEMBER_EMAIL", "member@docslurp.local");
    vi.stubEnv("SEED_ADMIN_PASSWORD", "testtest");
    vi.stubEnv("SEED_MEMBER_PASSWORD", "testtest");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("never connects or seeds in production, even when fixtures are requested", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await seedNonProductionUsers({ includeFixtures: true });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each(["production", "test", "preview", "staging", ""])("never automatically seeds in %s", async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    await seedNonProductionUsers();
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("never automatically seeds with an unset environment", async () => {
    vi.stubEnv("NODE_ENV", undefined);
    await seedNonProductionUsers();
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("sets up development accounts without queued-run fixtures", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await seedNonProductionUsers();
    const statements = database.query.mock.calls.map(([strings]) => strings.join("?"));
    expect(statements.filter(statement => statement.includes('insert into "user"'))).toHaveLength(2);
    expect(statements.filter(statement => statement.includes('insert into "account"'))).toHaveLength(2);
    expect(statements.filter(statement => statement.includes('"emailVerified" = true'))).toHaveLength(2);
    expect(statements.some(statement => statement.includes("insert into workspace_members"))).toBe(true);
    expect(statements.some(statement => statement.includes("insert into workspace_runs"))).toBe(false);
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(database.end).toHaveBeenCalledOnce();
  });

  it("uses configured credentials", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SEED_ADMIN_EMAIL", "owner@example.test");
    vi.stubEnv("SEED_ADMIN_PASSWORD", "configured-password");
    await seedNonProductionUsers();
    const values = database.query.mock.calls.flatMap(([, ...parameters]) => parameters);
    expect(values).toContain("owner@example.test");
    expect(values).toContain("hash:configured-password");
  });

  it("closes the connection and propagates setup failures", async () => {
    vi.stubEnv("NODE_ENV", "development");
    database.query.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(seedNonProductionUsers()).rejects.toThrow("database unavailable");
    expect(database.end).toHaveBeenCalledOnce();
  });

  it("allows explicit non-production fixture seeding", async () => {
    vi.stubEnv("NODE_ENV", "test");
    await seedNonProductionUsers({ includeFixtures: true });
    const statements = database.query.mock.calls.map(([strings]) => strings.join("?"));
    expect(statements.some(statement => statement.includes('insert into "user"'))).toBe(true);
    expect(statements.some(statement => statement.includes("insert into workspace_runs"))).toBe(true);
  });
});
