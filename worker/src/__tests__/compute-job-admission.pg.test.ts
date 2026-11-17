/** Real PostgreSQL concurrency gate for fair job admission. Use an explicitly supplied disposable local database. */
import postgres from "postgres";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeJobAdmission } from "../db/compute-job-store.js";

const url = process.env.TEST_DATABASE_URL;
let workers: ReturnType<typeof postgres>[] = [];
beforeAll(async () => {
  if (!url) return;
  // Eight simulated workers, each with its own connections.
  workers = Array.from({ length: 8 }, () => postgres(url, { max: 4, prepare: false, onnotice: () => {} }));
  const [{ exists }] = await workers[0]`select to_regclass('public.compute_fleets') is not null as exists`;
  if (!exists) await workers[0].unsafe(await readFile(new URL("../../../server/db/migrations/0181_compute_fleet_admission.sql", import.meta.url), "utf8"));
  await workers[0].unsafe(await readFile(new URL("../../../server/db/migrations/0186_compute_job_admission.sql", import.meta.url), "utf8"));
});
afterAll(async () => { await Promise.all(workers.map((sql) => sql.end())); });
const org = (name: string) => createHash("sha256").update(`pg-org:${name}`).digest("hex");

describe.skipIf(!url)("real PostgreSQL fair job admission", () => {
  it("admits exactly the fleet cap, at most the organization cap, under 96 simultaneous polls from 8 workers", async () => {
    const f = `concurrency-jobs:${randomUUID()}`;
    await workers[0]`insert into compute_job_fleets(id,max_jobs,max_jobs_per_org,enabled) values(${f},8,5,true)`;
    const tickets = Array.from({ length: 48 }, (_, i) => ({ id: randomUUID(), org: i % 6 === 0 ? "b" : "a", worker: workers[i % 8] }));
    await Promise.all(tickets.map((t) => computeJobAdmission(t.worker).register({ fleetId: f, ticketId: t.id, orgKey: org(t.org), pages: 1 }, "waiting", 60)));
    for (let round = 0; round < 2; round++) {
      await Promise.all(tickets.map((t) => computeJobAdmission(t.worker).admit(f, t.id, 60)));
    }
    const rows = await workers[0]<{ org_key: string; n: number }[]>`select org_key, count(*)::int as n from compute_job_tickets
      where fleet_id=${f} and state='admitted' group by org_key`;
    const held = Object.fromEntries(rows.map((r) => [r.org_key, r.n]));
    expect((held[org("a")] ?? 0) + (held[org("b")] ?? 0)).toBe(8);
    expect(held[org("a")]).toBeLessThanOrEqual(5);
    expect(held[org("b")]).toBeGreaterThanOrEqual(3);
  });

  it("an operator disable stops admission on the next poll, whatever a worker saw earlier", async () => {
    const f = `concurrency-jobs:${randomUUID()}`;
    await workers[0]`insert into compute_job_fleets(id,max_jobs,max_jobs_per_org,enabled) values(${f},4,4,true)`;
    const id = randomUUID();
    await computeJobAdmission(workers[1]).register({ fleetId: f, ticketId: id, orgKey: org("a"), pages: 1 }, "waiting", 60);
    await workers[0]`update compute_job_fleets set enabled=false where id=${f}`;
    expect(await computeJobAdmission(workers[1]).admit(f, id, 60)).toBe("unavailable");
  });
});
