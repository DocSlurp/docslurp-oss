import { testMigrationPath } from "../test/migration-path.js";
import postgres from "postgres";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMigratedPostgres } from "../test/migrated-postgres.js";
import { computeJobAdmission } from "../db/compute-job-store.js";
import { createExtractorPluginHost, setExtractorComputeJobAdmission } from "../extractors/plugins.js";

type ReconcileRoleGrants = (client: unknown, options: { roles?: Record<string, string>; log: () => void }) => Promise<unknown>;
async function loadReconcileRoleGrants(): Promise<ReconcileRoleGrants> {
  const rolesModule = pathToFileURL(path.resolve(import.meta.dirname, "../../../server/db/roles.mjs")).href;
  return ((await import(/* @vite-ignore */ rolesModule)) as { reconcileRoleGrants: ReconcileRoleGrants }).reconcileRoleGrants;
}

let sql: ReturnType<typeof postgres>, stop: () => Promise<void>;
beforeAll(async () => {
  const db = await startMigratedPostgres();
  stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql.unsafe("create role docslurp_app nologin; create role docslurp_worker nologin; create role custom_app nologin");
  await sql.unsafe("grant select,insert,update,delete on compute_job_fleets,compute_job_tickets to custom_app");
  // Re-applying the migration once roles exist closes inherited grants before any reconciliation.
  await sql.unsafe(await readFile(testMigrationPath("0186_compute_job_admission.sql"), "utf8"));
  const [upgrade] = await sql`select has_table_privilege('custom_app','compute_job_fleets','UPDATE') as cap_write,
    has_table_privilege('custom_app','compute_job_tickets','SELECT') as ticket_read`;
  expect(upgrade).toEqual({ cap_write: false, ticket_read: false });
  const client = { query: async (statement: string, params: unknown[] = []) => ({ rows: await sql.unsafe(statement, params as postgres.ParameterOrJSON<never>[]) }) };
  await (await loadReconcileRoleGrants())(client, { log: () => {} });
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

const org = (name: string) => createHash("sha256").update(`test-org:${name}`).digest("hex");
async function fleet(maxJobs: number, perOrg: number, enabled = true) {
  const id = `test-jobs:${randomUUID()}`;
  await sql`insert into compute_job_fleets(id,max_jobs,max_jobs_per_org,enabled) values(${id},${maxJobs},${perOrg},${enabled})`;
  return id;
}
async function asRole<T>(role: string, work: () => Promise<T>) {
  await sql.unsafe(`set role ${role}`);
  try { return await work(); } finally { await sql.unsafe("reset role"); }
}
/**
 * One simulated worker: its own admission object. PGlite serves one connection, so these share it; true parallel
 * connections are exercised by compute-job-admission.pg.test.ts against real PostgreSQL.
 */
const worker = () => computeJobAdmission(sql);
async function enqueue(f: string, orgName: string, pages = 1, w = worker()) {
  const ticketId = randomUUID();
  expect(await w.register({ fleetId: f, ticketId, orgKey: org(orgName), pages }, "waiting", 60)).toBe(true);
  return ticketId;
}

describe("fleet-wide fair job admission", () => {
  it("never admits past the fleet or organization cap, and a burst cannot starve another organization", async () => {
    const f = await fleet(4, 3);
    const a = [] as string[];
    for (let i = 0; i < 8; i++) a.push(await enqueue(f, "a"));
    const b = await enqueue(f, "b");
    const states = [] as string[];
    for (const id of [...a, b]) states.push(await worker().admit(f, id, 60));
    // Org A's burst arrived first, yet holds only its cap (3); org B's single job takes the fourth slot.
    expect(states.filter((s) => s === "admitted")).toHaveLength(4);
    expect(states.at(-1)).toBe("admitted");
    expect(states.slice(0, 3)).toEqual(["admitted", "admitted", "admitted"]);
    const demand = await worker().demand(f, org("b"));
    expect(demand).toMatchObject({ maxJobs: 4, maxJobsPerOrg: 3, org: { admitted: { jobs: 1, pages: 1 }, waiting: { jobs: 0 } },
      fleet: { admitted: { jobs: 4 }, waiting: { jobs: 5 } } });
  });

  it("gives a freed slot to the organization holding the fewest, not to the oldest waiter (cap exhaustion)", async () => {
    const f = await fleet(2, 2);
    const a1 = await enqueue(f, "a"), a2 = await enqueue(f, "a"), a3 = await enqueue(f, "a");
    expect(await worker().admit(f, a1, 60)).toBe("admitted");
    expect(await worker().admit(f, a2, 60)).toBe("admitted");
    expect(await worker().admit(f, a3, 60)).toBe("waiting");
    const b1 = await enqueue(f, "b");
    expect(await worker().admit(f, b1, 60)).toBe("waiting");
    await worker().release(f, a1);
    // A's older waiter loses to B, which holds nothing.
    expect(await worker().admit(f, a3, 60)).toBe("waiting");
    expect(await worker().admit(f, b1, 60)).toBe("admitted");
  });

  it("two organizations racing across simulated workers stay within both caps", async () => {
    const f = await fleet(6, 4);
    const w1 = worker(), w2 = worker();
    const tickets = await Promise.all([
      ...Array.from({ length: 12 }, () => enqueue(f, "a", 2, w1)),
      ...Array.from({ length: 4 }, () => enqueue(f, "b", 1, w2)),
    ]);
    // Every worker polls every ticket it owns, interleaved, twice (later polls see slots admitted by other workers).
    for (let round = 0; round < 2; round++) await Promise.all(tickets.map((id, i) => (i < 12 ? w1 : w2).admit(f, id, 60)));
    const rows = await sql<{ org_key: string; n: number }[]>`select org_key, count(*)::int as n from compute_job_tickets
      where fleet_id=${f} and state='admitted' group by org_key`;
    const held = Object.fromEntries(rows.map((r) => [r.org_key, r.n]));
    expect((held[org("a")] ?? 0) + (held[org("b")] ?? 0)).toBe(6);
    expect(held[org("a")]).toBeLessThanOrEqual(4);
    // B's four arrive after A's twelve and still get at least the slots A cannot hold.
    expect(held[org("b")]).toBeGreaterThanOrEqual(2);
  });

  it("reclaims a dead worker's slot when its lease lapses (worker restart)", async () => {
    const f = await fleet(1, 1);
    const dead = await enqueue(f, "a");
    expect(await worker().admit(f, dead, 60)).toBe("admitted");
    const waiting = await enqueue(f, "b", 1, worker());
    expect(await worker().admit(f, waiting, 60)).toBe("waiting");
    // The worker holding `dead` crashed and stopped renewing: its lease runs out.
    await sql`update compute_job_tickets set expires_at = clock_timestamp() - interval '1 second' where id=${dead}`;
    expect(await worker().admit(f, waiting, 60)).toBe("admitted");
    // The restarted worker cannot keep using the slot it lost.
    expect(await worker().renew(f, dead, 60)).toBe(false);
    expect(await worker().admit(f, dead, 60)).toBe("unknown");
  });

  it("routing tickets count as demand but never hold a slot until they join the queue", async () => {
    const f = await fleet(1, 1);
    const id = randomUUID();
    expect(await worker().register({ fleetId: f, ticketId: id, orgKey: org("a"), pages: 7 }, "routing", 30)).toBe(true);
    expect((await worker().demand(f, org("a")))?.org.routing).toEqual({ jobs: 1, pages: 7 });
    const queued = await enqueue(f, "b");
    expect(await worker().admit(f, queued, 60)).toBe("admitted");
    expect(await worker().admit(f, id, 60)).toBe("waiting");
  });

  it("fails closed on a missing or disabled fleet and refuses a reused ticket id", async () => {
    const off = await fleet(4, 2, false);
    const id = randomUUID();
    expect(await worker().register({ fleetId: off, ticketId: id, orgKey: org("a"), pages: 1 }, "waiting", 60)).toBe(false);
    expect(await worker().admit(off, id, 60)).toBe("unavailable");
    expect(await worker().demand(off, org("a"))).toBeNull();
    expect(await worker().demand("test-jobs:missing", org("a"))).toBeNull();
    const f = await fleet(2, 1);
    const reused = await enqueue(f, "a");
    await expect(worker().register({ fleetId: f, ticketId: reused, orgKey: org("b"), pages: 1 }, "waiting", 60)).rejects.toThrow(/cannot be reused/);
    await expect(worker().register({ fleetId: f, ticketId: randomUUID(), orgKey: "org-id-not-hash", pages: 1 }, "waiting", 60)).rejects.toThrow(/organization key/);
    await expect(worker().register({ fleetId: f, ticketId: randomUUID(), orgKey: org("a"), pages: 0 }, "waiting", 60)).rejects.toThrow(/pages/);
  });

  it("runs as the worker role; the API role reaches neither the tickets nor the admission function", async () => {
    const f = await fleet(2, 1);
    await asRole("docslurp_worker", async () => {
      const id = await enqueue(f, "a");
      expect(await worker().admit(f, id, 60)).toBe("admitted");
      await expect(sql`update compute_job_fleets set max_jobs=100 where id=${f}`).rejects.toThrow();
    });
    await asRole("docslurp_app", async () => {
      await expect(sql`select * from compute_job_tickets`).rejects.toThrow();
      await expect(sql`select public.compute_job_admit(${f}, ${randomUUID()}::uuid, 60)`).rejects.toThrow();
    });
  });

  it("binds the host seam, and an unbound worker refuses", async () => {
    const host = createExtractorPluginHost();
    setExtractorComputeJobAdmission(undefined);
    await expect(host.computeJobAdmission.demand("x", org("a"))).rejects.toThrow(/not bound/);
    setExtractorComputeJobAdmission(computeJobAdmission(sql));
    const f = await fleet(1, 1);
    expect(await host.computeJobAdmission.demand(f, org("a"))).toMatchObject({ maxJobs: 1 });
    setExtractorComputeJobAdmission(undefined);
  });
});
