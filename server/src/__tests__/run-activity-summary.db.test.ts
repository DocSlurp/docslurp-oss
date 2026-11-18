import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The activity-feed organization summary and the upload-session progress block against a database built from
 * db/migrations. Tenant boundary: one organization's runs, pages and rates never appear in another's summary or in
 * an upload session's progress, and the per-organization cache never serves one organization's value to another.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let summary: typeof import("../services/run-activity-summary.js");
let sessions: typeof import("../services/direct-upload-session.js");

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function addRun(id: string, args: { org: string; project: string; user: string; status: string; docs?: number; docsDone?: number;
  pages?: number; pagesDone?: number; startedMinutesAgo?: number | null; createdMinutesAgo?: number; updatedMinutesAgo?: number }) {
  const created = minutesAgo(args.createdMinutesAgo ?? 30);
  const updated = minutesAgo(args.updatedMinutesAgo ?? 0);
  const started = args.startedMinutesAgo === undefined || args.startedMinutesAgo === null ? null : minutesAgo(args.startedMinutesAgo);
  await sql`insert into project_runs (id, user_id, project_id, org_id, kind, status, stage, total_documents, processed_documents,
      pages_total, pages_processed, worker_started_at, created_at, updated_at, monthly_reservation_cents)
    values (${id}, ${args.user}, ${args.project}, ${args.org}, 'direct-upload', ${args.status}, 'extract-markdown', ${args.docs ?? 1},
      ${args.docsDone ?? 0}, ${args.pages ?? 0}, ${args.pagesDone ?? 0}, ${started}, ${created}, ${updated}, 1)`;
}

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u-a', 'A', 'a@summary.test'), ('u-b', 'B', 'b@summary.test'), ('u-none', 'N', 'n@summary.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, personal_owner_user_id) values
    ('org-a', 'A', 'summary-a', 'u-a', 'u-a'), ('org-b', 'B', 'summary-b', 'u-b', 'u-b')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('org-a', 'u-a', 'owner'), ('org-b', 'u-b', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('p-a', 'org-a', 'u-a', 'A'), ('p-b', 'org-b', 'u-b', 'B')`;
  summary = await import("../services/run-activity-summary.js");
  sessions = await import("../services/direct-upload-session.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  summary.clearActivitySummaryCache();
  await sql`delete from project_runs`;
  await sql`delete from project_corpus_stats`;
});

describe("organization activity summary", () => {
  it("counts queued, in-progress and recently completed work and its rate for one organization only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // History for p-a: 600 pages in 60 minutes (10 pages/min), via the completed-run trigger.
    await addRun("a-hist", { org: "org-a", project: "p-a", user: "u-a", status: "completed", docs: 3, docsDone: 3, pages: 600, pagesDone: 600, createdMinutesAgo: 600, updatedMinutesAgo: 540 });
    await addRun("a-done", { org: "org-a", project: "p-a", user: "u-a", status: "completed", docs: 2, docsDone: 2, pages: 40, pagesDone: 40, createdMinutesAgo: 20, updatedMinutesAgo: 5 });
    await addRun("a-run", { org: "org-a", project: "p-a", user: "u-a", status: "processing", docs: 4, docsDone: 1, pages: 400, pagesDone: 100, startedMinutesAgo: 10 });
    await addRun("a-queue", { org: "org-a", project: "p-a", user: "u-a", status: "queued", docs: 5, pages: 50 });
    // Organization B is busy too: none of it may show up in A's summary.
    await addRun("b-run", { org: "org-b", project: "p-b", user: "u-b", status: "processing", docs: 99, pages: 9_000, pagesDone: 9_000 - 1, startedMinutesAgo: 1 });
    await addRun("b-queue", { org: "org-b", project: "p-b", user: "u-b", status: "queued", docs: 77, pages: 7_000 });
    await addRun("b-done", { org: "org-b", project: "p-b", user: "u-b", status: "completed", docs: 55, docsDone: 55, pages: 5_000, pagesDone: 5_000, createdMinutesAgo: 10, updatedMinutesAgo: 1 });

    const a = await summary.computeOrgActivitySummary("org-a");
    expect(a.queued).toEqual({ runs: 1, documents: 5, pages: 50 });
    expect(a.inProgress).toEqual({ runs: 1, documents: 3, pages: 300, pagesProcessed: 100, pagesTotal: 400 });
    expect(a.recentlyCompleted).toEqual({ runs: 1, documents: 2, pages: 40 });
    expect(a.pagesPerMinute).toBeCloseTo(10, 0);
    // The processing run: 300 pages at 10/min = 30 min; the queued run from history: 50 pages at 10/min = 5 min.
    expect(a.eta).toMatchObject({ bucket: "15-60m", estimate: true });
    expect(a.truncated).toBe(false);

    const b = await summary.computeOrgActivitySummary("org-b");
    expect(b.queued).toEqual({ runs: 1, documents: 77, pages: 7_000 });
    expect(b.recentlyCompleted).toEqual({ runs: 1, documents: 55, pages: 5_000 });
    // B's ETA comes from B's own history (5,000 pages in 9 minutes): 7,000 queued pages is about 12.6 minutes.
    expect(b.eta).toMatchObject({ bucket: "5-15m", estimate: true });
  });

  it("has no ETA (estimating) while a queued run has no basis", async () => {
    await addRun("a-queue", { org: "org-a", project: "p-a", user: "u-a", status: "queued", docs: 1, pages: 50 });
    expect((await summary.computeOrgActivitySummary("org-a")).eta).toBeNull();
  });

  it("returns an empty summary for an organization with nothing running, not another organization's", async () => {
    await addRun("b-run", { org: "org-b", project: "p-b", user: "u-b", status: "processing", pages: 10, pagesDone: 5, startedMinutesAgo: 1 });
    const empty = await summary.computeOrgActivitySummary("org-a");
    expect(empty).toMatchObject({ queued: { runs: 0 }, inProgress: { runs: 0 }, recentlyCompleted: { runs: 0 }, pagesPerMinute: null, eta: null, truncated: false });
    expect(await summary.computeOrgActivitySummary("org-unknown")).toMatchObject({ inProgress: { runs: 0 } });
  });

  it("reads at most 200 active runs and says the summary is truncated instead of failing", async () => {
    await sql`insert into project_runs (id, user_id, project_id, org_id, kind, status, stage, total_documents, pages_total, created_at, monthly_reservation_cents)
      select 'bulk-' || g, 'u-a', 'p-a', 'org-a', 'direct-upload', 'queued', 'extract-markdown', 1, 2, now() - g * interval '1 second', 1
      from generate_series(1, 205) g`;
    const truncated = await summary.computeOrgActivitySummary("org-a");
    expect(truncated.truncated).toBe(true);
    expect(truncated.queued.runs).toBe(summary.ACTIVITY_SUMMARY_MAX_ACTIVE_RUNS);
    expect(truncated.eta).toBeNull();
  });

  it("caches per organization: one organization's cached value is never served to another", async () => {
    let now = 1_000_000;
    await addRun("a-queue", { org: "org-a", project: "p-a", user: "u-a", status: "queued", docs: 1, pages: 10 });
    await addRun("b-queue", { org: "org-b", project: "p-b", user: "u-b", status: "queued", docs: 2, pages: 20 });
    const a1 = await summary.getOrgActivitySummary("org-a", () => now);
    const b1 = await summary.getOrgActivitySummary("org-b", () => now);
    expect(a1.queued.pages).toBe(10);
    expect(b1.queued.pages).toBe(20);
    // Within the TTL the cached value is reused...
    await addRun("a-queue-2", { org: "org-a", project: "p-a", user: "u-a", status: "queued", docs: 1, pages: 5 });
    expect((await summary.getOrgActivitySummary("org-a", () => now)).queued.pages).toBe(10);
    // ... and after it, recomputed.
    now += summary.ACTIVITY_SUMMARY_TTL_MS + 1;
    expect((await summary.getOrgActivitySummary("org-a", () => now)).queued.pages).toBe(15);
    expect((await summary.getOrgActivitySummary("org-b", () => now)).queued.pages).toBe(20);
  });

  it("resolves a session user's own organization and none for a user without one", async () => {
    expect(await summary.activitySummaryOrgIdForUser("u-a")).toBe("org-a");
    expect(await summary.activitySummaryOrgIdForUser("u-b")).toBe("org-b");
    expect(await summary.activitySummaryOrgIdForUser("u-none")).toBeNull();
  });
});

describe("upload session progress", () => {
  const loaded = (overrides: Record<string, unknown> = {}) => ({
    session: { id: "sess-a", user_id: "u-a", org_id: "org-a", status: "confirmed", project_id: "p-a", project_name: null, template_key: null, pipeline: null, ...overrides },
    files: [
      { id: "f1", session_id: "sess-a", filename: "a.pdf", mime_type: "application/pdf", size_bytes: 100, source_key: "k1", upload_mode: "single", upload_id: null, part_size: null, status: "completed", completed_parts: null },
      { id: "f2", session_id: "sess-a", filename: "b.pdf", mime_type: "application/pdf", size_bytes: 300, source_key: "k2", upload_mode: "single", upload_id: null, part_size: null, status: "pending", completed_parts: null },
    ],
  }) as never;

  it("reports files, bytes and the session's own run with its rate and ETA", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await addRun("sess-a", { org: "org-a", project: "p-a", user: "u-a", status: "processing", docs: 2, docsDone: 1, pages: 200, pagesDone: 50, startedMinutesAgo: 5 });
    const progress = await sessions.directUploadSessionProgress(loaded());
    expect(progress.files).toEqual({ total: 2, completed: 1 });
    expect(progress.bytes).toEqual({ total: 400, completed: 100 });
    expect(progress.run).toMatchObject({ id: "sess-a", status: "processing", documents: { total: 2, processed: 1 }, pages: { total: 200, processed: 50 } });
    expect(progress.run?.pagesPerMinute).toBeCloseTo(10, 0);
    expect(progress.run?.eta).toMatchObject({ bucket: "15-60m", basis: "observed", estimate: false });
  });

  it("has no run before intake is confirmed", async () => {
    await addRun("sess-a", { org: "org-a", project: "p-a", user: "u-a", status: "processing", pages: 10, pagesDone: 1, startedMinutesAgo: 1 });
    expect((await sessions.directUploadSessionProgress(loaded({ status: "uploading" }))).run).toBeNull();
  });

  it("never reports a run of another organization or user under the session's id", async () => {
    await addRun("sess-a", { org: "org-b", project: "p-b", user: "u-b", status: "processing", pages: 10, pagesDone: 5, startedMinutesAgo: 1 });
    expect((await sessions.directUploadSessionProgress(loaded())).run).toBeNull();
    await sql`delete from project_runs`;
    await addRun("sess-a", { org: "org-a", project: "p-a", user: "u-b", status: "processing", pages: 10, pagesDone: 5, startedMinutesAgo: 1 });
    expect((await sessions.directUploadSessionProgress(loaded())).run).toBeNull();
    expect((await sessions.directUploadSessionProgress(loaded({ org_id: null }))).run).toBeNull();
  });
});
