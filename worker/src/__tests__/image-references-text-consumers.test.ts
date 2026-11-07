import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageAnchorsToAltText, normalizePipelineFeatures } from "@docslurp/shared";

import { fromEnv } from "../config.js";
import type { Document, ProjectRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { PageIndexStage } from "../stages/page-index.js";
import { PropositionIndexStage } from "../stages/proposition-index.js";
import { buildSummaryEvidence } from "../stages/summary-evidence.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: generate }));

/**
 * The extracted Markdown keeps `![alt](docslurp-artifact:...)` references for exports. Everything that reads it as text
 * (page rows in document_pages, proposition input, summaries) sees the alt text instead, never the artifact id.
 */
const sha = "c".repeat(64);
const ref = (alt: string, page: number) => `![${alt}](docslurp-artifact:doc:${sha}.webp#p${page}o0)`;
const paragraph = "This page explains the quarterly revenue figures in enough detail to become a proposition worth indexing here.";
const markdown = `${paragraph}\n\n${ref("Revenue chart by quarter", 1)}\f${ref("", 2)}\n\nSecond page text that mentions the signed agreement.\f`;

function harness() {
  const document = { id: "doc", userId: "user", filename: "report.pdf", mimeType: "application/pdf", pageCount: 2, sourceKey: "source.pdf" } as Document;
  const storage = {
    bucket: "bucket",
    uri: (key: string) => `s3://bucket/${key}`,
    getBytes: async (key: string) => { if (key !== "extract/doc.md") throw new Error(`unexpected read ${key}`); return Buffer.from(markdown, "utf8"); },
    putJson: vi.fn(async () => undefined),
    putBytes: vi.fn(async () => undefined),
    deleteKeys: async () => undefined,
  } as unknown as ArtifactStore;
  const state = WorkflowState.create({
    id: "run", orgId: "org", userId: "user", projectId: "ws", spentCents: 0, stats: {}, artifacts: {},
    pipeline: normalizePipelineFeatures({ pageIndex: true, propositionIndex: true }),
  } as unknown as ProjectRun, [document]);
  state.artifactLedger.recordDocument("doc", "markdown", "s3://bucket/extract/doc.md");
  const inserted: Array<{ pageNumber: number; text: string }> = [];
  const known: Record<string, unknown> = {
    getCompletedPages: async () => new Set<number>(),
    insertPages: async (rows: Array<{ pageNumber: number; text: string }>) => void inserted.push(...rows),
  };
  (state as unknown as { store: unknown }).store = new Proxy(known, { get: (target, key: string) => target[key] ?? (async () => undefined) });
  return { state, storage, inserted };
}

describe("image references in text consumers", () => {
  beforeEach(() => { vi.clearAllMocks(); generate.mockResolvedValue({ text: "[]", usage: { inputTokens: 1, outputTokens: 1 } }); });

  it("page rows hold the alt text, not the reference", async () => {
    const h = harness();
    await new PageIndexStage({} as CommandRunner, h.storage).run(h.state);
    expect(h.inserted.map((row) => row.pageNumber)).toEqual([1, 2]);
    expect(h.inserted[0]!.text).toContain("Revenue chart by quarter");
    expect(h.inserted[1]!.text).toContain("Second page text");
    expect(h.inserted.map((row) => row.text).join("\n")).not.toMatch(/docslurp-artifact|\.webp|#p\d+o\d+|!\[/);
  });

  it("proposition input holds the alt text, not the reference", async () => {
    const h = harness();
    const stage = new PropositionIndexStage({} as CommandRunner, h.storage, { ...fromEnv(), openRouterApiKey: "test", textGenerationModel: "vendor/model" });
    await stage.run(h.state);
    expect(generate).toHaveBeenCalled();
    const prompts = JSON.stringify(generate.mock.calls);
    expect(prompts).toContain("quarterly revenue figures");
    expect(prompts).not.toMatch(/docslurp-artifact|\.webp|#p\d+o\d+/);
  });

  it("summary evidence and the shared helper drop the artifact id and keep the alt text", () => {
    const evidence = buildSummaryEvidence({ text: markdown, pageCount: 2, documentId: "doc", sourceUri: "s3://bucket/extract/doc.md" });
    expect(JSON.stringify(evidence)).not.toMatch(/docslurp-artifact|\.webp/);
    expect(JSON.stringify(evidence)).toContain("Revenue chart by quarter");
    expect(imageAnchorsToAltText(`a\n${ref("Chart \\[1\\]", 1)}\nb`)).toBe("a\nChart [1]\nb");
    expect(imageAnchorsToAltText(`a\n${ref("", 1)}\nb`)).toBe("a\nb");
    expect(imageAnchorsToAltText(`see ${ref("inline chart", 1)} here`)).toBe("see inline chart here");
    expect(imageAnchorsToAltText("![x](https://example.com/x.png)")).toBe("![x](https://example.com/x.png)");
  });
});
