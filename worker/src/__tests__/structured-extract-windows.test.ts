import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePipelineFeatures } from "@docslurp/shared";

import { fromEnv } from "../config.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { StructuredExtractStage, findStructuredField, STRUCTURED_MAX_WINDOWS, STRUCTURED_WINDOW_CHARS } from "../stages/structured-extract.js";
import { generateOpenRouterText } from "../lib/ai.js";
import { featureCredits } from "@docslurp/shared";
import type { ArtifactStore } from "../tools/storage.js";
import type { Document, WorkspaceRun } from "../models.js";

vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: vi.fn() }));

const config = { ...fromEnv(), openRouterApiKey: "test-key" };

function memoryStorage(initial: Record<string, string>) {
  const objects = new Map<string, unknown>(Object.entries(initial));
  const storage = {
    bucket: "bucket",
    uri: (key: string) => `s3://bucket/${key}`,
    getBytes: async (key: string) => {
      if (!objects.has(key)) throw new Error(`missing ${key}`);
      return Buffer.from(String(objects.get(key)), "utf8");
    },
    putJson: async (key: string, value: unknown) => void objects.set(key, value),
  };
  return { storage: storage as unknown as ArtifactStore, objects };
}

function stateFor(document: Document, schema: Record<string, unknown>) {
  const state = WorkflowState.create({
    id: "run", orgId: "org", userId: "user", workspaceId: "ws", spentCents: 0, stats: {}, artifacts: {},
    pipeline: normalizePipelineFeatures({ outputSchema: schema }),
  } as unknown as WorkspaceRun, [document]);
  state.artifactLedger.recordDocument(document.id, "markdown", "s3://bucket/markdown/doc.md");
  return state;
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
    const document = { id: "doc", userId: "user", runId: "run", filename: "contract.pdf", mimeType: "application/pdf", pageCount: 300, sourceKey: "s" } as Document;
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
    const charge = enqueue.mock.calls.map(([event]) => event).find((event) => String(event.metric).includes("structured"));
    expect(charge?.costCents).toBe(featureCredits("structuredFields", envelope.coverage.pagesRead));
    if (envelope.coverage.truncated) {
      expect(charge!.costCents).toBeLessThan(featureCredits("structuredFields", 300));
      expect(envelope.overallPolicy).not.toBe("auto-accept");
      // A field absent from the pages read carries the warning.
      for (const field of Object.values(envelope.fields)) if (field.value === null) expect(field.errors.join(" ")).toMatch(/not read/);
    } else {
      expect(envelope.fields.signer!.value).toBe("Ada Lovelace");
    }
  });

  it("flags truncation and bills only the pages read when the document exceeds the windows read", async () => {
    const pages = Array.from({ length: 300 }, (_, index) => `Page ${index + 1}. ` + "Dense clause text here. ".repeat(180));
    const document = { id: "doc", userId: "user", runId: "run", filename: "contract.pdf", mimeType: "application/pdf", pageCount: 300, sourceKey: "s" } as Document;
    const { storage, objects } = memoryStorage({ "markdown/doc.md": pages.join("\f") });
    const state = stateFor(document, schema);
    const enqueue = vi.spyOn(state.usageLedger, "enqueue");
    vi.mocked(generateOpenRouterText).mockResolvedValue(answer({
      total: { value: 10, confidence: 0.99, evidence: [] },
      signer: { value: null, confidence: 0.1, evidence: [] },
    }) as never);

    await new StructuredExtractStage(storage, config).run(state);

    expect(vi.mocked(generateOpenRouterText)).toHaveBeenCalledTimes(STRUCTURED_MAX_WINDOWS);
    const envelope = objects.get("user/run/structured/doc.json") as { fields: Record<string, { errors: string[] }>; coverage: { truncated: boolean; pagesRead: number; pagesTotal: number }; overallPolicy: string };
    expect(envelope.coverage.truncated).toBe(true);
    expect(envelope.coverage.pagesTotal).toBe(300);
    expect(envelope.coverage.pagesRead).toBeGreaterThan(50);
    expect(envelope.coverage.pagesRead).toBeLessThan(300);
    expect(envelope.overallPolicy).not.toBe("auto-accept");
    expect(envelope.fields.signer!.errors.join(" ")).toMatch(/was not read/);
    const charge = enqueue.mock.calls.map(([event]) => event).find((event) => String(event.metric).includes("structured"));
    expect(charge?.costCents).toBe(featureCredits("structuredFields", envelope.coverage.pagesRead));
    expect(charge!.costCents).toBeLessThan(featureCredits("structuredFields", 300));
  });

  it("makes one call for a short document and bills its pages", async () => {
    const document = { id: "doc", userId: "user", runId: "run", filename: "invoice.pdf", mimeType: "application/pdf", pageCount: 2, sourceKey: "s" } as Document;
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
    expect(enqueue.mock.calls.map(([event]) => event).find((event) => String(event.metric).includes("structured"))?.costCents).toBe(featureCredits("structuredFields", 2));
  });

  it("fails the stage with a retryable error when the markdown artifact cannot be read", async () => {
    const document = { id: "doc", userId: "user", runId: "run", filename: "invoice.pdf", mimeType: "application/pdf", pageCount: 1, sourceKey: "s" } as Document;
    const { storage } = memoryStorage({});
    const state = stateFor(document, schema);
    await new StructuredExtractStage(storage, config).run(state);
    // The stage records the failure for the document (to be retried) and never answers from nothing.
    expect(state.documentStage("doc", "structured-extract")?.status).toBe("failed");
    expect(String(state.documentStage("doc", "structured-extract")?.error)).toMatch(/could not be read/);
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
