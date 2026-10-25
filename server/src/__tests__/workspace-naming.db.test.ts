import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/** Automatic workspace naming against a database built from db/migrations. */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let ws: typeof import("../services/workspaces.js");
let naming: typeof import("../services/workspace-naming.js");

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'naming@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'naming', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  ws = await import("../services/workspaces.js");
  naming = await import("../services/workspace-naming.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
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
