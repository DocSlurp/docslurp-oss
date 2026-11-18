import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Credential lookups are bounded whatever the database or the cancel path do:
 * a connection of the dedicated lookup pool within the acquisition bound, one
 * statement (the pool's startup statement_timeout bounds it in Postgres), and a
 * hard timer that rejects on its own.
 */
const { fake } = vi.hoisted(() => ({
  fake: { statements: [] as string[], cancel: (): unknown => undefined, max: 2, stalled: [] as Array<() => void> },
}));
/** A statement that runs until the test ends it (as Postgres would at statement_timeout). */
function stalledStatement(text: string) {
  fake.statements.push(text);
  return Object.assign(new Promise<unknown[]>((resolve) => { fake.stalled.push(() => resolve([])); }), { cancel: () => fake.cancel() });
}
const lookupSql = Object.assign((strings: TemplateStringsArray) => stalledStatement(strings.join("?")), { unsafe: stalledStatement });
vi.mock("../lib/auth-lookup-pool.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/auth-lookup-pool.js")>(),
  authLookupSql: () => lookupSql,
  authLookupPoolMax: () => fake.max,
}));
vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { json: (v: unknown) => v, array: (v: unknown) => v }) }));

const { validateApiKey } = await import("../services/api-keys.js");
const { LOOKUP_ACQUIRE_TIMEOUT_MS, LookupTimeoutError, boundedLookup, lookupSlotsInUse, withDeadline } = await import("../lib/bounded-lookup.js");
const { authLookupPoolOptions, resolveAuthLookupPoolMax, DEFAULT_AUTH_LOOKUP_POOL_MAX } = await import("../lib/auth-lookup-pool.js");

afterEach(async () => {
  for (const end of fake.stalled.splice(0)) end();
  await new Promise((resolve) => setImmediate(resolve));
  vi.useRealTimers();
  fake.statements = [];
  fake.cancel = () => undefined;
  fake.max = 2;
  expect(lookupSlotsInUse()).toBe(0);
});

describe("bounded API-key lookup", () => {
  it("is one statement, and rejects at its deadline when cancel rejects (no unhandled rejection) or never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (const cancel of [() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")), () => new Promise(() => {})]) {
      fake.statements = [];
      fake.cancel = cancel;
      const settled = validateApiKey("dslp_priv_x", undefined, { recordUsage: false, timeoutMs: 3_000 }).then(() => "resolved", (error) => error);
      await vi.advanceTimersByTimeAsync(3_500);
      const outcome = await settled;
      expect(outcome).toBeInstanceOf(LookupTimeoutError);
      expect(outcome).toMatchObject({ code: "57014", phase: "execute" });
      // One round trip: the select alone, with no BEGIN, SET or COMMIT around it.
      expect(fake.statements).toHaveLength(1);
      expect(fake.statements[0]).toMatch(/from api_keys/);
    }
  });

  it("bounds acquisition when every lookup connection is busy, and frees a slot only when its statement ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fake.max = 1;
    // The only connection runs a stalled statement: its caller gets up after 3.5 s, but the slot stays
    // held until the statement ends (as Postgres ends it at statement_timeout).
    const first = boundedLookup((lookup) => lookup.unsafe("select 1", [])).then((rows) => rows, (error) => error);
    const second = boundedLookup(() => Promise.resolve(["second"])).then((rows) => rows, (error) => error);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await first).toMatchObject({ code: "57014", phase: "execute" });
    expect(lookupSlotsInUse()).toBe(1);
    // The waiting lookup is bounded by acquisition.
    await vi.advanceTimersByTimeAsync(LOOKUP_ACQUIRE_TIMEOUT_MS - 3_500);
    expect(await second).toMatchObject({ code: "57014", phase: "acquire" });
    // The statement ends: its slot comes back, and the next lookup runs at once.
    for (const end of fake.stalled.splice(0)) end();
    await vi.advanceTimersByTimeAsync(0);
    expect(lookupSlotsInUse()).toBe(0);
    expect(await boundedLookup(() => Promise.resolve(["third"]))).toEqual(["third"]);
  });

  it("withDeadline never lets a failing or hanging cancel hook escape", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (const onTimeout of [() => Promise.reject(new Error("cancel failed")), () => new Promise(() => {}), () => { throw new Error("sync"); }]) {
      const settled = withDeadline(new Promise(() => {}), 100, "execute", { onTimeout }).then(() => "resolved", (error) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await settled).toBeInstanceOf(LookupTimeoutError);
    }
  });
});

describe("the dedicated lookup pool", () => {
  it("sets the statement bound and read-only as startup parameters, and is small", () => {
    const options = authLookupPoolOptions(DEFAULT_AUTH_LOOKUP_POOL_MAX);
    expect(options).toMatchObject({ max: 4, prepare: false, connection: { statement_timeout: 3_000, default_transaction_read_only: true, application_name: "docslurp-auth-lookup" } });
    expect(resolveAuthLookupPoolMax({})).toBe(4);
    expect(resolveAuthLookupPoolMax({ AUTH_LOOKUP_POOL_MAX: "8" })).toBe(8);
    expect(resolveAuthLookupPoolMax({ AUTH_LOOKUP_POOL_MAX: "0" })).toBe(1);
    expect(resolveAuthLookupPoolMax({ AUTH_LOOKUP_POOL_MAX: "x" })).toBe(4);
  });
});
