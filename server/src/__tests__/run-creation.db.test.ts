import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let creation: typeof import("../services/run-creation.js");
let runCreation: ReturnType<typeof import("../services/run-creation.js").createRunCreation>;
const start = vi.fn();
let runs: typeof import("../services/runs.js");
let source: typeof import("../services/source-metadata.js");
let recovery: ReturnType<typeof import("../services/run-start-recovery.js").createRunStartRecovery>;
let lifecycle: ReturnType<typeof import("../services/run-lifecycle.js").createRunLifecycle>;
const prepare = vi.fn();
const startWorkflow = vi.fn(async () => {});
const files = ["a.pdf", "b.pdf"].map((filename) => ({ filename, mimeType: "application/pdf", sourceKey: `u/raw/${filename}` }));
const input = {
  userId: "u", workspaceId: "w", kind: "bulk-upload", pipeline: defaultPipelineFeatures,
  sources: { kind: "files" as const, files },
};

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/source-metadata.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../services/source-metadata.js")>(),
    resolveSourceMetadata: prepare,
  }));
  vi.doMock("../lib/temporal.js", () => ({
    startPipelineWorkflow: startWorkflow, signalPipelineCancel: vi.fn(), signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(),
    isTemporalClientConnected: () => true, onTemporalClientConnected: vi.fn(), warmTemporalClient: vi.fn(),
  }));
  creation = await import("../services/run-creation.js");
  runCreation = creation.createRunCreation({ sql, start });
  runs = await import("../services/runs.js");
  source = await import("../services/source-metadata.js");
  const { createRunLifecycle } = await import("../services/run-lifecycle.js");
  const { createRunStartRecovery } = await import("../services/run-start-recovery.js");
  lifecycle = createRunLifecycle({ sql, startWorkflow, failureThreshold: 3 });
  recovery = createRunStartRecovery({ sql, lifecycle, config: { batchSize: 25, leaseMs: 30_000 } });
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents) values ('o', 'O', 'o', 'u', 1000)`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'W')`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(async () => {
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
  await sql`delete from document_cleanup_queue`;
  await sql`delete from storage_cleanup_queue`;
  startWorkflow.mockClear();
  start.mockReset().mockResolvedValue({ status: "started" });
  prepare.mockReset().mockResolvedValue({ pageCount: 3, sourceSha256: "abc" });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function pendingRun() {
  const [row] = await sql<{ id: string; total_documents: number; creation_ready_at: Date | null }[]>`select * from workspace_runs`;
  return row!;
}

async function expire(runId: string) {
  await sql`update workspace_runs set creation_expires_at = now() - interval '1 second' where id = ${runId}`;
}

describe("Run creation and recovery together", () => {
  it("keeps a slow, partially inserted Run private even past the former recovery grace, then publishes it", async () => {
    const entered = gate();
    const resume = gate();
    prepare.mockImplementationOnce(async () => ({ pageCount: 3, sourceSha256: "first" }))
      .mockImplementationOnce(async () => { entered.release(); await resume.promise; return { pageCount: 5, sourceSha256: "second" }; });
    const creating = runCreation.create(input);
    await entered.promise;
    try {
      const run = await pendingRun();
      expect(await sql`select creation_source_keys from workspace_runs`).toEqual([{ creation_source_keys: files.map((file) => file.sourceKey) }]);
      await sql`update workspace_runs set created_at = now() - interval '1 hour' where id = ${run.id}`;
      expect(await sql`select count(*)::int as n from documents`).toEqual([{ n: 1 }]);
      expect(await recovery.sweepOnce({ ignoreBackoff: true })).toMatchObject({ claimed: 0 });
      const { sweepStaleQueuedRuns } = await import("../services/stale-queued-runs.js");
      await sweepStaleQueuedRuns();
      expect(await lifecycle.start({ id: run.id, pipeline: defaultPipelineFeatures })).toMatchObject({ status: "deferred" });
      expect(startWorkflow).not.toHaveBeenCalled();
    } finally { resume.release(); }
    const result = await creating;
    expect(result.run).toMatchObject({ totalDocuments: 2, pagesTotal: 8 });
    expect(await sql`select total_documents, pages_total, creation_ready_at is not null as ready, creation_expires_at from workspace_runs`)
      .toEqual([{ total_documents: 2, pages_total: 8, ready: true, creation_expires_at: null }]);
    expect(await recovery.sweepOnce()).toMatchObject({ started: 1 });
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(await creation.discardUnstartedRun(result.run.id)).toBe(false);
  });

  it("starts a newly published Run immediately without an elapsed-time readiness assumption", async () => {
    const result = await runCreation.create(input);
    expect((await pendingRun()).id).toBe(result.run.id);
    expect(await recovery.sweepOnce()).toMatchObject({ started: 1 });
  });

  it("removes partial Documents and queues source cleanup when later preparation fails", async () => {
    const failure = new Error("source preparation failed");
    prepare.mockResolvedValueOnce({ pageCount: 3, sourceSha256: "first" }).mockRejectedValueOnce(failure);
    await expect(runCreation.create(input)).rejects.toBe(failure);
    expect(await sql`select id from workspace_runs`).toEqual([]);
    expect(await sql`select id from documents`).toEqual([]);
    expect(await sql`select source_key, delete_source from document_cleanup_queue`).toEqual([{ source_key: "u/raw/a.pdf", delete_source: true }]);
    expect(await recovery.sweepOnce()).toMatchObject({ claimed: 0 });
  });

  it("publishes final totals without the unreadable sources", async () => {
    prepare.mockResolvedValueOnce({ pageCount: 3, sourceSha256: "first" })
      .mockRejectedValueOnce(new source.UnreadableSourceError("b.pdf", "bad PDF"));
    const result = await runCreation.create(input);
    expect(result.run).toMatchObject({ totalDocuments: 1, pagesTotal: 3 });
    expect(result.unreadable).toHaveLength(1);
    expect(await recovery.sweepOnce()).toMatchObject({ started: 1 });
  });

  it("discards a Run if every source is unreadable", async () => {
    prepare.mockRejectedValue(new source.UnreadableSourceError("bad.pdf", "bad PDF"));
    await expect(runCreation.create(input)).rejects.toBeInstanceOf(source.AllSourcesUnreadableError);
    expect(await sql`select id from workspace_runs`).toEqual([]);
  });

  it("cleans interrupted creation on recovery and fences a delayed creator that resumes afterwards", async () => {
    // Pausing source preparation after one committed Document models a lost
    // process without executing its catch/finally. Recovery must discard, never start.
    const entered = gate();
    const resume = gate();
    prepare.mockResolvedValueOnce({ pageCount: 3, sourceSha256: "first" })
      .mockImplementationOnce(async () => { entered.release(); await resume.promise; return { pageCount: 5, sourceSha256: "second" }; });
    const creating = runCreation.create(input);
    const rejected = expect(creating).rejects.toThrow("no longer being created");
    await entered.promise;
    try {
      const run = await pendingRun();
      await expire(run.id);
      expect(await recovery.sweepOnce()).toMatchObject({ claimed: 0 });
      expect(await sql`select id from workspace_runs`).toEqual([]);
      expect(await sql`select id from documents`).toEqual([]);
      expect(await sql`select source_key from document_cleanup_queue`).toEqual([{ source_key: "u/raw/a.pdf" }]);
      expect(await sql`select artifact_uris from storage_cleanup_queue`).toEqual([{ artifact_uris: expect.arrayContaining(["u/raw/a.pdf", "u/raw/b.pdf"]) }]);
      expect(startWorkflow).not.toHaveBeenCalled();
    } finally { resume.release(); }
    await rejected;
    expect(await sql`select id from documents`).toEqual([]);
  });

  it("cleans abandoned creation even if every Document was inserted but publication never committed", async () => {
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents, creation_source_keys, creation_expires_at)
      values ('half', 'o', 'u', 'w', 'bulk-upload', 'queued', 'queued', 1, ${["u/raw/a.pdf"]}, now() - interval '1 second')`;
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('half-doc', 'o', 'u', 'w', 'half', 'a.pdf', 'application/pdf', 'u/raw/a.pdf', 'queued', 3)`;
    expect(await recovery.sweepOnce()).toMatchObject({ claimed: 0 });
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(await sql`select id from workspace_runs`).toEqual([]);
  });

  it("renews the creation lease while source preparation is waiting", async () => {
    const entered = gate();
    const resume = gate();
    prepare.mockImplementationOnce(async () => { entered.release(); await resume.promise; return { pageCount: 3, sourceSha256: "first" }; });
    const creating = creation.createRunCreation({ sql, start, heartbeatMs: 10 })
      .create({ ...input, sources: { kind: "files", files: files.slice(0, 1) } });
    await entered.promise;
    try {
      await expire((await pendingRun()).id);
      await vi.waitFor(async () => {
        expect(await sql`select creation_expires_at > now() as live from workspace_runs`).toEqual([{ live: true }]);
      });
      expect(await creation.sweepInterruptedRunCreations(sql)).toBe(0);
    } finally { resume.release(); }
    await expect(creating).resolves.toMatchObject({ run: { totalDocuments: 1 } });
  });
});

async function sourceRun() {
  const created = await runCreation.create(input);
  start.mockClear();
  return created;
}

describe("Run creation starts or defers every Run", () => {
  it("starts a published Run created from files and returns the true counts", async () => {
    const result = await runCreation.create(input);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toMatchObject({ id: result.run.id });
    expect(result).toMatchObject({ deferredReason: null, unreadable: [], run: { totalDocuments: 2, pagesTotal: 6, userId: "u" } });
    expect(new Date(result.run.createdAt).toISOString()).toBe(result.run.createdAt);
    expect(result.documents).toHaveLength(2);
    expect(await sql`select creation_ready_at is not null as ready from workspace_runs`).toEqual([{ ready: true }]);
  });

  it("starts a Run created as new versions of existing Documents", async () => {
    const original = await sourceRun();
    const result = await runCreation.create({
      ...input, sources: { kind: "versionsOf", documentIds: original.documents.map((doc) => doc.id) },
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(result.deferredReason).toBeNull();
    expect(result.documents.map((doc) => doc.versionNumber)).toEqual([2, 2]);
    expect(result.run).toMatchObject({ totalDocuments: 2, pagesTotal: 6 });
  });

  it("reports a deferred start as deferredReason", async () => {
    start.mockResolvedValueOnce({ status: "deferred", reason: "Temporal is down" });
    const result = await runCreation.create(input);
    expect(result.deferredReason).toBe("Temporal is down");
    expect(await sql`select workflow_started_at from workspace_runs`).toEqual([{ workflow_started_at: null }]);
  });

  it("downgrades a start error to deferred instead of throwing, leaving the Run for recovery", async () => {
    start.mockRejectedValueOnce(new Error("workflow service exploded"));
    const result = await runCreation.create(input);
    expect(result.deferredReason).toBe(creation.RUN_START_FAILED_DEFERRED_MESSAGE);
    expect(await sql`select creation_ready_at is not null as ready from workspace_runs`).toEqual([{ ready: true }]);
    expect(await recovery.sweepOnce()).toMatchObject({ started: 1 });
  });
});

describe("Run creation versions Documents by lineage", () => {
  it("bases a new version on the latest in the canonical lineage, whichever version was selected", async () => {
    const original = await sourceRun();
    const ids = original.documents.map((doc) => doc.id);
    const second = await runCreation.create({ ...input, sources: { kind: "versionsOf", documentIds: ids } });
    // Reprocess the first Run again: its Documents are v1, but the lineage already holds v2.
    const third = await runCreation.create({ ...input, sources: { kind: "versionsOf", documentIds: ids } });
    expect(third.documents.map((doc) => doc.versionNumber)).toEqual([3, 3]);
    const secondById = new Map(second.documents.map((doc) => [doc.canonicalId, doc.id]));
    expect(third.documents.map((doc) => doc.previousVersionId)).toEqual(third.documents.map((doc) => secondById.get(doc.canonicalId)));
    expect(third.documents.every((doc) => doc.canonicalId?.startsWith("path:"))).toBe(true);
  });

  it("carries the source's size, pages, hash, mime type and source key to the new version", async () => {
    const original = await runCreation.create({
      ...input, sources: { kind: "files", files: [{ ...files[0]!, fileSize: 4321, metadata: { author: "Ada" } }] },
    });
    await runCreation.create({ ...input, sources: { kind: "versionsOf", documentIds: [original.documents[0]!.id] } });
    const [row] = await sql<Record<string, unknown>[]>`select page_count, file_size, source_sha256, mime_type, source_key, extraction_mode, metadata
      from documents where version_number = 2`;
    expect({ ...row, file_size: Number(row!.file_size) }).toEqual({
      page_count: 3, file_size: 4321, source_sha256: "abc", mime_type: "application/pdf",
      source_key: "u/raw/a.pdf", extraction_mode: "hybrid",
      metadata: { author: "Ada", sourceSizeMeasured: true },
    });
  });

  it("marks reused sources only for reusing (partial) runs", async () => {
    const original = await sourceRun();
    const ids = original.documents.map((doc) => doc.id);
    const result = await runCreation.create({ ...input, sources: { kind: "versionsOf", documentIds: ids, reuse: true } });
    const reused = await sql<{ id: string; reused_from_document_id: string }[]>`select id, reused_from_document_id from documents where run_id = ${result.run.id}`;
    expect(reused.map((row) => row.reused_from_document_id).sort()).toEqual([...ids].sort());
  });

  it("makes the requester the owner of the Run, not the original uploader", async () => {
    await sql`insert into "user" (id, name, email) values ('m', 'M', 'm@example.test')`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'm', 'admin')`;
    const original = await sourceRun();
    const result = await runCreation.create({
      ...input, userId: "m", sources: { kind: "versionsOf", documentIds: original.documents.map((doc) => doc.id) },
    });
    expect(result.run.userId).toBe("m");
    expect(await sql`select distinct user_id from documents where run_id = ${result.run.id}`).toEqual([{ user_id: "m" }]);
  });

  it("refuses a requester without access before creating anything", async () => {
    await sql`insert into "user" (id, name, email) values ('x', 'X', 'x@example.test')`;
    await expect(runCreation.create({ ...input, userId: "x" })).rejects.toThrow(/Workspace not found|Forbidden/);
    expect(await sql`select id from workspace_runs`).toEqual([]);
  });

  it("throws when no source Document is in the workspace, without creating a Run", async () => {
    await expect(runCreation.create({ ...input, sources: { kind: "versionsOf", documentIds: ["nope"] } })).rejects.toThrow("No documents");
    expect(await sql`select id from workspace_runs`).toEqual([]);
  });
});

describe("Run creation reuses completed outputs for exact-source duplicates", () => {
  it("links a new Document to a completed Document with the same source hash, and not otherwise", async () => {
    const first = await runCreation.create({ ...input, sources: { kind: "files", files: files.slice(0, 1) } });
    await sql`update workspace_runs set status = 'completed' where id = ${first.run.id}`;
    await sql`update documents set status = 'completed' where run_id = ${first.run.id}`;

    const duplicate = await runCreation.create({ ...input, sources: { kind: "files", files: [{ ...files[1]!, filename: "copy.pdf" }] } });
    expect(duplicate.documents[0]).toMatchObject({ dedupedFromDocumentId: first.documents[0]!.id, dedupScope: "workspace", sourceSha256: "abc" });

    prepare.mockResolvedValueOnce({ pageCount: 1, sourceSha256: "different" });
    const fresh = await runCreation.create({ ...input, sources: { kind: "files", files: [{ ...files[1]!, filename: "fresh.pdf" }] } });
    expect(fresh.documents[0]).toMatchObject({ dedupedFromDocumentId: null, dedupScope: null });
  });
});

describe("Dedup copies and per-workspace LanceDB databases", () => {
  it("shares the source's vectors only inside its workspace and leaves indexing to the worker elsewhere", async () => {
    await sql`insert into workspaces (id, org_id, user_id, name) values ('w-dedup', 'o', 'u', 'W dedup') on conflict do nothing`;
    const first = await runCreation.create({ ...input, sources: { kind: "files", files: files.slice(0, 1) } });
    const source = first.documents[0]!.id;
    await sql`update workspace_runs set status = 'completed' where id = ${first.run.id}`;
    await sql`update documents set status = 'completed' where run_id = ${first.run.id}`;
    for (const stage of ["embed", "index"]) {
      await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, artifact_uri)
        values (${first.run.id}, ${source}, ${stage}, 'completed', ${`s3://b/u/${first.run.id}/${stage}/${source}.json`})`;
    }
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text)
      values (${`${source}-000`}, ${source}, ${first.run.id}, 'u', 0, 'hello')`;
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
      values ('vi-source', ${source}, 'lancedb', 'b', 'p', 'm', 4)`;

    const seeded = async (documentId: string) => ({
      stages: (await sql<{ stage_name: string }[]>`select stage_name from document_run_stage_states where document_id = ${documentId} order by stage_name`).map((row) => row.stage_name),
      chunks: (await sql<{ id: string }[]>`select id from document_chunks where document_id = ${documentId}`).map((row) => row.id),
      vectorIndexes: (await sql<{ count: number }[]>`select count(*)::int as count from vector_indexes where document_id = ${documentId}`)[0]!.count,
    });

    const sameWorkspace = (await runCreation.create({ ...input, sources: { kind: "files", files: [{ ...files[1]!, filename: "copy.pdf" }] } })).documents[0]!;
    expect(sameWorkspace).toMatchObject({ dedupedFromDocumentId: source, dedupScope: "workspace" });
    expect(await seeded(sameWorkspace.id)).toEqual({ stages: ["embed", "index"], chunks: [`${sameWorkspace.id}-000`], vectorIndexes: 1 });

    const otherWorkspace = (await runCreation.create({ ...input, workspaceId: "w-dedup", sources: { kind: "files", files: [{ ...files[1]!, filename: "copy.pdf" }] } })).documents[0]!;
    expect(otherWorkspace).toMatchObject({ dedupedFromDocumentId: source, dedupScope: "org" });
    // No index checkpoint or vector index: the worker writes the copy's own rows into w-dedup's database.
    expect(await seeded(otherWorkspace.id)).toEqual({ stages: ["embed"], chunks: [`${otherWorkspace.id}-000`], vectorIndexes: 0 });
  });
});

