import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiPool, type ApiPool } from "../lib/api-pool.js";
import { freezeProcess, startSeverableProxy, type SeverableProxy } from "./helpers/severable-proxy.js";

/**
 * A Fly Machine resumed from a long suspend: its sockets were reset by the
 * network (pooler, NAT) while the process was frozen. The pool still holds
 * them, so the first queries failed with `read ECONNRESET` (2026-10-24) or, in
 * the variant reproduced here, never completed.
 *
 * Needs a real Postgres (PGlite serves one connection at a time and crashes on
 * abrupt closes): RESUME_TEST_DATABASE_URL=postgres://user:pass@host:port/db.
 * A TCP proxy in another process resets every connection ("the network forgot
 * them"), then this process is frozen so the RSTs sit unread, as in a snapshot.
 */
const target = process.env.RESUME_TEST_DATABASE_URL ? new URL(process.env.RESUME_TEST_DATABASE_URL) : null;
let proxy: SeverableProxy;
let url: string;
const pools: ApiPool[] = [];

beforeAll(async () => {
  if (!target) return;
  proxy = await startSeverableProxy(Number(target.port || 5432), target.hostname);
  const through = new URL(target);
  through.hostname = "127.0.0.1";
  through.port = String(proxy.port);
  url = through.toString();
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end({ timeout: 1 })));
  proxy?.stop();
});

function newPool(options: Parameters<typeof createApiPool>[1] = {}): ApiPool {
  const pool = createApiPool(url, { max: 4, resumeGapMs: 100, ...options });
  pools.push(pool);
  return pool;
}

async function warm(pool: ApiPool): Promise<void> {
  await Promise.all(Array.from({ length: 4 }, () => pool.sql`select pg_sleep(0.05)`));
}

/** Reset every pooled socket while the process is frozen for `ms`, then return. */
async function suspendAndResume(ms = 300): Promise<void> {
  expect(await proxy.sever()).toBeGreaterThan(0);
  freezeProcess(ms);
}

const settleWithin = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise.then((value) => ({ value }), (error: unknown) => ({ error })), new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), ms))]);

describe.skipIf(!target)("pool after the network reset its sockets during a freeze", () => {
  it("control (resume detection off): queries on the dead sockets fail or hang", async () => {
    const pool = newPool({ resumeGapMs: 0 });
    await warm(pool);
    await suspendAndResume();
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => settleWithin(pool.sql`select 1 as ok`, 3_000)));
    expect(outcomes.filter((outcome) => "error" in outcome || "hung" in outcome).length).toBeGreaterThan(0);
  }, 30_000);

  it("recycles pooled connections after the gap so every first query succeeds", async () => {
    const pool = newPool();
    await warm(pool);
    await suspendAndResume();
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => settleWithin(pool.sql`select 1 as ok`, 8_000)));
    expect(outcomes).toEqual(Array.from({ length: 4 }, () => ({ value: expect.anything() })));
    expect(await pool.ping(2_000)).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("reconnects LISTEN after a resume and reports the resubscription for catch-up", async () => {
    const pool = newPool();
    const received: string[] = [];
    let subscribed = 0;
    await pool.listen("resume_test", (payload) => received.push(payload), () => { subscribed += 1; });
    expect(subscribed).toBe(1);
    await suspendAndResume();
    await pool.sql`select pg_notify('resume_test', 'after-resume')`;
    await expect.poll(() => received, { timeout: 5_000 }).toEqual(["after-resume"]);
    expect(subscribed).toBe(2);
  }, 30_000);
});
