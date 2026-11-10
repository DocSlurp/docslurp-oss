import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePipelineFeatures } from "@docslurp/shared";

import { fromEnv } from "../config.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { StructuredExtractStage, findStructuredField, STRUCTURED_MAX_WINDOWS, STRUCTURED_WINDOW_CHARS } from "../stages/structured-extract.js";
import { generateOpenRouterText } from "../lib/ai.js";
import { featureCredits } from "@docslurp/shared";
import type { UsageEvent } from "../models.js";
import type { ArtifactStore } from "../tools/storage.js";
import type { Document, ProjectRun } from "../models.js";

vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: vi.fn() }));

const config = { ...fromEnv(), openRouterApiKey: "test-key" };

function memoryStorage(initial: Record<string, string>) {
  const objects = new Map<string, unknown>(Object.entries(initial));
  const storage = {
    bucket: "bucket",
    uri: (key: string) => `s3://bucket/${key}`,
    getBytes: async (key: string) => {
      if (!objects.has(key)) throw Object.assign(new Error(`missing ${key}`), { name: "NoSuchKey" });
      return Buffer.from(String(objects.get(key)), "utf8");
    },
    putJson: async (key: string, value: unknown) => void objects.set(key, value),
    getJson: async (key: string) => {
      if (!objects.has(key)) throw Object.assign(new Error(`missing ${key}`), { name: "NoSuchKey" });
      return objects.get(key);
    },
  };
  return { storage: storage as unknown as ArtifactStore, objects };
}

function stateFor(document: Document, schema: Record<string, unknown>) {
  const state = WorkflowState.create({
    id: "run", orgId: "org", userId: "user", projectId: "ws", spentCents: 0, stats: {}, artifacts: {},
    pipeline: normalizePipelineFeatures({ outputSchema: schema }),
  } as unknown as ProjectRun, [document]);
  state.artifactLedger.recordDocument(document.id, "markdown", "s3://bucket/markdown/doc.md");
  return state;
}

/** The credits every structured-fields charge of the run enqueued (first charge plus top-ups). */
function structuredCredits(enqueue: { mock: { calls: Array<[UsageEvent, ...unknown[]]> } }): number {
  return enqueue.mock.calls.map(([event]) => event).filter((event) => String(event.metric).includes("structured")).reduce((sum, event) => sum + event.costCents, 0);
}

const answer = (fields: Record<string, unknown>) => ({
  text: JSON.stringify({ fields }),
  finishReason: "stop",
  usage: { inputTokens: 100, outputTokens: 10 },
});

beforeEach(() => {
  vi.mocked(generateOpenRouterText).mockReset();
});

