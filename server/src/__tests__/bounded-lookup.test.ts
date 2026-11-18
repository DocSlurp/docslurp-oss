import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Credential lookups are bounded whatever the database or the cancel path do:
 * a reserved connection within the acquisition bound, the statement within its
 * own bound, and a hard timer that rejects on its own.
 */
const { fake } = vi.hoisted(() => ({
  fake: { reserve: (): Promise<unknown> => Promise.resolve(null), cancel: (): unknown => undefined, selectSettles: false },
}));
vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { reserve: () => fake.reserve(), json: (v: unknown) => v, array: (v: unknown) => v }) }));

const { validateApiKey } = await import("../services/api-keys.js");
const { LOOKUP_ACQUIRE_TIMEOUT_MS, LookupTimeoutError, withDeadline } = await import("../lib/bounded-lookup.js");

/** A reserved connection whose api_keys select never settles; other statements succeed. */
function stalledConnection() {
  const release = vi.fn();
  const statements: string[] = [];
  const connection = Object.assign((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    statements.push(text);
    if (text.includes("from api_keys")) return Object.assign(new Promise(() => {}), { cancel: () => fake.cancel() });
    return Promise.resolve([]);
  }, { release });
  return { connection, release, statements };
}

afterEach(() => vi.useRealTimers());

describe("bounded API-key lookup", () => {
  it("rejects at its deadline when cancel rejects (no unhandled rejection) and when cancel never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (const cancel of [() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")), () => new Promise(() => {})]) {
      const { connection, statements } = stalledConnection();
      fake.reserve = () => Promise.resolve(connection);
      fake.cancel = cancel;
      const lookup = validateApiKey("dslp_priv_x", undefined, { recordUsage: false, timeoutMs: 3_000 });
      const settled = lookup.then(() => "resolved", (error) => error);
      await vi.advanceTimersByTimeAsync(3_500);
      const outcome = await settled;
      expect(outcome).toBeInstanceOf(LookupTimeoutError);
      expect(outcome).toMatchObject({ code: "57014", phase: "execute" });
      // The statement ran under a database-side statement_timeout in a read-only transaction.
      expect(statements.slice(0, 2).join(" | ")).toMatch(/begin read only.*statement_timeout/s);
    }
  });

  it("bounds connection acquisition separately, and releases a connection that arrives late", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { connection, release } = stalledConnection();
    let deliver!: (value: unknown) => void;
    fake.reserve = () => new Promise((resolve) => { deliver = resolve; });
    const settled = validateApiKey("dslp_priv_x", undefined, { recordUsage: false, timeoutMs: 3_000 }).then(() => "resolved", (error) => error);
    await vi.advanceTimersByTimeAsync(LOOKUP_ACQUIRE_TIMEOUT_MS);
    expect(await settled).toMatchObject({ code: "57014", phase: "acquire" });
    deliver(connection);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledTimes(1);
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
