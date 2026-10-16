import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let manifest: typeof import("../services/run-manifest.js");
let creation: typeof import("../services/run-creation.js");
let runs: typeof import("../services/runs.js");
let source: typeof import("../services/source-metadata.js");
let recovery: ReturnType<typeof import("../services/run-start-recovery.js").createRunStartRecovery>;
let lifecycle: ReturnType<typeof import("../services/run-lifecycle.js").createRunLifecycle>;
const prepare = vi.fn();
const startWorkflow = vi.fn(async () => {});
const input = {
  userId: "u", workspaceId: "w", kind: "bulk-upload", pipeline: defaultPipelineFeatures,
  files: ["a.pdf", "b.pdf"].map((filename) => ({ filename, mimeType: "application/pdf", sourceKey: `u/raw/${filename}` })),
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
  manifest = await import("../services/run-manifest.js");
  creation = await import("../services/run-creation.js");
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
    const creating = manifest.createRunManifest(input);
    await entered.promise;
    try {
      const run = await pendingRun();
      expect(await sql`select creation_source_keys from workspace_runs`).toEqual([{ creation_source_keys: input.files.map((file) => file.sourceKey) }]);
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
    const result = await manifest.createRunManifest(input);
    expect((await pendingRun()).id).toBe(result.run.id);
    expect(await recovery.sweepOnce()).toMatchObject({ started: 1 });
  });

  it("removes partial Documents and queues source cleanup when later preparation fails", async () => {
    const failure = new Error("source preparation failed");
    prepare.mockResolvedValueOnce({ pageCount: 3, sourceSha256: "first" }).mockRejectedValueOnce(failure);
    await expect(manifest.createRunManifest(input)).rejects.toBe(failure);
    expect(await sql`select id from workspace_runs`).toEqual([]);
    expect(await sql`select id from documents`).toEqual([]);
    expect(await sql`select source_key, delete_source from document_cleanup_queue`).toEqual([{ source_key: "u/raw/a.pdf", delete_source: true }]);
    expect(await recovery.sweepOnce()).toMatchObject({ claimed: 0 });
  });

  it("publishes final totals without the unreadable sources", async () => {
    prepare.mockResolvedValueOnce({ pageCount: 3, sourceSha256: "first" })
      .mockRejectedValueOnce(new source.UnreadableSourceError("b.pdf", "bad PDF"));
    const result = await manifest.createRunManifest(input);
    expect(result.run).toMatchObject({ totalDocuments: 1, pagesTotal: 3 });
    expect(result.unreadable).toHaveLength(1);
    expect(await recovery.sweepOnce()).toMatchObject({ started: 1 });
  });

  it("discards a Run if every source is unreadable", async () => {
    prepare.mockRejectedValue(new source.UnreadableSourceError("bad.pdf", "bad PDF"));
    await expect(manifest.createRunManifest(input)).rejects.toBeInstanceOf(source.AllSourcesUnreadableError);
    expect(await sql`select id from workspace_runs`).toEqual([]);
  });

  it("refuses publication with a missing Document and cleans up the partial manifest", async () => {
    const run = await runs.createRun({ ...input, totalDocuments: 2 });
    await expect(creation.completeRunCreation(run.id, async () => {
      await runs.createDocumentBatch({ ...input, runId: run.id, files: input.files.slice(0, 1) });
      return { value: undefined, totalDocuments: 2 };
    })).rejects.toThrow("incomplete manifest");
    expect(await sql`select id from workspace_runs`).toEqual([]);
  });

  it("cleans interrupted creation on recovery and fences a delayed creator that resumes afterwards", async () => {
    // Pausing source preparation after one committed Document models a lost
    // process without executing its catch/finally. Recovery must discard, never start.
    const entered = gate();
    const resume = gate();
    prepare.mockResolvedValueOnce({ pageCount: 3, sourceSha256: "first" })
      .mockImplementationOnce(async () => { entered.release(); await resume.promise; return { pageCount: 5, sourceSha256: "second" }; });
    const creating = manifest.createRunManifest(input);
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
    const run = await runs.createRun({ ...input, totalDocuments: 2 });
    await runs.createDocumentBatch({ ...input, runId: run.id });
    await expire(run.id);
    expect(await recovery.sweepOnce()).toMatchObject({ claimed: 0 });
    expect(startWorkflow).not.toHaveBeenCalled();
    expect(await sql`select id from workspace_runs`).toEqual([]);
  });

  it("publishes both Run reprocessing and bulk Document reprocessing", async () => {
    const original = await manifest.createRunManifest(input);
    const reprocessed = await runs.reprocessRun(original.run.id, "u");
    const { bulkReprocessDocuments } = await import("../services/documents.js");
    const bulk = await bulkReprocessDocuments(original.documents.map((doc) => doc.id), "u");
    expect(reprocessed).not.toBeNull();
    expect(bulk).toHaveLength(1);
    expect(await sql`select total_documents, pages_total, creation_ready_at is not null as ready, creation_source_keys from workspace_runs`)
      .toEqual(Array.from({ length: 3 }, () => ({ total_documents: 2, pages_total: 6, ready: true, creation_source_keys: [] })));
  });

  it("renews the creation lease while source preparation is waiting", async () => {
    const run = await runs.createRun({ ...input, totalDocuments: 1 });
    await expire(run.id);
    const resume = gate();
    const creating = creation.completeRunCreation(run.id, async () => {
      await resume.promise;
      await runs.createDocumentBatch({ ...input, runId: run.id, files: input.files.slice(0, 1) });
      return { value: "done", totalDocuments: 1 };
    }, { heartbeatMs: 10 });
    try {
      await vi.waitFor(async () => {
        expect(await sql`select creation_expires_at > now() as live from workspace_runs where id = ${run.id}`).toEqual([{ live: true }]);
      });
      expect(await creation.sweepInterruptedRunCreations()).toBe(0);
    } finally { resume.release(); }
    await expect(creating).resolves.toBe("done");
  });
});