describe("structured extraction of long documents", () => {
  const schema = { type: "object", properties: { total: { type: "number" }, signer: { type: "string" } } };

  it("reads every page window of a 300-page document and merges the answers", async () => {
    const pages = Array.from({ length: 300 }, (_, index) => `Page ${index + 1}. ` + "Lorem ipsum dolor sit amet. ".repeat(60));
    pages[1] = "The total due is 4,200 euros. " + pages[1];
    pages[290] = "Signed by Ada Lovelace on behalf of the supplier. " + pages[290];
    const markdown = pages.join("\f");
    const document = { id: "doc", userId: "user", runId: "run", filename: "contract.pdf", mimeType: "application/pdf", pageCount: 300, sourceKey: "s", pageCountSource: "counted" } as Document;
    const { storage, objects } = memoryStorage({ "markdown/doc.md": markdown });
    const state = stateFor(document, schema);
    const enqueue = vi.spyOn(state.usageLedger, "enqueue");

    vi.mocked(generateOpenRouterText).mockImplementation((async (request: { prompt: string }) => {
      const hasTotal = request.prompt.includes("The total due is 4,200 euros.");
      const hasSigner = request.prompt.includes("Signed by Ada Lovelace");
      return answer({
        total: { value: hasTotal ? 4200 : null, confidence: hasTotal ? 0.9 : 0.1, evidence: hasTotal ? [{ text: "The total due is 4,200 euros." }] : [] },
        signer: { value: hasSigner ? "Ada Lovelace" : null, confidence: hasSigner ? 0.8 : 0.1, evidence: [] },
      });
    }) as never);

    await new StructuredExtractStage(storage, config).run(state);

    const calls = vi.mocked(generateOpenRouterText).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(STRUCTURED_MAX_WINDOWS);
    for (const [request] of calls) expect(request.prompt.length).toBeLessThan(STRUCTURED_WINDOW_CHARS + 20_000);

    const envelope = objects.get("user/run/structured/doc.json") as { fields: Record<string, { value: unknown; errors: string[] }>; coverage: { truncated: boolean; pagesRead: number; pagesTotal: number; windows: number }; overallPolicy: string };
    // The 300-page document is longer than the windows the stage reads: the result says so.
    expect(envelope.coverage.pagesTotal).toBe(300);
    expect(envelope.coverage.windows).toBe(calls.length);
    expect(envelope.coverage.truncated).toBe(envelope.coverage.pagesRead < 300);
    // The total is on page 2: found, and it survives the merge with the windows that returned null.
    expect(envelope.fields.total!.value).toBe(4200);

    // Billed on the pages actually read, not on all 300.
    const charged = structuredCredits(enqueue);
    expect(charged).toBe(featureCredits("structuredFields", envelope.coverage.pagesRead));
    if (envelope.coverage.truncated) {
      expect(charged).toBeLessThan(featureCredits("structuredFields", 300));
      expect(envelope.overallPolicy).not.toBe("auto-accept");
      // A field absent from the pages read carries the warning.
      for (const field of Object.values(envelope.fields)) if (field.value === null) expect(field.errors.join(" ")).toMatch(/not read/);
    } else {
      expect(envelope.fields.signer!.value).toBe("Ada Lovelace");
    }
  });

  it("flags truncation and bills only the pages read when the document exceeds the windows read", async () => {
    const pages = Array.from({ length: 300 }, (_, index) => `Page ${index + 1}. ` + "Dense clause text here. ".repeat(180));
    const document = { id: "doc", userId: "user", runId: "run", filename: "contract.pdf", mimeType: "application/pdf", pageCount: 300, sourceKey: "s", pageCountSource: "counted" } as Document;
    const { storage, objects } = memoryStorage({ "markdown/doc.md": pages.join("\f") });
    const state = stateFor(document, schema);
    const enqueue = vi.spyOn(state.usageLedger, "enqueue");
    vi.mocked(generateOpenRouterText).mockResolvedValue(answer({
      total: { value: 10, confidence: 0.99, evidence: [] },
      signer: { value: null, confidence: 0.1, evidence: [] },
    }) as never);

    await new StructuredExtractStage(storage, config).run(state);

    expect(vi.mocked(generateOpenRouterText)).toHaveBeenCalledTimes(STRUCTURED_MAX_WINDOWS);
    const envelope = objects.get("user/run/structured/doc.json") as { fields: Record<string, { errors: string[] }>; coverage: { truncated: boolean; pagesRead: number; pagesTotal: number; charsRead: number }; overallPolicy: string };
    expect(envelope.coverage.truncated).toBe(true);
    expect(envelope.coverage.pagesTotal).toBe(300);
    expect(envelope.coverage.pagesRead).toBeGreaterThan(50);
    expect(envelope.coverage.pagesRead).toBeLessThan(300);
    expect(envelope.overallPolicy).not.toBe("auto-accept");
    expect(envelope.fields.signer!.errors.join(" ")).toMatch(/was not read/);
    // The 8 windows read 800,000 characters: 229 pages of text, more than the 186 pages they cover, still fewer than all 300.
    expect(envelope.coverage.charsRead).toBeGreaterThanOrEqual(7 * STRUCTURED_WINDOW_CHARS);
    expect(structuredCredits(enqueue)).toBe(featureCredits("structuredFields", Math.ceil(envelope.coverage.charsRead / 3_500)));
    expect(structuredCredits(enqueue)).toBeLessThan(featureCredits("structuredFields", 300));
  });

  it("makes one call for a short document and bills its pages", async () => {
    const document = { id: "doc", userId: "user", runId: "run", filename: "invoice.pdf", mimeType: "application/pdf", pageCount: 2, sourceKey: "s", pageCountSource: "counted" } as Document;
    const { storage, objects } = memoryStorage({ "markdown/doc.md": "Invoice\nTotal: 12,50 €\f2nd page" });
    const state = stateFor(document, schema);
    const enqueue = vi.spyOn(state.usageLedger, "enqueue");
    vi.mocked(generateOpenRouterText).mockResolvedValue(answer({
      total: { value: 12.5, confidence: 0.9, evidence: [{ text: "Total:   12,50 €" }] },
      signer: { value: null, confidence: 0.2, evidence: [] },
    }) as never);
    await new StructuredExtractStage(storage, config).run(state);
    expect(vi.mocked(generateOpenRouterText)).toHaveBeenCalledTimes(1);
    const envelope = objects.get("user/run/structured/doc.json") as { coverage: { truncated: boolean; pagesRead: number } };
    expect(envelope.coverage).toMatchObject({ truncated: false, pagesRead: 2, windows: 1 });
    expect(structuredCredits(enqueue)).toBe(featureCredits("structuredFields", 2));
  });

  it("bills a 1-page PDF holding 800,000 characters for the text its 8 windows read, not for 1 page", async () => {
    // 800,000 characters of prose on one page: 8 windows of 100,000 characters. By page count that was 1 credit.
    const prose = "Clause text with several words in it. ".repeat(21_200).slice(0, 8 * STRUCTURED_WINDOW_CHARS);
    const document = { id: "doc", userId: "user", runId: "run", filename: "dump.pdf", mimeType: "application/pdf", pageCount: 1, sourceKey: "s", pageCountSource: "counted" } as Document;
    const { storage } = memoryStorage({ "markdown/doc.md": prose });
    const state = stateFor(document, schema);
    const enqueue = vi.spyOn(state.usageLedger, "enqueue");
    vi.mocked(generateOpenRouterText).mockResolvedValue(answer({ total: { value: 1, confidence: 0.9, evidence: [] }, signer: { value: null, confidence: 0.1, evidence: [] } }) as never);
    await new StructuredExtractStage(storage, config).run(state);
    expect(vi.mocked(generateOpenRouterText)).toHaveBeenCalledTimes(8);
    // 800,000 characters is 229 pages of text, charged on those pages rather than the 1-page count.
    expect(structuredCredits(enqueue)).toBe(featureCredits("structuredFields", 229));
    expect(structuredCredits(enqueue)).toBeGreaterThan(featureCredits("structuredFields", 1));
  });

  it("bills the windows that finished when a later one fails, and a retry that re-reads them bills only what is new", async () => {
    const window = (index: number) => `Window ${index} ` + "text ".repeat(19_000);
    const markdown = Array.from({ length: 4 }, (_, index) => window(index)).join("\f");
    const document = { id: "doc", userId: "user", runId: "run", filename: "long.pdf", mimeType: "application/pdf", pageCount: 4, sourceKey: "s", pageCountSource: "counted" } as Document;
    const { storage } = memoryStorage({ "markdown/doc.md": markdown });
    const state = stateFor(document, schema);
    const enqueue = vi.spyOn(state.usageLedger, "enqueue");
    const ok = answer({ total: { value: 1, confidence: 0.9, evidence: [] }, signer: { value: null, confidence: 0.1, evidence: [] } });
    // Window 3 of 4 fails on the first attempt (calls are concurrent, so fail the third started call, after the others answered).
    let started = 0;
    vi.mocked(generateOpenRouterText).mockImplementation((async () => {
      started += 1;
      if (started === 3) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("provider 500");
      }
      return ok;
    }) as never);
    await new StructuredExtractStage(storage, config).run(state);
    expect(state.documentStage("doc", "structured-extract")?.status).toBe("failed");
    const afterFailure = structuredCredits(enqueue);
    // Three windows were read (about 285,000 characters, 82 pages of text): billed, not 0.
    expect(afterFailure).toBeGreaterThan(0);
    expect(afterFailure).toBe(featureCredits("structuredFields", Math.ceil(3 * 95_000 / 3_500)));
    // The retry (a new attempt: its state is rebuilt from the persisted artifacts) asks the model only for the window that failed:
    // the three that finished are read back from the run's artifacts. The document is 4 pages of 95,000 characters; the retry adds
    // only the difference to what the failed attempt already billed.
    const retry = stateFor(document, schema);
    retry.artifactLedger.record("feature-charge:structuredFields:doc", String(afterFailure));
    const retryEnqueue = vi.spyOn(retry.usageLedger, "enqueue");
    vi.mocked(generateOpenRouterText).mockReset();
    vi.mocked(generateOpenRouterText).mockResolvedValue(ok as never);
    await new StructuredExtractStage(storage, config).run(retry);
    expect(generateOpenRouterText).toHaveBeenCalledTimes(1);
    expect(retry.documentStage("doc", "structured-extract")?.status).not.toBe("failed");
    const total = featureCredits("structuredFields", Math.ceil(4 * 95_000 / 3_500));
    expect(structuredCredits(retryEnqueue)).toBeCloseTo(total - afterFailure);
    expect(afterFailure + structuredCredits(retryEnqueue)).toBeCloseTo(total);
    const ids = [...enqueue.mock.calls, ...retryEnqueue.mock.calls].map(([event]) => event.id).filter((id) => String(id).includes("structuredFields"));
    expect(new Set(ids).size).toBe(ids.length); // top-ups carry distinct ids; a replayed checkpoint cannot insert one twice
  });

  it("stops reading windows once the run's cost cap is reached, by the stage's own spend", async () => {
    const markdown = Array.from({ length: 8 }, (_, index) => `Window ${index} ` + "text ".repeat(19_000)).join("\f");
    const document = { id: "doc", userId: "user", runId: "run", filename: "long.pdf", mimeType: "application/pdf", pageCount: 8, sourceKey: "s", pageCountSource: "counted" } as Document;
    const { storage, objects } = memoryStorage({ "markdown/doc.md": markdown });
    const state = stateFor(document, schema);
    state.run.pipeline = { ...state.run.pipeline, maxCostCents: 5 } as typeof state.run.pipeline;
    vi.mocked(generateOpenRouterText).mockResolvedValue(answer({ total: { value: 1, confidence: 0.9, evidence: [] }, signer: { value: null, confidence: 0.1, evidence: [] } }) as never);
    const enqueue = vi.spyOn(state.usageLedger, "enqueue");
    await new StructuredExtractStage(storage, config).run(state);
    // One window (28 pages of text, 3 credits) and a second (6 credits) cross the 5-credit cap; the third on is not read.
    expect(vi.mocked(generateOpenRouterText).mock.calls.length).toBeLessThan(8);
    const envelope = objects.get("user/run/structured/doc.json") as { coverage: { truncated: boolean } };
    expect(envelope.coverage.truncated).toBe(true);
    expect(structuredCredits(enqueue)).toBeGreaterThan(0);
  });

  it("lets DOCSLURP_STRUCTURED_MAX_WINDOWS lower the reads per document, never above the ceiling of 8", async () => {
    const { structuredMaxWindows } = await import("../stages/structured-extract.js");
    expect(structuredMaxWindows({})).toBe(8);
    expect(structuredMaxWindows({ DOCSLURP_STRUCTURED_MAX_WINDOWS: "3" })).toBe(3);
    expect(structuredMaxWindows({ DOCSLURP_STRUCTURED_MAX_WINDOWS: "50" })).toBe(8);
    expect(structuredMaxWindows({ DOCSLURP_STRUCTURED_MAX_WINDOWS: "0" })).toBe(8);
    expect(structuredMaxWindows({ DOCSLURP_STRUCTURED_MAX_WINDOWS: "abc" })).toBe(8);
  });

  it("records a permanent failure for the document when the markdown artifact does not exist", async () => {
    const document = { id: "doc", userId: "user", runId: "run", filename: "invoice.pdf", mimeType: "application/pdf", pageCount: 1, sourceKey: "s", pageCountSource: "counted" } as Document;
    const { storage } = memoryStorage({});
    const state = stateFor(document, schema);
    await new StructuredExtractStage(storage, config).run(state);
    // The object is gone: the stage records the failure for the document and never answers from nothing.
    expect(state.documentStage("doc", "structured-extract")?.status).toBe("failed");
    expect(String(state.documentStage("doc", "structured-extract")?.error)).toMatch(/could not be read/);
    expect(vi.mocked(generateOpenRouterText)).not.toHaveBeenCalled();
  });
});