describe("Run creation admits spend the same way for every source", () => {
  const floor = process.env.MIN_CREDIT_BALANCE_CENTS;
  afterEach(() => { if (floor === undefined) delete process.env.MIN_CREDIT_BALANCE_CENTS; else process.env.MIN_CREDIT_BALANCE_CENTS = floor; });

  it("applies the minimum credit floor to files and to new versions, creating nothing", async () => {
    const original = await sourceRun();
    process.env.MIN_CREDIT_BALANCE_CENTS = "100000";
    const before = await sql`select id from workspace_runs`;
    await expect(runCreation.create(input)).rejects.toMatchObject({ statusCode: 402, code: "minimum_credit_required" });
    await expect(runCreation.create({
      ...input, sources: { kind: "versionsOf", documentIds: original.documents.map((doc) => doc.id) },
    })).rejects.toMatchObject({ statusCode: 402, code: "minimum_credit_required" });
    expect(await sql`select id from workspace_runs`).toEqual(before);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("Run reprocessing and bulk reprocessing through Run creation", () => {
  it("starts both a Run reprocess and a bulk reprocess, publishing true totals", async () => {
    const original = await runCreation.create(input);
    const reprocessed = await runs.reprocessRun(original.run.id, "u");
    const { bulkReprocessDocuments } = await import("../services/documents.js");
    const bulk = await bulkReprocessDocuments(original.documents.map((doc) => doc.id), "u");
    expect(reprocessed?.deferredReason).toBeNull();
    expect(bulk).toMatchObject({ runs: [expect.anything()], failed: [], warnings: [] });
    expect(await sql`select total_documents, pages_total, creation_ready_at is not null as ready, creation_source_keys from workspace_runs`)
      .toEqual(Array.from({ length: 3 }, () => ({ total_documents: 2, pages_total: 6, ready: true, creation_source_keys: [] })));
    expect(startWorkflow).toHaveBeenCalledTimes(2);
  });

  it("keeps going past a failed bulk group and throws only when every group failed", async () => {
    await sql`insert into workspaces (id, org_id, user_id, name) values ('w2', 'o', 'u', 'W2')`;
    const a = await runCreation.create(input);
    const b = await runCreation.create({ ...input, workspaceId: "w2" });
    const { bulkReprocessDocuments } = await import("../services/documents.js");
    const ids = [...a.documents, ...b.documents].map((doc) => doc.id);
    // Block exactly the second group's workspace.
    await sql`update workspaces set budget_paused = false`;
    const spy = vi.spyOn(creation.runCreation, "create");
    spy.mockImplementationOnce(async (arg) => runCreation.create(arg))
      .mockImplementationOnce(async () => { throw Object.assign(new Error("group blocked"), { code: "credit_exhausted" }); });
    const partial = await bulkReprocessDocuments(ids, "u");
    expect(partial.runs).toHaveLength(1);
    expect(partial.failed).toEqual([{ workspaceId: expect.any(String), documentIds: expect.any(Array), message: "group blocked", code: "credit_exhausted" }]);
    expect(partial.warnings[0]).toContain("not reprocessed: group blocked");
    spy.mockImplementation(async () => { throw Object.assign(new Error("all blocked"), { code: "credit_exhausted" }); });
    await expect(bulkReprocessDocuments(ids, "u")).rejects.toThrow("all blocked");
    spy.mockRestore();
  });
});


it("stores upload tags atomically and retains them on reprocessing", async () => {
  const original = await runCreation.create({ ...input, sources: { kind: "files", files: [{ ...files[0]!, tags: ["finance", "FY26"] }] } });
  const originalId = original.documents[0]!.id;
  const tags = await sql`select tag from document_tags where document_id = ${originalId} order by tag`;
  expect(tags.map((row) => row.tag)).toEqual(["FY26", "finance"]);
  const reprocessed = await runCreation.create({ ...input, sources: { kind: "versionsOf", documentIds: [originalId] } });
  const copied = await sql`select tag from document_tags where document_id = ${reprocessed.documents[0]!.id} order by tag`;
  expect(copied.map((row) => row.tag)).toEqual(["FY26", "finance"]);
});
