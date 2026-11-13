import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/** Automatic project naming against a database built from db/migrations. */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let concurrent: postgres.Sql;
const raceDatabaseUrl = process.env.PROJECT_NAMING_RACE_DATABASE_URL;
let ws: typeof import("../services/projects.js");
let naming: typeof import("../services/project-naming.js");

beforeAll(async () => {
  // For the lock regression, point this at an isolated DB migrated with db/migrate.mjs.
  // PGlite serializes connections and cannot model PostgreSQL row-lock races.
  const database = raceDatabaseUrl ? null : await startMigratedPostgres();
  stop = database?.stop ?? (async () => {});
  sql = postgres(raceDatabaseUrl ?? database!.url, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "project-naming-race" } });
  if (raceDatabaseUrl) concurrent = postgres(raceDatabaseUrl, { max: 1, prepare: false });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'naming@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'naming', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  ws = await import("../services/projects.js");
  naming = await import("../services/project-naming.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await concurrent?.end();
  await stop?.();
});

async function state(projectId: string) {
  const [row] = await sql<{ name: string; auto_title: Record<string, string> | null }[]>`
    select w.name, s.compat_metadata -> 'autoTitle' as auto_title
    from projects w left join project_search_settings s on s.project_id = w.id
    where w.id = ${projectId}
  `;
  return { name: row!.name, autoTitle: row!.auto_title };
}

let documentCount = 0;
async function addDocument(projectId: string, filename: string) {
  const runId = `${projectId}-run`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values (${runId}, 'o', 'u', ${projectId}, 'bulk-upload', 'completed', 'completed', '{}') on conflict (id) do nothing`;
  const id = `${projectId}-doc-${++documentCount}`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, created_at)
    values (${id}, 'o', 'u', ${projectId}, ${runId}, ${filename}, 'application/pdf', ${id}, 'completed', now() + make_interval(secs => ${documentCount}))`;
  return { id, runId };
}

