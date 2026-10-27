import { expect, it, vi } from "vitest";
import { defaultPipelineFeatures, getPipelineStageOrder, pipelineStageOrder } from "@docslurp/shared";
import { Store } from "../db/store.js";
import { createActivities } from "../temporal/activities.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { Document, WorkspaceRun } from "../models.js";
vi.mock("../db/page-base-fee.js", () => ({ recordPageBaseFee: vi.fn() }));

async function complete(statuses: string[]) {
  const run: WorkspaceRun = {
    id: "run-1", orgId: "org-1", userId: "user-1", workspaceId: "workspace-1", kind: "bulk-upload", status: "processing", stage: "page-index",
    totalDocuments: statuses.length, processedDocuments: 0, pagesTotal: statuses.length, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, embed: false, indexVectors: false, pageIndex: true, visionFallback: false, contextualChunkPreambles: false },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  };
  const docs: Document[] = statuses.map((status, index) => ({
    id: `doc-${index}`, userId: run.userId, runId: run.id, filename: "text.txt", mimeType: "text/plain", sourceKey: `raw/${index}`,
    status, extractionMode: "text", pageCount: 1, createdAt: new Date(), updatedAt: new Date(),
  }));
  // Lazy like postgres.js queries: pipelineTransaction starts them with execute().
  const lazy = (rows: unknown[] = []) => Object.assign(Promise.resolve(rows), { execute() { return this; } });
  const reserved = Object.assign(vi.fn(() => lazy()), { unsafe: () => lazy(), array: (values: unknown[]) => values, release() {} });
  const sql = Object.assign(vi.fn(async () => []), {
    begin: async (callback: (tx: unknown) => Promise<unknown>) => await callback(sql),
    reserve: async () => reserved,
    array: (values: unknown[]) => values,
  });
  const persisted: Array<{ stats: unknown; statuses: string[]; processedDocuments: number; pagesProcessed: number }> = [];
  const store = Object.assign(Object.create(Store.prototype), {
    sql, loadRun: vi.fn(async () => run), loadDocumentsForRun: vi.fn(async () => docs),
    hydrateState: vi.fn(async (state: WorkflowState) => {
      for (const name of getPipelineStageOrder(run.pipeline)) {
        state.runStages.set(name, { status: "completed" } as never);
        for (const doc of docs.filter(doc => doc.status === "page-index")) {
          if (!state.documentStages.has(doc.id)) state.documentStages.set(doc.id, new Map());
          state.documentStages.get(doc.id)!.set(name, { status: "completed" } as never);
        }
      }
      for (const doc of docs.filter(doc => doc.status === "stage-error")) {
        state.documentStages.set(doc.id, new Map([["page-index", { status: "failed" } as never]]));
      }
    }),
    updateProgress: vi.fn(async (state: WorkflowState) => { persisted.push({ stats: structuredClone(state.run.stats), statuses: state.documents.map(doc => doc.status), processedDocuments: state.run.processedDocuments, pagesProcessed: state.run.pagesProcessed }); }),
    appendEvent: vi.fn(), triggerRunEmails: vi.fn(async () => {}), triggerWebhooks: vi.fn(async () => {}),
  }) as Store;
  const activities = createActivities({ store, storage: {} as never, config: {} as never,
    stages: pipelineStageOrder.map(name => ({ name, run: vi.fn() })) });
  await activities.completePipelineRun({ runId: run.id });
  return { persisted, run };
}

it("finalizes regular documents and enabled-stage progress without vector indexing", async () => {
  const { persisted, run } = await complete(["page-index"]);
  expect(persisted[0].stats).toMatchObject({ totalStages: getPipelineStageOrder(run.pipeline).length, percentComplete: 100 });
  expect(persisted[0].statuses).toEqual(["completed"]);
  expect(persisted[0]).toMatchObject({ processedDocuments: 1, pagesProcessed: 1 });
  expect(persisted[0].stats).toMatchObject({ docsProgress: [{ status: "completed", percentComplete: 100 }] });
});

it("preserves failed and cancelled document states during run finalization", async () => {
  const { persisted } = await complete(["page-index", "failed", "cancelled", "stage-error"]);
  expect(persisted[0].statuses).toEqual(["completed", "failed", "cancelled", "stage-error"]);
});
