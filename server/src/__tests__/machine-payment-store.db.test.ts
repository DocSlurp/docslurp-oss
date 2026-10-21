import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { Store } from "mppx/server";

/** The mppx replay store on a migrated database (migration 0067). */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let storeModule: typeof import("../services/billing/machine-payment-store.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  storeModule = await import("../services/billing/machine-payment-store.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

describe("postgresMachinePaymentStore", () => {
  it("round-trips mppx JSON, including bigints, and deletes", async () => {
    const store = storeModule.postgresMachinePaymentStore(sql as never);
    await store.put("channel:1", { deposit: 5_000_000n, payer: "0xabc" });
    expect(await store.get("channel:1")).toEqual({ deposit: 5_000_000n, payer: "0xabc" });
    await store.delete("channel:1");
    expect(await store.get("channel:1")).toBeNull();
  });

  it("claims a replay key exactly once across concurrent attempts", async () => {
    const store = storeModule.postgresMachinePaymentStore(sql as never);
    const expires = Date.now() + 60_000;
    const claims = await Promise.all(Array.from({ length: 5 }, () => Store.tryClaim(store, "replay:0xtx", expires)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("applies update changes atomically, including on keys with no row yet", async () => {
    const store = storeModule.postgresMachinePaymentStore(sql as never);
    const increment = () => store.update("counter", (current) => ({ op: "set" as const, value: Number(current ?? 0) + 1, result: Number(current ?? 0) + 1 }));
    const results = await Promise.all([increment(), increment(), increment()]);
    expect(results.sort()).toEqual([1, 2, 3]);
    expect(await store.update("counter", () => ({ op: "delete" as const, result: "gone" }))).toBe("gone");
    expect(await store.get("counter")).toBeNull();
  });

  it("sweeps only rows past retention", async () => {
    await sql`insert into machine_payment_store (key, value, updated_at) values ('old', '1', now() - interval '31 days'), ('fresh', '1', now())`;
    expect(await storeModule.sweepMachinePaymentStore(sql as never)).toBe(1);
    expect((await sql`select key from machine_payment_store where key in ('old', 'fresh')`).map(row => row.key)).toEqual(["fresh"]);
  });
});