describe("automatic project naming", () => {
  it("creates a project without a chosen name as an auto-named placeholder", async () => {
    const omitted = await ws.createProject({ userId: "u", orgId: "o" });
    const placeholder = await ws.createProject({ userId: "u", orgId: "o", name: "Untitled project" });
    const named = await ws.createProject({ userId: "u", orgId: "o", name: "Contracts" });
    expect(omitted.name).toBe("Untitled project");
    expect(await state(omitted.id)).toEqual({ name: "Untitled project", autoTitle: { phase: "empty", name: "Untitled project" } });
    expect((await state(placeholder.id)).autoTitle).toEqual({ phase: "empty", name: "Untitled project" });
    expect((await state(named.id)).autoTitle).toBeNull();
  });

  it("moves forward from uploads to a heading, a summary and the first chat question, and then stops", async () => {
    const project = await ws.createProject({ userId: "u", orgId: "o", name: "" });

    const first = await addDocument(project.id, "lease_2026.pdf");
    expect(await naming.nameProjectFromUpload({ projectId: project.id, filenames: ["lease_2026.pdf"] })).toBe("Lease 2026");
    expect((await state(project.id)).autoTitle).toEqual({ phase: "upload", name: "Lease 2026" });

    // Later uploads re-derive the title from every file, not just the newest batch.
    await addDocument(project.id, "rider.pdf");
    expect(await naming.nameProjectFromUpload({ projectId: project.id, filenames: ["rider.pdf"] })).toBe("Lease 2026 + 1 more");
    // Same files, same title: no rename.
    expect(await naming.nameProjectFromUpload({ projectId: project.id, filenames: ["rider.pdf"] })).toBeNull();

    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, token_estimate, heading_path)
      values (${first.id + "-c0"}, ${first.id}, ${first.runId}, 'u', 0, 'Rent is due monthly.', 5, ${["Residential Lease"]})`;
    // Reads never rename; the maintenance sweep does, after ingest.
    await ws.getProject(project.id, "u");
    expect((await state(project.id)).name).toBe("Lease 2026 + 1 more");
    await naming.sweepProjectAutoTitles();
    expect(await state(project.id)).toEqual({ name: "Residential Lease", autoTitle: { phase: "content", name: "Residential Lease", source: "heading" } });

    // Uploads no longer rename once content has named the project.
    await addDocument(project.id, "invoice.pdf");
    expect(await naming.nameProjectFromUpload({ projectId: project.id, filenames: ["invoice.pdf"] })).toBeNull();

    // A stored summary outranks the heading, once.
    await sql`insert into document_summaries (id, document_id, run_id, user_id, summary)
      values (${first.id + "-summary"}, ${first.id}, ${first.runId}, 'u', 'This document is a residential lease agreement between Acme and Bob, covering rent and deposits.')`;
    await naming.refineProjectNames([project.id]);
    expect(await state(project.id)).toEqual({
      name: "Residential lease agreement between Acme and Bob",
      autoTitle: { phase: "content", name: "Residential lease agreement between Acme and Bob", source: "summary" },
    });
    await sql`update document_summaries set summary = 'This file describes a parking permit.' where id = ${first.id + "-summary"}`;
    await naming.refineProjectNames([project.id]);
    expect((await state(project.id)).name).toBe("Residential lease agreement between Acme and Bob");

    // A chat message cannot rename the project: refineProjectNames takes no message at all.
    expect(naming.refineProjectNames.length).toBe(1);
    await naming.refineProjectNames([project.id]);
    expect((await state(project.id)).name).toBe("Residential lease agreement between Acme and Bob");
  });

  it("names an untitled project from its first chunk heading when no upload named it", async () => {
    const project = await ws.createProject({ userId: "u", orgId: "o" });
    const doc = await addDocument(project.id, "scan.pdf");
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, token_estimate, heading_path)
      values (${doc.id + "-c0"}, ${doc.id}, ${doc.runId}, 'u', 0, 'Body.', 2, ${["Field Survey Notes"]})`;
    await ws.listProjects("u");
    expect((await state(project.id)).name).toBe("Untitled project");
    await naming.sweepProjectAutoTitles();
    expect((await state(project.id)).name).toBe("Field Survey Notes");
  });

  it("sweeps the oldest pending corpus change first, with no lookback window and no starvation", async () => {
    await naming.sweepProjectAutoTitles();
    const pending = async () => (await sql<{ project_id: string }[]>`
      select project_id from project_corpus_stats where auto_title_checked_at is distinct from updated_at`).map((row) => row.project_id).sort();
    expect(await pending()).toEqual([]);

    // Three projects the sweep can do nothing for (manually named), changed more recently than the one it can.
    const stale = await ws.createProject({ userId: "u", orgId: "o" });
    const doc = await addDocument(stale.id, "scan.pdf");
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, token_estimate, heading_path)
      values (${doc.id + "-c0"}, ${doc.id}, ${doc.runId}, 'u', 0, 'Body.', 2, ${["Harbour Expansion Plan"]})`;
    // An outage far longer than the old 15-minute window.
    await sql`update project_corpus_stats set updated_at = now() - interval '3 days' where project_id = ${stale.id}`;
    const manual: string[] = [];
    for (const name of ["Manual one", "Manual two", "Manual three"]) {
      const project = await ws.createProject({ userId: "u", orgId: "o", name });
      await addDocument(project.id, "file.pdf");
      manual.push(project.id);
    }
    expect(await pending()).toEqual([stale.id, ...manual].sort());

    // One page of one: the oldest change, not the newest.
    expect(await naming.sweepProjectAutoTitles({ batchSize: 1, maxBatches: 1 })).toBe(1);
    expect((await state(stale.id)).name).toBe("Harbour Expansion Plan");
    expect(await pending()).toEqual([...manual].sort());
    // Projects with nothing to rename are examined once and leave the queue.
    expect(await naming.sweepProjectAutoTitles({ batchSize: 2 })).toBe(3);
    expect(await pending()).toEqual([]);
    expect(await naming.sweepProjectAutoTitles()).toBe(0);

    // A later corpus change makes the project pending again; the summary then outranks the heading.
    await sql`insert into document_summaries (id, document_id, run_id, user_id, summary)
      values (${doc.id + "-summary"}, ${doc.id}, ${doc.runId}, 'u', 'This document is a harbour expansion budget for 2027, covering new berths.')`;
    await addDocument(stale.id, "appendix.pdf");
    expect(await pending()).toEqual([stale.id]);
    expect(await naming.sweepProjectAutoTitles()).toBe(1);
    expect((await state(stale.id)).name).toBe("Harbour expansion budget for 2027");
  });

  it("stops automatic naming after a manual rename", async () => {
    const project = await ws.createProject({ userId: "u", orgId: "o" });
    await ws.updateProject(project.id, "u", { name: "My leases" });
    await addDocument(project.id, "lease.pdf");
    expect(await naming.nameProjectFromUpload({ projectId: project.id, filenames: ["lease.pdf"] })).toBeNull();
    await naming.refineProjectNames([project.id]);
    expect((await state(project.id)).name).toBe("My leases");
  });
});

it.skipIf(!raceDatabaseUrl).each(["changed", "same"])("does not overwrite a concurrent manual rename (%s candidate)", async (candidate) => {
  const project = await ws.createProject({ userId: "u", orgId: "o" });
  const before = await state(project.id);
  const connection = await concurrent.reserve();
  let automatic: Promise<unknown> | undefined;
  try {
    await connection`begin`;
    await connection`update projects set name = 'Manual confidential title' where id = ${project.id}`;
    // The initial SELECT sees the old committed name. applyAutoTitle must wait
    // for this transaction, then reject the stale expected name in the UPDATE.
    automatic = naming.nameProjectFromUpload({ projectId: project.id, filenames: [candidate === "same" ? `${before.name}.pdf` : "Annual budget review.pdf"] });
    const deadline = Date.now() + 10_000;
    for (;;) {
      // pg_stat_activity is cached within a transaction until explicitly cleared.
      await connection`select pg_stat_clear_snapshot()`;
      const [row] = await connection`select exists (
        select 1 from pg_stat_activity where application_name = 'project-naming-race'
          and wait_event_type = 'Lock' and query like '%update projects%'
      ) as waiting`;
      if (row!.waiting) break;
      if (Date.now() > deadline) throw new Error("Automatic title UPDATE never reached the row-lock barrier");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await connection`commit`;
    await automatic;
    expect(await state(project.id)).toEqual({ name: "Manual confidential title", autoTitle: before.autoTitle });
  } finally {
    await connection`rollback`;
    connection.release();
    await automatic;
  }
}, 15_000);

it.each(["superseded", "archived", "purged", "failed", "cancelled", "pii_blocked", "queued", "processing"])("excludes %s documents from all naming sources", async (excluded) => {
  const project = await ws.createProject({ userId: "u", orgId: "o" });
  const secret = await addDocument(project.id, "secret_merger.pdf");
  await sql`update documents set
    superseded_at = ${excluded === "superseded" ? new Date() : null},
    archived_at = ${excluded === "archived" ? new Date() : null},
    purged_at = ${excluded === "purged" ? new Date() : null},
    status = ${["failed", "cancelled", "pii_blocked", "queued", "processing"].includes(excluded) ? excluded : "completed"},
    metadata = '{"title":"Secret extracted title","mapTitle":"Secret mapped title"}'
    where id = ${secret.id}`;
  await sql`insert into document_summaries (id, document_id, run_id, user_id, summary)
    values (${secret.id + "-s"}, ${secret.id}, ${secret.runId}, 'u', 'This document describes a secret merger transaction.')`;
  await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, token_estimate, heading_path)
    values (${secret.id + "-c"}, ${secret.id}, ${secret.runId}, 'u', 0, 'Secret body', 2, ${["Secret heading"]})`;
  // Summary, extracted title, chunk heading and map title must all be excluded.
  await naming.refineProjectNames([project.id]);
  expect((await state(project.id)).name).toBe("Untitled project");
  await naming.nameProjectFromUpload({ projectId: project.id, filenames: ["public.pdf"] });
  await addDocument(project.id, "public.pdf");
  await naming.nameProjectFromUpload({ projectId: project.id, filenames: ["public.pdf"] });
  expect((await state(project.id)).name).toBe("Public");
});
