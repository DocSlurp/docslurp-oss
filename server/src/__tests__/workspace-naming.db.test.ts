import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/** Automatic workspace naming against a database built from db/migrations. */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let concurrent: postgres.Sql;
const raceDatabaseUrl = process.env.WORKSPACE_NAMING_RACE_DATABASE_URL;
let ws: typeof import("../services/workspaces.js");
let naming: typeof import("../services/workspace-naming.js");

beforeAll(async () => {
  // For the lock regression, point this at an isolated DB migrated with db/migrate.mjs.
  // PGlite serializes connections and cannot model PostgreSQL row-lock races.
  const database = raceDatabaseUrl ? null : await startMigratedPostgres();
  stop = database?.stop ?? (async () => {});
  sql = postgres(raceDatabaseUrl ?? database!.url, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "workspace-naming-race" } });
  if (raceDatabaseUrl) concurrent = postgres(raceDatabaseUrl, { max: 1, prepare: false });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'naming@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'naming', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  ws = await import("../services/workspaces.js");
  naming = await import("../services/workspace-naming.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await concurrent?.end();
  await stop?.();
});

async function state(workspaceId: string) {
  const [row] = await sql<{ name: string; auto_title: Record<string, string> | null }[]>`
    select w.name, s.compat_metadata -> 'autoTitle' as auto_title
    from workspaces w left join workspace_search_settings s on s.workspace_id = w.id
    where w.id = ${workspaceId}
  `;
  return { name: row!.name, autoTitle: row!.auto_title };
}

let documentCount = 0;
async function addDocument(workspaceId: string, filename: string) {
  const runId = `${workspaceId}-run`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values (${runId}, 'o', 'u', ${workspaceId}, 'bulk-upload', 'completed', 'completed', '{}') on conflict (id) do nothing`;
  const id = `${workspaceId}-doc-${++documentCount}`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, created_at)
    values (${id}, 'o', 'u', ${workspaceId}, ${runId}, ${filename}, 'application/pdf', ${id}, 'completed', now() + make_interval(secs => ${documentCount}))`;
  return { id, runId };
}

describe("automatic workspace naming", () => {
  it("creates a workspace without a chosen name as an auto-named placeholder", async () => {
    const omitted = await ws.createWorkspace({ userId: "u", orgId: "o" });
    const placeholder = await ws.createWorkspace({ userId: "u", orgId: "o", name: "Untitled workspace" });
    const named = await ws.createWorkspace({ userId: "u", orgId: "o", name: "Contracts" });
    expect(omitted.name).toBe("Untitled workspace");
    expect(await state(omitted.id)).toEqual({ name: "Untitled workspace", autoTitle: { phase: "empty", name: "Untitled workspace" } });
    expect((await state(placeholder.id)).autoTitle).toEqual({ phase: "empty", name: "Untitled workspace" });
    expect((await state(named.id)).autoTitle).toBeNull();
  });

  it("moves forward from uploads to a heading, a summary and the first chat question, and then stops", async () => {
    const workspace = await ws.createWorkspace({ userId: "u", orgId: "o", name: "" });

    const first = await addDocument(workspace.id, "lease_2026.pdf");
    expect(await naming.nameWorkspaceFromUpload({ workspaceId: workspace.id, filenames: ["lease_2026.pdf"] })).toBe("Lease 2026");
    expect((await state(workspace.id)).autoTitle).toEqual({ phase: "upload", name: "Lease 2026" });

    // Later uploads re-derive the title from every file, not just the newest batch.
    await addDocument(workspace.id, "rider.pdf");
    expect(await naming.nameWorkspaceFromUpload({ workspaceId: workspace.id, filenames: ["rider.pdf"] })).toBe("Lease 2026 + 1 more");
    // Same files, same title: no rename.
    expect(await naming.nameWorkspaceFromUpload({ workspaceId: workspace.id, filenames: ["rider.pdf"] })).toBeNull();

    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, token_estimate, heading_path)
      values (${first.id + "-c0"}, ${first.id}, ${first.runId}, 'u', 0, 'Rent is due monthly.', 5, ${["Residential Lease"]})`;
    await ws.getWorkspace(workspace.id, "u");
    expect(await state(workspace.id)).toEqual({ name: "Residential Lease", autoTitle: { phase: "content", name: "Residential Lease", source: "heading" } });

    // Uploads no longer rename once content has named the workspace.
    await addDocument(workspace.id, "invoice.pdf");
    expect(await naming.nameWorkspaceFromUpload({ workspaceId: workspace.id, filenames: ["invoice.pdf"] })).toBeNull();

    // A stored summary outranks the heading, once.
    await sql`insert into document_summaries (id, document_id, run_id, user_id, summary)
      values (${first.id + "-summary"}, ${first.id}, ${first.runId}, 'u', 'This document is a residential lease agreement between Acme and Bob, covering rent and deposits.')`;
    await naming.refineWorkspaceNames([workspace.id]);
    expect(await state(workspace.id)).toEqual({
      name: "Residential lease agreement between Acme and Bob",
      autoTitle: { phase: "content", name: "Residential lease agreement between Acme and Bob", source: "summary" },
    });
    await sql`update document_summaries set summary = 'This file describes a parking permit.' where id = ${first.id + "-summary"}`;
    await naming.refineWorkspaceNames([workspace.id]);
    expect((await state(workspace.id)).name).toBe("Residential lease agreement between Acme and Bob");

    await naming.refineWorkspaceNames([workspace.id], "What is the security deposit?");
    expect(await state(workspace.id)).toEqual({ name: "What is the security deposit", autoTitle: { phase: "chat", name: "What is the security deposit" } });
    await naming.refineWorkspaceNames([workspace.id], "When is rent due?");
    await naming.refineWorkspaceNames([workspace.id]);
    expect((await state(workspace.id)).name).toBe("What is the security deposit");
  });

  it("names an untitled workspace from its first chunk heading when no upload named it", async () => {
    const workspace = await ws.createWorkspace({ userId: "u", orgId: "o" });
    const doc = await addDocument(workspace.id, "scan.pdf");
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, token_estimate, heading_path)
      values (${doc.id + "-c0"}, ${doc.id}, ${doc.runId}, 'u', 0, 'Body.', 2, ${["Field Survey Notes"]})`;
    await ws.listWorkspaces("u");
    expect((await state(workspace.id)).name).toBe("Field Survey Notes");
  });

  it("stops automatic naming after a manual rename", async () => {
    const workspace = await ws.createWorkspace({ userId: "u", orgId: "o" });
    await ws.updateWorkspace(workspace.id, "u", { name: "My leases" });
    await addDocument(workspace.id, "lease.pdf");
    expect(await naming.nameWorkspaceFromUpload({ workspaceId: workspace.id, filenames: ["lease.pdf"] })).toBeNull();
    await naming.refineWorkspaceNames([workspace.id], "What is the deposit?");
    expect((await state(workspace.id)).name).toBe("My leases");
  });
});

