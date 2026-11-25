import { describe, expect, it } from "vitest";

import { completedPagesByStage, STAGE_DOCUMENT_PAGES_STAT } from "./run-stage-pages.js";

const checkpoint = (documentId: string | null, stage: string, status: string, stats: Record<string, unknown> = {}) =>
  ({ documentId, stage, status, stats }) as Parameters<typeof completedPagesByStage>[0]["stages"] extends Iterable<infer T> ? T : never;
const pages = (count: number) => ({ [STAGE_DOCUMENT_PAGES_STAT]: count });

describe("completedPagesByStage", () => {
  it("advances a stage one document at a time when its documents complete", () => {
    expect(completedPagesByStage({
      stages: [
        checkpoint("a", "classify-route", "completed", pages(12)),
        checkpoint("b", "classify-route", "completed", pages(3)),
        checkpoint("c", "classify-route", "processing"),
        checkpoint("a", "index", "completed", pages(12)),
        checkpoint("b", "index", "queued"),
      ],
    })).toEqual({ "classify-route": 15, index: 12 });
  });

  it("keeps page checkpoints for a document still inside a stage, and never counts a document twice", () => {
    expect(completedPagesByStage({
      pageProgress: { big: { "vision-extract": 400, embed: 20_000 }, small: { embed: 2 } },
      stages: [
        checkpoint("big", "vision-extract", "processing"),
        // Completed: the checkpoint's page count and the page checkpoints describe the same pages.
        checkpoint("big", "embed", "completed", pages(20_000)),
        checkpoint("small", "embed", "completed", pages(2)),
      ],
    })).toEqual({ "vision-extract": 400, embed: 20_002 });
  });

  it("counts a document whose page checkpoints cover only the pages a stage read as finished once it completes", () => {
    // Vision read 30 of 500 pages; the completed checkpoint says the document needs nothing more from the stage.
    expect(completedPagesByStage({
      pageProgress: { doc: { "vision-extract": 30 } },
      stages: [checkpoint("doc", "vision-extract", "completed", pages(500))],
    })).toEqual({ "vision-extract": 500 });
  });

  it("claims nothing for failed documents, run-level rows or checkpoints without the stat", () => {
    expect(completedPagesByStage({
      pageProgress: { old: { "extract-markdown": 4 } },
      stages: [
        checkpoint(null, "index", "completed", pages(99)),
        checkpoint("bad", "index", "failed", pages(7)),
        // Written by a worker that predates the stat: only its page checkpoints count.
        checkpoint("old", "extract-markdown", "completed"),
        checkpoint("old", "index", "completed"),
        checkpoint("odd", "index", "completed", { [STAGE_DOCUMENT_PAGES_STAT]: "12" }),
        checkpoint("neg", "index", "completed", pages(-3)),
      ],
    })).toEqual({ "extract-markdown": 4 });
  });

  it("counts a document once when several internal checkpoints share a public stage", () => {
    expect(completedPagesByStage({
      stages: [checkpoint("a", "first-pass", "completed", pages(8)), checkpoint("a", "first-pass", "completed", pages(8))],
    })).toEqual({ "first-pass": 8 });
  });

  it("is empty for a run with no checkpoints", () => {
    expect(completedPagesByStage({ stages: [] })).toEqual({});
  });
});
