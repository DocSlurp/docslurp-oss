import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { ApplicationFailure } from "@temporalio/common";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { WorkerSlotStore, resolveWorkerSlotOptions } from "../db/worker-slot-store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { withWorkerSlot } from "../temporal/activities.js";
import { WORKER_SLOT_UNAVAILABLE } from "../temporal/shared.js";

/**
 * The per-org slot semaphore against a database built from server/db/migrations:
 * plan caps per org, the fleet cap, release on failure, and expiry when a
 * worker stops heartbeating.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;

const options = { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 };

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000, { poolMax: 1, workerSlots: options });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, worker_slots)
    values ('free', 'Free', 'free', 'u1', 2), ('gold', 'Gold', 'gold', 'u1', 5)`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('wf', 'free', 'u1', 'F'), ('wg', 'gold', 'u1', 'G'), ('wn', null, 'u1', 'N')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values
    ('run-free-1', 'free', 'u1', 'wf', 'bulk-upload', 'processing', 'vision-extract', '{}'),
    ('run-free-2', 'free', 'u1', 'wf', 'bulk-upload', 'processing', 'vision-extract', '{}'),
    ('run-gold', 'gold', 'u1', 'wg', 'bulk-upload', 'processing', 'vision-extract', '{}'),
    ('run-orgless', null, 'u1', 'wn', 'bulk-upload', 'processing', 'vision-extract', '{}')`;
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await sql`delete from worker_slot_tokens`;
  await sql`update organizations set worker_slots = case id when 'free' then 2 when 'gold' then 5 else worker_slots end`;
});

const slots = (overrides: Partial<typeof options> = {}) => new WorkerSlotStore(sql, { ...options, ...overrides });

describe("worker slot semaphore", () => {
  it("holds each org to its plan worker_slots under concurrent claims, independently of other orgs", async () => {
    const semaphore = slots();
    const claims = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => semaphore.acquire({ runId: i % 2 ? "run-free-1" : "run-free-2", kind: "page", workerId: `w${i}` })),
      ...Array.from({ length: 9 }, (_, i) => semaphore.acquire({ runId: "run-gold", kind: "page", workerId: `g${i}` })),
    ]);
    const granted = (org: string) => claims.filter((claim) => claim.orgKey === org && claim.acquired).length;
    expect(granted("free")).toBe(2);
    expect(granted("gold")).toBe(5);
    expect(claims.filter((claim) => !claim.acquired).every((claim) => !claim.acquired && claim.reason === "org-cap")).toBe(true);
    expect(await semaphore.inflight("free")).toBe(2);
    expect(await semaphore.inflight("gold")).toBe(5);
  });

  it("frees a slot on release", async () => {
    const semaphore = slots();
    const first = await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "a" });
    await semaphore.acquire({ runId: "run-free-1", kind: "stage", workerId: "b" });
    expect((await semaphore.acquire({ runId: "run-free-2", kind: "page", workerId: "c" })).acquired).toBe(false);
    if (!first.acquired) throw new Error("expected a slot");
    await semaphore.release(first.leaseId);
    expect((await semaphore.acquire({ runId: "run-free-2", kind: "page", workerId: "c" })).acquired).toBe(true);
  });

  it("reclaims slots whose worker stopped heartbeating, and renewal keeps live ones", async () => {
    const semaphore = slots();
    const live = await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "live" });
    const dead = await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "dead" });
    if (!live.acquired || !dead.acquired) throw new Error("expected slots");
    // The dead worker's lease runs out (no renewals); the live one renews.
    await sql`update worker_slot_tokens set expires_at = now() - interval '1 second' where lease_id = ${dead.leaseId}`;
    expect(await semaphore.renew(live.leaseId)).toBe(true);
    const next = await semaphore.acquire({ runId: "run-free-2", kind: "page", workerId: "next" });
    expect(next.acquired).toBe(true);
    expect(await semaphore.renew(dead.leaseId)).toBe(false); // its token now belongs to the next claim
    expect(await semaphore.inflight("free")).toBe(2);
  });

  it("an expired lease cannot be revived by renewal, and its late release frees nothing", async () => {
    const semaphore = slots();
    const stale = await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "stale" });
    if (!stale.acquired) throw new Error("expected a slot");
    await sql`update worker_slot_tokens set expires_at = now() - interval '1 second' where lease_id = ${stale.leaseId}`;
    expect(await semaphore.renew(stale.leaseId)).toBe(false);
    expect(await semaphore.inflight("free")).toBe(0);
    const a = await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "a" });
    const b = await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "b" });
    expect([a.acquired, b.acquired]).toEqual([true, true]);
    await semaphore.release(stale.leaseId);
    expect(await semaphore.inflight("free")).toBe(2);
    expect((await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "c" })).acquired).toBe(false);
  });

  it("claims never wait on each other: one token per claim, one claim per token", async () => {
    // 40 concurrent claims for 5 slots, released and re-claimed in waves.
    const semaphore = slots();
    for (let wave = 0; wave < 3; wave++) {
      const claims = await Promise.all(Array.from({ length: 40 }, (_, i) =>
        semaphore.acquire({ runId: "run-gold", kind: i % 2 ? "page" : "stage", workerId: `w${wave}-${i}` })));
      const granted = claims.filter((claim) => claim.acquired);
      expect(granted).toHaveLength(5);
      const { rows } = { rows: await sql<{ slot_no: number }[]>`select slot_no from worker_slot_tokens where org_key = 'gold' and lease_id is not null order by slot_no` };
      expect(rows.map((row) => row.slot_no)).toEqual([0, 1, 2, 3, 4]);
      for (const claim of granted) if (claim.acquired) await semaphore.release(claim.leaseId);
      expect(await semaphore.inflight("gold")).toBe(0);
    }
  });

  it("resizing down drains held slots without ever exceeding the new cap; resizing up adds tokens", async () => {
    const semaphore = slots();
    const claim = (worker: string) => semaphore.acquire({ runId: "run-gold", kind: "page", workerId: worker });
    const held = [];
    for (let i = 0; i < 5; i++) held.push(await claim(`h${i}`));
    if (!held.every((c) => c.acquired)) throw new Error("expected 5 slots");
    const leases = held.map((c) => (c.acquired ? c.leaseId : ""));

    await sql`update organizations set worker_slots = 2 where id = 'gold'`;
    expect(await claim("x")).toMatchObject({ acquired: false, reason: "org-cap", inflight: 5, cap: 2 });
    // Leases on tokens above the new cap still count against it until released.
    for (const lease of leases.slice(0, 3)) await semaphore.release(lease);
    expect(await semaphore.inflight("gold")).toBe(2);
    expect((await claim("y")).acquired).toBe(false);
    await semaphore.release(leases[3]!);
    expect(await semaphore.inflight("gold")).toBe(1);
    const one = await claim("z");
    expect(one.acquired).toBe(true);
    expect((await claim("z2")).acquired).toBe(false);
    expect(await semaphore.inflight("gold")).toBe(2);
    await semaphore.release(leases[4]!);
    // Free tokens above the new cap are removed once nothing above it is held.
    await claim("z3");
    const [top] = await sql<{ top: number }[]>`select max(slot_no)::int as top from worker_slot_tokens where org_key = 'gold'`;
    expect(top!.top).toBe(1);
    expect(await semaphore.inflight("gold")).toBe(2);

    await sql`update organizations set worker_slots = 6 where id = 'gold'`;
    const grown = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(`g${i}`)));
    expect(grown.filter((c) => c.acquired)).toHaveLength(4);
    expect(await semaphore.inflight("gold")).toBe(6);
  });

  it("re-creates a token deleted by hand through the worker_slot_leases view", async () => {
    const semaphore = slots();
    const a = await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "a" });
    await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "b" });
    if (!a.acquired) throw new Error("expected a slot");
    await sql`delete from worker_slot_leases where lease_id = ${a.leaseId}`;
    expect((await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "c" })).acquired).toBe(true);
    expect((await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "d" })).acquired).toBe(false);
    const [view] = await sql<{ n: number }[]>`select count(*)::int as n from worker_slot_leases where org_key = 'free' and expires_at > now()`;
    expect(view!.n).toBe(2);
  });

  it("applies the fleet-wide cap across orgs", async () => {
    const semaphore = slots({ globalCap: 3 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await semaphore.acquire({ runId: "run-gold", kind: "page", workerId: `g${i}` }));
    // Gold's own cap (5) is clamped to the fleet cap.
    expect(results.filter((claim) => claim.acquired)).toHaveLength(3);
    const free = await semaphore.acquire({ runId: "run-free-1", kind: "page", workerId: "f" });
    expect(free).toMatchObject({ acquired: false, reason: "global-cap" });
  });

  it("gives runs without an org the default slots, keyed by workspace", async () => {
    const semaphore = slots();
    const claims = [];
    for (let i = 0; i < 3; i++) claims.push(await semaphore.acquire({ runId: "run-orgless", kind: "page", workerId: `n${i}` }));
    expect(claims.map((claim) => claim.acquired)).toEqual([true, true, false]);
    expect(claims[0]!.orgKey).toBe("workspace:wn");
  });

  it("withWorkerSlot releases on failure and reports a full org as WORKER_SLOT_UNAVAILABLE", async () => {
    await expect(withWorkerSlot(store, { runId: "run-free-1", kind: "page", enabled: true }, async () => {
      expect(await store.workerSlots.inflight("free")).toBe(1);
      throw new Error("parser crashed");
    })).rejects.toThrow("parser crashed");
    expect(await store.workerSlots.inflight("free")).toBe(0);

    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const held = [
      withWorkerSlot(store, { runId: "run-free-1", kind: "page", enabled: true }, () => blocker),
      withWorkerSlot(store, { runId: "run-free-2", kind: "stage", enabled: true }, () => blocker),
    ];
    await new Promise((resolve) => setTimeout(resolve, 50));
    const denied = await withWorkerSlot(store, { runId: "run-free-1", kind: "page", enabled: true }, async () => "ran")
      .catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(ApplicationFailure);
    expect((denied as ApplicationFailure).type).toBe(WORKER_SLOT_UNAVAILABLE);
    expect((denied as ApplicationFailure).nonRetryable).toBe(true);
    release();
    await Promise.all(held);
    expect(await store.workerSlots.inflight("free")).toBe(0);
    // Disabled gating never touches the table.
    expect(await withWorkerSlot(store, { runId: "run-free-1", kind: "page", enabled: false }, async () => "ran")).toBe("ran");
  });

  it("elects one maintenance leader until its lease lapses", async () => {
    expect(await store.tryMaintenanceLease("sweeps", "worker-a", 60_000)).toBe(true);
    expect(await store.tryMaintenanceLease("sweeps", "worker-b", 60_000)).toBe(false);
    expect(await store.tryMaintenanceLease("sweeps", "worker-a", 60_000)).toBe(true);
    await sql`update worker_maintenance_leases set expires_at = now() - interval '1 second' where name = 'sweeps'`;
    expect(await store.tryMaintenanceLease("sweeps", "worker-b", 60_000)).toBe(true);
    expect(await store.tryMaintenanceLease("sweeps", "worker-a", 60_000)).toBe(false);
  });
});

describe("resolveWorkerSlotOptions", () => {
  it("reads env with safe floors", () => {
    expect(resolveWorkerSlotOptions({})).toEqual({ enabled: true, ttlMs: 180_000, globalCap: 0, defaultOrgSlots: 50 });
    expect(resolveWorkerSlotOptions({ WORKER_SLOT_ENFORCEMENT: "false", WORKER_SLOT_LEASE_TTL_MS: "10", WORKER_GLOBAL_SLOT_CAP: "1000" }))
      .toEqual({ enabled: false, ttlMs: 15_000, globalCap: 1_000, defaultOrgSlots: 50 });
  });
});