describe("structured extraction when storage fails", () => {
  const schema = { type: "object", properties: { total: { type: "number" } } };
  it("rethrows a failed read so the stage retries instead of failing the document", async () => {
    const document = { id: "doc", userId: "user", runId: "run", filename: "invoice.pdf", mimeType: "application/pdf", pageCount: 1, sourceKey: "s", pageCountSource: "counted" } as Document;
    const { storage } = memoryStorage({ "markdown/doc.md": "Invoice" });
    (storage as unknown as { getBytes: unknown }).getBytes = async () => { throw new Error("503 Service Unavailable"); };
    const state = stateFor(document, schema);
    await expect(new StructuredExtractStage(storage, config).run(state)).rejects.toMatchObject({ name: "ArtifactReadError", retryable: true });
    expect(vi.mocked(generateOpenRouterText)).not.toHaveBeenCalled();
  });
});

describe("findStructuredField", () => {
  it("does not hand one value to two different non-Latin keys", () => {
    const fields = { 請求日: { value: "¥12,000" } };
    expect(findStructuredField(fields, "請求日")?.value).toBe("¥12,000");
    expect(findStructuredField(fields, "支払期限", ["請求日", "支払期限"])).toBeUndefined();
  });

  it("still maps a human-readable label to its one schema key", () => {
    expect(findStructuredField({ "Vessel Name": { value: "Argo" } }, "vessel_name", ["vessel_name"])?.value).toBe("Argo");
    expect(findStructuredField({ "Vessel Name": { value: "Argo" } }, "vessel_name", ["vessel_name", "vessel name"])).toBeUndefined();
  });

  it("composes before comparing keys", () => {
    expect(findStructuredField({ "München": { value: 1 } }, "München")?.value).toBe(1);
  });
});
