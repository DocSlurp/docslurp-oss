import { expect, it } from "vitest";
import { projectRunProgressSnapshotSchema, projectRunSchema } from "@docslurp/shared";
import { realtimeRunProgress, realtimeRunRecord } from "./run-projection.js";
import { buildProgressModule } from "../services/progress-snapshot.js";

it("retains authoritative progress, costs and failure identity without duplicating diagnostic payloads", () => {
  const diagnostic = "x".repeat(300_000);
  const run = projectRunSchema.parse({
    id: "run", userId: "user", orgId: "org", projectId: "project", projectName: "Project", jobId: "parent",
    kind: "upload", status: "completed", stage: "completed", totalDocuments: 10, processedDocuments: 10,
    pagesTotal: 10, pagesProcessed: 10, failedDocuments: 1, costCents: 0.2, billedCostCents: 0.1,
    pipeline: {}, stats: { percentComplete: 100, diagnostic, nested: { diagnostic } }, artifacts: { output: diagnostic },
    error: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z",
  });
  const stage = {runId: run.id, documentId: "document", stage: "quarantine", status: "failed", attempts: 1,
    error: "Document could not be processed.", stats: {durationMs: 10, diagnostic}, artifactUri: diagnostic,
    updatedAt: run.updatedAt};
  const base = projectRunProgressSnapshotSchema.parse({run, stages: [stage], recentEvents: [{
    id: "event", userId: "user", runId: "run", documentId: "document", stage: "quarantine", type: "document.failed",
    message: "Document could not be processed.", createdAt: run.updatedAt, stats: {diagnostic},
    payload: {diagnostic}, progress: {diagnostic},
  }], stats: {costCents: 0.2, diagnostic}, artifacts: {output: diagnostic}});
  base.progress = buildProgressModule({run, stages: base.stages, temporal: null, pageProgress: {document: {quarantine: 1}},
    cpuUserMs: 0, cpuSystemMs: 0, rssDeltaBytes: 0, peakRssBytes: 0, inputTokens: 0, outputTokens: 0, costCents: 0.2});
  expect(Buffer.byteLength(JSON.stringify(base))).toBeGreaterThan(524_288);
  const compact = realtimeRunProgress(base);
  expect(projectRunProgressSnapshotSchema.parse(compact)).toEqual(compact);
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(20_000);
  expect(compact.run).toMatchObject({id: "run", jobId: "parent", status: "completed", processedDocuments: 10, pagesProcessed: 10,
    costCents: 0.2, billedCostCents: 0.1, failedDocuments: 1, stats: {percentComplete: 100}});
  expect(compact.progress).toEqual(base.progress);
  expect(compact.stages[0]).toMatchObject({documentId: "document", status: "failed", error: stage.error, stats: {durationMs: 10}});
  expect(compact.recentEvents[0]).toMatchObject({id: "event", type: "document.failed", documentId: "document", message: stage.error});
  expect(JSON.stringify(compact)).not.toContain(diagnostic);
  expect(base.run.artifacts.output).toBe(diagnostic);
  expect(base.recentEvents[0]!.payload.diagnostic).toBe(diagnostic);
});

it("bounds free-form numeric diagnostics and never copies nested values or nonfinite numbers", () => {
  const run = projectRunSchema.parse({id: "run", userId: "user", orgId: "org", projectId: "project", projectName: "Project",
    kind: "upload", status: "queued", stage: "queued", totalDocuments: 0, processedDocuments: 0, pagesTotal: 0, pagesProcessed: 0,
    pipeline: {}, error: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"});
  run.stats = {...Object.fromEntries(Array.from({length: 1_000}, (_, n) => [`metric${n}`, n])), nested: {secret: "withheld"}, invalid: Infinity};
  const compact = realtimeRunRecord(run);
  expect(compact.stats).toEqual({});
  expect(compact.stats).not.toHaveProperty("nested");
  expect(compact.stats).not.toHaveProperty("invalid");
  expect(compact.orgId).toBe(run.orgId);
  const activity = {runs: Array.from({length: 200}, () => compact)};
  expect(Buffer.byteLength(JSON.stringify(activity))).toBeLessThan(524_288);
});
