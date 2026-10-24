import { describe, expect, it, vi } from "vitest";

import { isConnectionLevelError, isRetryableRead, resilientSql } from "../lib/resilient-sql.js";

/** A stand-in for a postgres.js client: tagged calls return lazy thenables carrying strings and args. */
function fakeClient(id: number, behaviour: (sqlText: string, attempt: number) => unknown) {
  const calls: string[] = [];
  const end = vi.fn(async () => undefined);
  const client: any = (strings: TemplateStringsArray, ...args: unknown[]) => {
    const text = strings.join("?");
    const query: any = {
      strings,
      args,
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        calls.push(text);
        return Promise.resolve().then(() => {
          const outcome = behaviour(text, calls.length);
          if (outcome instanceof Error) throw outcome;
          return outcome;
        }).then(resolve, reject);
      },
      catch(reject: (error: unknown) => unknown) { return query.then(undefined, reject); },
      finally(done: () => void) { return query.then((v: unknown) => { done(); return v; }, (e: unknown) => { done(); throw e; }); },
      values() { return query; },
    };
    return query;
  };
  client.end = end;
  client.id = id;
  return Object.assign(client, { calls });
}

const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
const quiet = { warn: () => undefined };

describe("isRetryableRead", () => {
  it.each([
    [["select id from workspaces where id = ", ""], true],
    [["  -- note\nselect 1 from t"], true],
    [["with x as (select 1 from t) select * from x"], true],
    [["select count(*) from t for update"], false],
    [["select fn(", ")"], false],
    [["select nextval('s') from t"], false],
    [["with x as (update t set a = 1 returning *) select * from x"], false],
    [["insert into t values (", ")"], false],
    [["update t set a = 1"], false],
    [["delete from t"], false],
  ])("%j -> %s", (strings, expected) => {
    expect(isRetryableRead(strings)).toBe(expected);
  });
});

describe("isConnectionLevelError", () => {
  it("recognises dead-connection errors only", () => {
    expect(isConnectionLevelError(reset())).toBe(true);
    expect(isConnectionLevelError({ code: "57P01" })).toBe(true);
    expect(isConnectionLevelError({ code: "CONNECTION_CLOSED" })).toBe(true);
    expect(isConnectionLevelError({ code: "CONNECTION_ENDED" })).toBe(false);
    expect(isConnectionLevelError({ code: "23505" })).toBe(false);
    expect(isConnectionLevelError(new Error("x"))).toBe(false);
  });
});

describe("resilientSql", () => {
  it("passes queries through while activity is continuous", async () => {
    let clock = 0;
    const clients = [fakeClient(1, () => [{ ok: 1 }])];
    const create = vi.fn(() => clients[create.mock.calls.length - 1]!);
    const { sql } = resilientSql(create as any, { gapMs: 1_000, now: () => clock, log: quiet });
    clock = 500;
    expect(await (sql as any)`select 1 from t`).toEqual([{ ok: 1 }]);
    clock = 1_400;
    await (sql as any)`select 1 from t`;
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("replaces the pool after an activity gap and runs the query on the new one", async () => {
    let clock = 0;
    const stale = fakeClient(1, () => { throw reset(); });
    const fresh = fakeClient(2, () => [{ ok: 1 }]);
    const clients = [stale, fresh];
    const create = vi.fn(() => clients[create.mock.calls.length - 1]!);
    const onResume = vi.fn();
    const { sql } = resilientSql(create as any, { gapMs: 1_000, now: () => clock, log: quiet, onResume });
    clock = 60_000; // suspended for a minute
    const query = (sql as any)`select 1 from t`; // built on the stale client, awaited after the swap
    expect(await query).toEqual([{ ok: 1 }]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(stale.end).toHaveBeenCalledWith({ timeout: 5 });
    expect(stale.calls).toEqual([]);
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("recycles once for concurrent first queries after a gap", async () => {
    let clock = 0;
    const clients = [fakeClient(1, () => []), fakeClient(2, () => [])];
    const create = vi.fn(() => clients[create.mock.calls.length - 1]!);
    const { sql } = resilientSql(create as any, { gapMs: 1_000, now: () => clock, log: quiet });
    clock = 60_000;
    await Promise.all([(sql as any)`select 1 from a`, (sql as any)`select 1 from b`, (sql as any)`select 1 from c`]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(clients[1]!.calls).toHaveLength(3);
  });

  it("retries a read once after a connection-level error, on a fresh pool", async () => {
    const dead = fakeClient(1, () => reset());
    const fresh = fakeClient(2, () => [{ id: "w1" }]);
    const clients = [dead, fresh];
    const create = vi.fn(() => clients[create.mock.calls.length - 1]!);
    const { sql } = resilientSql(create as any, { gapMs: 0, log: quiet });
    expect(await (sql as any)`select id from workspaces where id = ${"w1"}`).toEqual([{ id: "w1" }]);
    expect(dead.calls).toHaveLength(1);
    expect(fresh.calls).toHaveLength(1);
  });

  it("gives up after one retry", async () => {
    const clients = [fakeClient(1, () => reset()), fakeClient(2, () => reset())];
    const create = vi.fn(() => clients[create.mock.calls.length - 1]!);
    const { sql } = resilientSql(create as any, { gapMs: 0, log: quiet });
    await expect((sql as any)`select id from workspaces`).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(clients[1]!.calls).toHaveLength(1);
  });

  it("never retries writes", async () => {
    const dead = fakeClient(1, () => reset());
    const create = vi.fn(() => dead);
    const { sql } = resilientSql(create as any, { gapMs: 0, log: quiet });
    await expect((sql as any)`insert into t (a) values (${1})`).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(dead.calls).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not retry errors that are not connection-level", async () => {
    const failing = fakeClient(1, () => Object.assign(new Error("syntax"), { code: "42601" }));
    const create = vi.fn(() => failing);
    const { sql } = resilientSql(create as any, { gapMs: 0, log: quiet });
    await expect((sql as any)`select x from t`).rejects.toMatchObject({ code: "42601" });
    expect(failing.calls).toHaveLength(1);
  });

  it("leaves fragments embeddable (never awaited)", () => {
    const create = () => fakeClient(1, () => []);
    const { sql } = resilientSql(create as any, { gapMs: 1_000, log: quiet });
    const fragment = (sql as any)`and a = ${1}`;
    expect(fragment.strings).toEqual(["and a = ", ""]);
    expect(fragment.args).toEqual([1]);
  });
});
