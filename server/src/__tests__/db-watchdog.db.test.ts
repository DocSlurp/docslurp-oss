import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase, serveOnRandomPort } from "@docslurp/worker/testing";

import { createApiPool, type ApiPool } from "../lib/api-pool.js";
import { createDbProbe, type DbProbe } from "../services/db-probe.js";
import {
  startDbWatchdog,
  stopDbWatchdog,
  type DbWatchdogDeps,
  type DbWatchdogOptions,
} from "../services/db-watchdog.js";

/**
 * The 2026-10-20 incident in miniature: a real postgres.js pool (max 2) is
 * saturated by many concurrent queries, so a probe queued in the pool times
 * out, while the database itself answers. The watchdog must not exit. When
 * the pool's connections are held with no database work at all (the dead
 * socket case), it must.
 */
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
let stopServer: () => Promise<void>;
let url: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const { server, port } = await serveOnRandomPort(db, { maxConnections: 8 });
  stopServer = () => server.stop();
  url = `postgres://postgres@127.0.0.1:${port}/postgres`;
}, 120_000);

afterAll(async () => {
  stopDbWatchdog();
  await stopServer?.();
  await db?.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function depsFor(pool: ApiPool, probe: DbProbe, warnings: string[]): DbWatchdogDeps {
  return {
    probe: (timeoutMs) => probe.ping(timeoutMs),
    pool: () => pool.activity.snapshot(),
    activeBackends: (timeoutMs) => probe.activeBackends(pool.applicationName, timeoutMs),
    now: Date.now,
    log: { warn: (message) => warnings.push(message), error: (message) => warnings.push(message) },
  };
}

async function poolProbe(pool: ApiPool, timeoutMs: number): Promise<"ok" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pool.sql`select 1`.then(() => "ok" as const),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const options: DbWatchdogOptions = { intervalMs: 100, timeoutMs: 500, exitAfterMs: 1_500, poolStallMs: 1_500 };

describe("database watchdog against a real pool", () => {
  it("does not exit when search-like load saturates the pool but the database answers", async () => {
    const pool = createApiPool(url, { max: 2, applicationName: "docslurp-api:saturated" });
    const probe = createDbProbe(url, { applicationName: "docslurp-api:saturated" });
    const warnings: string[] = [];
    let running = true;
    // Search-like load: 30 callers each hold a connection for 50 ms per
    // transaction (the session-persist shape: a few statements plus app work
    // between them), and 20 more issue plain queries back to back. A new pool
    // query waits behind roughly 30 x 50 ms / 2 connections. PGlite runs one
    // statement at a time, so the load keeps database-side work tiny; the
    // contention is in the pool, as it was in production.
    const load = [
      ...Array.from({ length: 30 }, async () => {
        while (running) await pool.sql.begin(async (tx) => { await tx`select 1`; await sleep(50); });
      }),
      ...Array.from({ length: 20 }, async () => {
        while (running) await pool.sql`select 1`;
      }),
    ];
    try {
      await sleep(300);
      // The old watchdog probe (select 1 through the pool, 500 ms timeout) fails here.
      expect(await poolProbe(pool, 500)).toBe("timeout");
      expect(pool.activity.snapshot().inFlight).toBeGreaterThan(10);

      const exits: number[] = [];
      const completedBefore = pool.activity.snapshot().completed;
      startDbWatchdog(options, (code) => exits.push(code), depsFor(pool, probe, warnings));
      await sleep(3_500);
      stopDbWatchdog();

      expect(exits).toEqual([]);
      expect(warnings.filter((message) => message.includes("probe failed"))).toEqual([]);
      expect(pool.activity.snapshot().completed - completedBefore).toBeGreaterThan(20);
      expect((await probe.ping(500)).ok).toBe(true);
    } finally {
      running = false;
      await Promise.allSettled(load);
      await probe.close();
      await pool.sql.end({ timeout: 1 });
    }
  }, 30_000);

  it("exits when the pool's connections are stuck with no database activity", async () => {
    const pool = createApiPool(url, { max: 2, applicationName: "docslurp-api:wedged" });
    const probe = createDbProbe(url, { applicationName: "docslurp-api:wedged" });
    const warnings: string[] = [];
    // Both connections are taken and never answer, like sockets that died silently.
    const held = await Promise.all([pool.sql.reserve(), pool.sql.reserve()]);
    const queued = Array.from({ length: 3 }, () => pool.sql`select 1`.catch(() => undefined));
    try {
      const exited = new Promise<number>((resolve) => {
        startDbWatchdog(options, resolve, depsFor(pool, probe, warnings));
      });
      const code = await Promise.race([exited, sleep(6_000).then(() => "no exit" as const)]);
      stopDbWatchdog();
      expect(code).toBe(1);
      expect(warnings.at(-1)).toMatch(/none completed .* runs none of them/);
    } finally {
      for (const connection of held) connection.release();
      await Promise.allSettled(queued);
      await probe.close();
      await pool.sql.end({ timeout: 1 });
    }
  }, 30_000);
});