it.skipIf(!raceDatabaseUrl).each(["changed", "same"])("does not overwrite a concurrent manual rename (%s candidate)", async (candidate) => {
  const workspace = await ws.createWorkspace({ userId: "u", orgId: "o" });
  const before = await state(workspace.id);
  const connection = await concurrent.reserve();
  let automatic: Promise<unknown> | undefined;
  try {
    await connection`begin`;
    await connection`update workspaces set name = 'Manual confidential title' where id = ${workspace.id}`;
    // The initial SELECT sees the old committed name. applyAutoTitle must wait
    // for this transaction, then reject the stale expected name in the UPDATE.
    automatic = naming.refineWorkspaceNames([workspace.id], candidate === "same" ? "Untitled workspace" : "Annual budget review");
    const deadline = Date.now() + 10_000;
    for (;;) {
      // pg_stat_activity is cached within a transaction until explicitly cleared.
      await connection`select pg_stat_clear_snapshot()`;
      const [row] = await connection`select exists (
        select 1 from pg_stat_activity where application_name = 'workspace-naming-race'
          and wait_event_type = 'Lock' and query like '%update workspaces%'
      ) as waiting`;
      if (row!.waiting) break;
      if (Date.now() > deadline) throw new Error("Automatic title UPDATE never reached the row-lock barrier");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await connection`commit`;
    await automatic;
    expect(await state(workspace.id)).toEqual({ name: "Manual confidential title", autoTitle: before.autoTitle });
  } finally {
    await connection`rollback`;
    connection.release();
    await automatic;
  }
}, 15_000);

it("advances a same-name phase and leaves the workspace timestamp unchanged", async () => {
  const workspace = await ws.createWorkspace({ userId: "u", orgId: "o" });
  const [before] = await sql`select updated_at from workspaces where id = ${workspace.id}`;
  await naming.refineWorkspaceNames([workspace.id], "Untitled workspace");
  expect(await state(workspace.id)).toEqual({ name: "Untitled workspace", autoTitle: { phase: "chat", name: "Untitled workspace" } });
  const [after] = await sql`select updated_at from workspaces where id = ${workspace.id}`;
  expect(after!.updated_at).toEqual(before!.updated_at);
});

it.each(["superseded", "archived", "purged", "failed", "cancelled", "pii_blocked", "queued", "processing"])("excludes %s documents from all naming sources", async (excluded) => {
  const workspace = await ws.createWorkspace({ userId: "u", orgId: "o" });
  const secret = await addDocument(workspace.id, "secret_merger.pdf");
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
  await naming.refineWorkspaceNames([workspace.id]);
  expect((await state(workspace.id)).name).toBe("Untitled workspace");
  await naming.nameWorkspaceFromUpload({ workspaceId: workspace.id, filenames: ["public.pdf"] });
  await addDocument(workspace.id, "public.pdf");
  await naming.nameWorkspaceFromUpload({ workspaceId: workspace.id, filenames: ["public.pdf"] });
  expect((await state(workspace.id)).name).toBe("Public");
});
