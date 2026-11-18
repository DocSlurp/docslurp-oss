import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalIdForUrl } from "../lib/canonical-id.js";

/**
 * Real PostgreSQL, concurrent sessions: document deletion against itself and
 * against a worker completing a version. Deletion takes the version chain's
 * advisory key first (the key run creation and the supersession trigger take),
 * then rows FOR UPDATE NOWAIT, retrying the whole transaction on a conflict. So
 * concurrent deletes in one chain never leave a pointer to a deleted row, a
 * delete never deadlocks with a worker's supersession, and overlapping bulk
 * deletes in opposite orders both finish. Needs a migrated, disposable loopback
 * TEST_DATABASE_URL.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("document deletion under concurrency (real PostgreSQL)", () => {
  let pool: postgres.Sql;
  let worker: postgres.Sql;
  let deleteDocuments: typeof import("../services/documents.js").deleteDocuments;
  const user = "del-u";
  const project = "del-w";

  beforeAll(async () => {
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Requires a loopback TEST_DATABASE_URL");
    pool = postgres(url, { max: 8, prepare: false, onnotice: () => {} });
    worker = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
    vi.doMock("../db.js", () => ({ sql: pool }));
    vi.doMock("../lib/temporal.js", () => ({
      startPipelineWorkflow: vi.fn(async () => {}), signalPipelineCancel: vi.fn(), signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(),
      isTemporalClientConnected: () => true, onTemporalClientConnected: vi.fn(), warmTemporalClient: vi.fn(),
    }));
    ({ deleteDocuments } = await import("../services/documents.js"));
    await pool`insert into "user" (id, name, email) values (${user}, 'D', 'deletion-locks@example.test') on conflict do nothing`;
    await pool`insert into organizations (id, name, slug, created_by_user_id) values ('del-o', 'D', 'deletion-locks', ${user}) on conflict do nothing`;
    await pool`insert into org_memberships (org_id, user_id, role) values ('del-o', ${user}, 'owner') on conflict do nothing`;
    await pool`insert into projects (id, org_id, user_id, name) values (${project}, 'del-o', ${user}, 'D') on conflict do nothing`;
    await pool`insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline)
      values (100, 'del-run', 'del-o', ${user}, ${project}, 'bulk-upload', 'completed', 'index', '{}'::jsonb) on conflict do nothing`;
  }, 120_000);
  afterAll(async () => { await pool?.end(); await worker?.end(); });

  /** A version chain under one canonical key: each row points at the one before. */
  async function chain(statuses: string[]) {
    const key = `chain-${randomUUID()}`;
    const ids = statuses.map(() => randomUUID());
    for (const [index, status] of statuses.entries()) {
      await pool`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id,
          version_number, previous_version_id, created_at)
        values (${ids[index]!}, 'del-o', ${user}, ${project}, 'del-run', 'doc.pdf', 'application/pdf', ${`k/${ids[index]}`}, ${status}, ${key},
          ${index + 1}, ${index ? ids[index - 1]! : null}, ${new Date(Date.UTC(2026, 0, 1 + index))})`;
    }
    return { key, ids };
  }

  /** Rows of this project that point at a document that no longer exists. */
  const dangling = () => pool<{ id: string }[]>`
    select d.id from documents d
    where d.project_id = ${project} and d.previous_version_id is not null
      and not exists (select 1 from documents p where p.id = d.previous_version_id)`;

  it("concurrent deletes of A and B in A→B→C leave C pointing at no deleted row", async () => {
    for (let round = 0; round < 20; round++) {
      const { ids: [a, b, c] } = await chain(["completed", "completed", "completed"]);
      const outcomes = await Promise.all([deleteDocuments([a!], user), deleteDocuments([b!], user)]);
      expect(outcomes).toEqual([1, 1]);
      const [rowC] = await pool<{ previous_version_id: string | null }[]>`select previous_version_id from documents where id = ${c!}`;
      expect(rowC).toEqual({ previous_version_id: null });
    }
    expect(await dangling()).toEqual([]);
    // Forced interleaving: both deletes queue on the chain key a third session holds, then run one after the other.
    const { key, ids: [a, b, c] } = await chain(["completed", "completed", "completed"]);
    const holder = await worker.reserve();
    await holder`begin`;
    await holder`select pg_advisory_xact_lock(hashtextextended(${`${project}:${key}`}, 0))`;
    const both = Promise.all([deleteDocuments([a!], user), deleteDocuments([b!], user)]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await holder`commit`;
    holder.release();
    expect(await both).toEqual([1, 1]);
    expect(await pool`select previous_version_id from documents where id = ${c!}`).toEqual([{ previous_version_id: null }]);
  }, 60_000);

  it("delete X while the worker completes its successor Y, worker first: no 40P01, both in their final state", async () => {
    const { ids: [a, b] } = await chain(["completed", "processing"]);
    // The worker holds the newer version's row, as its completing UPDATE does before the supersession trigger runs.
    const session = await worker.reserve();
    await session`begin`;
    await session`select id from documents where id = ${b!} for update`;
    const deletion = deleteDocuments([a!], user).then((n) => n, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The worker completes B: its trigger takes the chain key and supersedes A. Before, the delete held A and
    // waited for B while the trigger held B and waited for A (40P01).
    let workerError: unknown = null;
    try {
      await session`update documents set status = 'completed' where id = ${b!}`;
      await session`commit`;
    } catch (error) {
      workerError = error;
      await session`rollback`.catch(() => {});
    } finally {
      session.release();
    }
    expect(workerError).toBeNull();
    expect(await deletion).toBe(1);
    expect(await pool`select id from documents where id = ${a!}`).toEqual([]);
    expect(await pool`select status, previous_version_id from documents where id = ${b!}`).toEqual([{ status: "completed", previous_version_id: null }]);
  }, 30_000);

  it("delete X while the worker completes its successor Y, deletion first: the worker waits, no 40P01, both final", async () => {
    const { ids: [x, y] } = await chain(["completed", "processing"]);
    // Session B pauses the deletion after it holds the chain key, X and Y (its project update waits).
    const blocker = await worker.reserve();
    await blocker`begin`;
    await blocker`select id from projects where id = ${project} for update`;
    const deletion = deleteDocuments([x!], user).then((n) => n, (error: unknown) => error);
    for (let i = 0; i < 100; i++) {
      const [row] = await pool<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query ilike '%update projects set retention_changed_at%'`;
      if (row!.n > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // The worker completes Y now: its UPDATE waits on the deletion's row lock (then its trigger on the chain key).
    const completion = worker`update documents set status = 'completed' where id = ${y!}`.then(() => "completed", (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await blocker`commit`;
    blocker.release();
    expect(await deletion).toBe(1);
    expect(await completion).toBe("completed");
    expect(await pool`select id from documents where id = ${x!}`).toEqual([]);
    expect(await pool`select status, previous_version_id, superseded_at from documents where id = ${y!}`)
      .toEqual([{ status: "completed", previous_version_id: null, superseded_at: null }]);
  }, 30_000);

  it("a delete of an old version racing a worker whose newest version supersedes several rows ends without a deadlock", async () => {
    for (let round = 0; round < 5; round++) {
      const { ids: [a, b, c] } = await chain(["completed", "completed", "processing"]);
      const session = await worker.reserve();
      await session`begin`;
      await session`select id from documents where id = ${c!} for update`;
      const deletion = deleteDocuments([a!], user).then((n) => n, (error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 50 * round));
      // Completing C supersedes A and B (the trigger locks the older rows); the delete rewires B.
      await session`update documents set status = 'completed' where id = ${c!}`;
      await session`commit`;
      session.release();
      expect(await deletion).toBe(1);
      expect(await pool`select id, superseded_at is not null as superseded, previous_version_id from documents where id = any(${pool.array([b!, c!])}) order by created_at`)
        .toEqual([{ id: b!, superseded: true, previous_version_id: null }, { id: c!, superseded: false, previous_version_id: b! }]);
    }
  }, 60_000);

  it("two overlapping bulk deletes in opposite order both finish, and nothing points at a deleted row", async () => {
    for (let round = 0; round < 20; round++) {
      const one = await chain(["completed", "completed", "completed"]);
      const two = await chain(["completed", "completed", "completed"]);
      const forward = [one.ids[0]!, one.ids[1]!, two.ids[0]!, two.ids[1]!];
      const outcomes = await Promise.allSettled([deleteDocuments(forward, user), deleteDocuments([...forward].reverse(), user)]);
      for (const outcome of outcomes) expect(outcome.status).toBe("fulfilled");
      // Each row is deleted once, by one of the two.
      expect(outcomes.reduce((sum, outcome) => sum + (outcome.status === "fulfilled" ? outcome.value : 0), 0)).toBe(4);
      expect(await pool`select previous_version_id from documents where id = any(${pool.array([one.ids[2]!, two.ids[2]!])})`)
        .toEqual([{ previous_version_id: null }, { previous_version_id: null }]);
    }
    expect(await dangling()).toEqual([]);
  }, 120_000);

  it("deletes 500 URL documents through the bulk route in chunks, holding one chunk's keys at a time; 501 ids get a 400", async () => {
    const { documentsRoutes } = await import("../routes/documents.js");
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionUser", { id: user } as never); await next(); });
    app.route("/documents", documentsRoutes);
    const bulk = (documentIds: string[]) => app.request("/documents/bulk", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", documentIds }),
    });
    // 250 two-version URL chains: 500 URL documents (three chain keys each), each chain's newer version pointing at its older.
    const tag = randomUUID().slice(0, 8);
    const ids: string[] = [];
    for (let chainIndex = 0; chainIndex < 250; chainIndex++) {
      const sourceUrl = `https://example.com/${tag}/doc-${chainIndex}`;
      const [older, newer] = [randomUUID(), randomUUID()];
      for (const [index, id] of [older, newer].entries()) {
        await pool`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id, metadata,
            version_number, previous_version_id, created_at)
          values (${id}, 'del-o', ${user}, ${project}, 'del-run', 'doc.html', 'text/html', ${`k/${id}`}, 'completed', ${canonicalIdForUrl(sourceUrl)},
            ${pool.json({ sourceUrl })}, ${index + 1}, ${index ? older : null}, ${new Date(Date.UTC(2026, 0, 1 + index))})`;
      }
      ids.push(older, newer);
    }
    // 501 ids: refused before any lookup, with the limit in the public copy.
    const over = await bulk([...ids, randomUUID()]);
    expect(over.status).toBe(400);
    const body = await over.json() as { error: { code: string; message: string; details: { policy: string; limit: number } } };
    expect(body.error).toMatchObject({ code: "invalid_request", details: { policy: "bulk_documents_limit", limit: 500 } });
    expect(body.error.message).toContain("at most 500");
    // 500: deleted in chunks; a sampler records the most advisory locks any one backend held at once.
    let peak = 0;
    const sampler = setInterval(() => {
      void pool<{ n: number }[]>`select coalesce(max(n), 0)::int as n from (select count(*) as n from pg_locks where locktype = 'advisory' and granted group by pid) s`
        .then(([row]) => { peak = Math.max(peak, row!.n); }, () => {});
    }, 5);
    let response: Response;
    try {
      response = await bulk(ids);
    } finally {
      clearInterval(sampler);
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deleted: 500 });
    expect(await pool`select id from documents where id = any(${pool.array(ids)})`).toEqual([]);
    // One chunk of 100 URL documents holds at most its own keys (3 per document), never all 1,500.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(300);
  }, 120_000);
});
