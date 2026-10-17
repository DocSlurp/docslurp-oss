import { describe, expect, it } from "vitest";

import {
  applyWorkspaceTemplateLocks,
  canonicalDocumentSchema,
  createWorkspaceSchema,
  defaultDocumentExtractionConfig,
  defaultEmbeddingConfig,
  defaultPipelineFeatures,
  normalizePipelineFeatures,
  compilePipelinePlan,
  defaultVisionConfig,
  embeddingProfileCatalog,
  embeddingModelCatalogByUri,
  embeddingConfigSchema,
  fitEmbeddingDimensions,
  parseLlmModelUri,
  resolveEmbeddingRoute,
  documentExtractionConfigSchema,
  workspaceChatResponseSchema,
  searchCitationSchema,
  supportedEmbeddingModels,
  pipelineFeaturesSchema,
  getPipelineStageOrder,
  pipelineStagePlan,
  runStageOrder,
  uploadRequestSchema,
  workspaceTemplateSchema,
  workspaceRunSchema,
  workspaceBoardSummarySchema,
  getWorkspaceTemplate,
} from "../index.js";
import {
  defaultDocumentExtractionConfig as moduleDefaultDocumentExtractionConfig,
  documentExtractionConfigSchema as moduleDocumentExtractionConfigSchema,
} from "../extraction.js";

it("preserves fractional recorded costs in workspace board summaries", () => {
  const costs = { recordedCostCents: 0.003, computeCostCents: 0.001, totalLlmCostCents: 0.003, ingestCostCents: 0.002, searchCostCents: 0.001 };
  expect(workspaceBoardSummarySchema.parse(costs)).toMatchObject(costs);
});

// ---------------------------------------------------------------------------
// pipelineFeaturesSchema
// ---------------------------------------------------------------------------

describe("pipelineFeaturesSchema", () => {
  it("loads persisted pre-URI model settings without changing the embedding space", () => {
    const saved = {
      embed: true,
      vision: { model: "google/gemini-3.1-flash-lite", runtime: "openai-compatible", baseUrl: null, remoteFallbackModel: null },
      embedding: { profile: "balanced", model: "Xenova/bge-m3", runtime: "local", provider: "transformers.js", dimensions: 1024, batchSize: 16 },
    };
    const result = normalizePipelineFeatures(saved as unknown as Parameters<typeof normalizePipelineFeatures>[0]);
    expect(result.vision.modelUri).toBe("llm://openrouter/google/gemini-3.1-flash-lite");
    expect(result.embedding.modelUri).toBe("llm://transformers.js/Xenova/bge-m3");
    expect(resolveEmbeddingRoute(result.embedding).dimensions).toBe(1024);
    expect(result.embedding.profile).toBe("good-fast-local");
    expect(pipelineFeaturesSchema.safeParse(saved).success).toBe(false);
  });

  it("normalizes stored null page selections to all pages", () => {
    const saved = { documentExtraction: { pages: null } };
    const result = normalizePipelineFeatures(saved as unknown as Parameters<typeof normalizePipelineFeatures>[0]);
    expect(result.documentExtraction.pages).toEqual([]);
    expect(saved.documentExtraction.pages).toBeNull();
  });

  it.each([['cheap-fast', 'Xenova/all-MiniLM-L6-v2', 'cheapest-local'], ['multilingual', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', 'multilingual-local'], ['high-recall', 'text-embedding-3-small', 'cheapest-hosted'], ['code-search', 'jinaai/jina-embeddings-v2-base-code', 'code-local']])("converts stored embedding profile %s", (profile, model, expected) => {
    const saved = { embedding: { profile, model, dimensions: model === 'text-embedding-3-small' ? 256 : undefined } };
    const result = normalizePipelineFeatures(saved as unknown as Parameters<typeof normalizePipelineFeatures>[0]);
    expect(result.embedding.profile).toBe(expected);
    expect(resolveEmbeddingRoute(result.embedding).model).toBe(model);
    if (model === 'text-embedding-3-small') expect(result.embedding.dimensions).toBe(256);
  });

  it("preserves local vision routing and hosted fallback while enforcing endpoint isolation", () => {
    const saved = { vision: { model: 'Qwen/Qwen2-VL-2B-Instruct', baseUrl: 'http://127.0.0.1:8000/v1', remoteFallbackModel: 'gpt-4.1-mini' } };
    const result = normalizePipelineFeatures(saved as unknown as Parameters<typeof normalizePipelineFeatures>[0]);
    expect(result.vision.target).toBe('local');
    expect(new URL(result.vision.modelUri).searchParams.get('baseUrl')).toBe('http://127.0.0.1:8000/v1');
    expect(result.vision.remoteFallbackModelUri).toBe('llm://openai/gpt-4.1-mini');
    expect(() => normalizePipelineFeatures({ vision: { ...saved.vision, baseUrl: 'http://169.254.169.254' } } as unknown as Parameters<typeof normalizePipelineFeatures>[0])).toThrow();
    expect(saved.vision.model).toBe('Qwen/Qwen2-VL-2B-Instruct');
  });

  it("keeps rejecting unknown settings rather than silently resetting them", () => {
    expect(() => normalizePipelineFeatures({ embedding: { model: 'unrecognized-model' } } as unknown as Parameters<typeof normalizePipelineFeatures>[0])).toThrow();
    expect(() => normalizePipelineFeatures({ vision: { model: 'gpt-4.1-mini', unexpectedKey: true } } as unknown as Parameters<typeof normalizePipelineFeatures>[0])).toThrow();
    expect(normalizePipelineFeatures(defaultPipelineFeatures)).toEqual(defaultPipelineFeatures);
  });
  it("parses a complete valid object", () => {
    const result = pipelineFeaturesSchema.safeParse(defaultPipelineFeatures);
    expect(result.success).toBe(true);
  });

  it("applies all defaults for an empty object", () => {
    const result = pipelineFeaturesSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.embed).toBe(true);
      expect(result.data.inferenceLane).toBe("standard");
      expect(result.data.visionFallback).toBe(true);
      expect(result.data.vision).toEqual(defaultVisionConfig);
      expect(result.data.documentExtraction).toEqual(
        defaultDocumentExtractionConfig,
      );
      expect(result.data.vectorBackends).toEqual(["lancedb"]);
      expect(result.data.maxCostCents).toBeNull();
    }
  });

  it("rejects mismatched vision runtime and model combinations", () => {
    const result = pipelineFeaturesSchema.safeParse({
      vision: {
        runtime: "local-cli",
        model: "Qwen/Qwen2-VL-2B-Instruct"
      }
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid vectorBackend value", () => {
    const result = pipelineFeaturesSchema.safeParse({
      vectorBackends: ["unknown-backend"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty vectorBackends array (min 1 required)", () => {
    const result = pipelineFeaturesSchema.safeParse({ vectorBackends: [] });
    expect(result.success).toBe(false);
  });

  it("accepts multiple valid vectorBackends", () => {
    const result = pipelineFeaturesSchema.safeParse({
      vectorBackends: ["lancedb", "orama"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts null for maxCostCents", () => {
    const result = pipelineFeaturesSchema.safeParse({ maxCostCents: null });
    expect(result.success).toBe(true);
  });

  it("rejects negative maxCostCents", () => {
    const result = pipelineFeaturesSchema.safeParse({ maxCostCents: -1 });
    expect(result.success).toBe(false);
  });

  it("accepts 0 for maxCostCents (unlimited)", () => {
    const result = pipelineFeaturesSchema.safeParse({ maxCostCents: 0 });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid inference lane", () => {
    const result = pipelineFeaturesSchema.safeParse({ inferenceLane: "burst" });
    expect(result.success).toBe(false);
  });

  it("rejects vector indexing when embeddings are disabled", () => {
    const result = pipelineFeaturesSchema.safeParse({
      embed: false,
      indexVectors: true
    });

    expect(result.success).toBe(false);
  });

  it("rejects graph features when embeddings are disabled", () => {
    const result = pipelineFeaturesSchema.safeParse({
      embed: false,
      graphRag: true,
    });

    expect(result.success).toBe(false);
  });

  it("requires a baseUrl for openai-compatible vision runtimes", () => {
    const result = pipelineFeaturesSchema.safeParse({
      vision: {
        runtime: "openai-compatible",
        model: "Qwen/Qwen2-VL-2B-Instruct",
        baseUrl: null
      }
    });

    expect(result.success).toBe(false);
  });

  it("rejects empty output schemas", () => {
    const result = pipelineFeaturesSchema.safeParse({
      outputSchema: {}
    });

    expect(result.success).toBe(false);
  });

  it("accepts JSON-schema-style output schemas", () => {
    const result = pipelineFeaturesSchema.safeParse({
      outputSchema: {
        type: "object",
        properties: {
          invoiceNumber: { type: "string" },
          total: { type: "number" }
        },
        required: ["invoiceNumber"]
      }
    });

    expect(result.success).toBe(true);
  });

  it("rejects output schemas without an object root type", () => {
    const result = pipelineFeaturesSchema.safeParse({
      outputSchema: {
        type: "array",
        properties: {
          invoiceNumber: { type: "string" }
        }
      }
    });

    expect(result.success).toBe(false);
  });

  it("rejects required output-schema fields that are missing from properties", () => {
    const result = pipelineFeaturesSchema.safeParse({
      outputSchema: {
        type: "object",
        properties: {
          invoiceNumber: { type: "string" }
        },
        required: ["total"]
      }
    });

    expect(result.success).toBe(false);
  });

  it("accepts an ordered extraction policy a router can fill", () => {
    const result = pipelineFeaturesSchema.safeParse({
      documentExtraction: {
        order: { pdf: ["native-pdf", "kreuzberg"] },
        components: { tables: [], formulas: [], images: [] },
        pages: [],
        voting: { enabled: true, secondary: "next-in-order" },
        options: {},
        forceOcr: false,
        ocr: { language: "eng", autoRotate: true },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty candidate order", () => {
    const result = pipelineFeaturesSchema.safeParse({
      documentExtraction: { order: { pdf: [] } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-runnable restart stages", () => {
    const result = pipelineFeaturesSchema.safeParse({
      restartFromStage: "completed"
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extraction module barrel
// ---------------------------------------------------------------------------

describe("extraction module barrel", () => {
  it("keeps extraction config available from the public shared barrel", () => {
    expect(documentExtractionConfigSchema).toBe(
      moduleDocumentExtractionConfigSchema,
    );
    expect(defaultDocumentExtractionConfig).toEqual(
      moduleDefaultDocumentExtractionConfig,
    );
  });
});

// ---------------------------------------------------------------------------
// embeddingConfigSchema
// ---------------------------------------------------------------------------

describe("embeddingConfigSchema", () => {
  it("supports explicitly selected OpenAI dimensions beside the Perplexity default", () => {
    expect(resolveEmbeddingRoute(embeddingConfigSchema.parse({ profile: "cheapest-hosted", modelUri: "llm://openai/text-embedding-3-small", dimensions: 256 })).dimensions).toBe(256);
    expect(resolveEmbeddingRoute(embeddingConfigSchema.parse({ profile: "cheapest-hosted" })).dimensions).toBe(1024);
    expect(embeddingConfigSchema.safeParse({ profile: "good-fast-local", dimensions: 2048 }).success).toBe(false);
    expect(embeddingConfigSchema.safeParse({ profile: "cheapest-hosted", dimensions: 2048 }).success).toBe(false);
    expect(embeddingConfigSchema.safeParse({ profile: "good-fast-local", modelUri: "llm://openai/some-future-embedding", dimensions: 256 }).success).toBe(false);
  });

  it("allows reduced Matryoshka dimensions for local transformers.js and vLLM models", () => {
    const local = embeddingConfigSchema.parse({ profile: "good-fast-local", dimensions: 256 });
    expect(resolveEmbeddingRoute(local)).toMatchObject({ provider: "transformers.js", dimensions: 256, requestedDimensions: 256 });

    const vllmUri = "llm://vllm/nomic-embed-text-v1.5?baseUrl=http://127.0.0.1:18100/v1";
    const vllm = embeddingConfigSchema.parse({ profile: "good-fast-local", modelUri: vllmUri, dimensions: 256 });
    expect(resolveEmbeddingRoute(vllm)).toMatchObject({
      provider: "vllm", runtime: "remote", dimensions: 256, requestedDimensions: 256, baseUrl: "http://127.0.0.1:18100/v1",
    });
    // Unset dimensions keep the unknown-model fallback and never request a size.
    const vllmDefault = resolveEmbeddingRoute(embeddingConfigSchema.parse({ profile: "good-fast-local", modelUri: vllmUri }));
    expect(vllmDefault).toMatchObject({ dimensions: 1536 });
    expect(vllmDefault.requestedDimensions).toBeUndefined();
  });

  it("renormalizes vectors only when truncation happens on normalized embeddings", () => {
    const fitted = fitEmbeddingDimensions([0.6, 0.8, 0, 0], 1, true);
    expect(fitted).toEqual([1]);
    const prefix = fitEmbeddingDimensions([0.5, 0.5, 0.5, 0.5], 2, true);
    expect(Math.hypot(...prefix)).toBeCloseTo(1, 12);
    expect(prefix[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(fitEmbeddingDimensions([3, 4, 5], 2, false)).toEqual([3, 4]);
    const exact = [0.3, 0.4];
    expect(fitEmbeddingDimensions(exact, 2, true)).toBe(exact);
    expect(fitEmbeddingDimensions(exact, undefined, true)).toBe(exact);
  });
  it("keeps every supported embedding model in the authoritative URI catalog", () => {
    const catalogModels = new Set(
      Object.keys(embeddingModelCatalogByUri).map(
        (uri) => parseLlmModelUri(uri).model,
      ),
    );
    expect(supportedEmbeddingModels.every((model) => catalogModels.has(model))).toBe(true);
  });

  it("resolves operational dimensions and batching from the catalog", () => {
    const route = resolveEmbeddingRoute(embeddingConfigSchema.parse({
      profile: "good-fast-local",
    }));
    expect(route).toMatchObject({
      modelUri: "llm://transformers.js/Xenova/bge-m3",
      target: "local",
      dimensions: 1024,
      batchSize: 16,
    });
  });
  it("applies defaults for empty object", () => {
    const result = embeddingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(defaultEmbeddingConfig);
    }
  });

  it("rejects unknown runtime values", () => {
    const result = embeddingConfigSchema.safeParse({ runtime: "cloud" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown provider values", () => {
    const result = embeddingConfigSchema.safeParse({ provider: "cohere" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown profile values", () => {
    const result = embeddingConfigSchema.safeParse({ profile: "cheap-fast" });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive dimensions", () => {
    const result = embeddingConfigSchema.safeParse({ dimensions: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects model refs that are not llm:// connection strings", () => {
    const result = embeddingConfigSchema.safeParse({ modelUri: "openai/text-embedding-3-small" });
    expect(result.success).toBe(false);
  });

  it("rejects credentials embedded in model routes", () => {
    const result = embeddingConfigSchema.safeParse({ modelUri: "llm://user:secret@openai/text-embedding-3-small" });
    expect(result.success).toBe(false);
  });

  it("accepts explicit provider-portable model routes", () => {
    const result = embeddingConfigSchema.safeParse({
      modelUri: "llm://ollama/nomic-embed-text",
      target: "local",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(resolveEmbeddingRoute(result.data)).toMatchObject({
        provider: "ollama",
        runtime: "remote",
        target: "local",
        model: "nomic-embed-text",
        baseUrl: "http://127.0.0.1:11434/v1",
      });
    }
  });

  it("accepts loopback endpoints encoded in local embedding URIs", () => {
    const result = embeddingConfigSchema.safeParse({
      modelUri: "llm://vllm/acme/embed-model?baseUrl=http%3A%2F%2Flocalhost%3A9000%2Fv1",
      target: "local",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(resolveEmbeddingRoute(result.data).baseUrl).toBe("http://localhost:9000/v1");
    }
  });

  it("rejects target/provider contradictions and non-loopback local endpoints", () => {
    expect(embeddingConfigSchema.safeParse({
      modelUri: "llm://ollama/nomic-embed-text",
      target: "hosted",
    }).success).toBe(false);
    expect(embeddingConfigSchema.safeParse({
      modelUri: "llm://ollama/nomic-embed-text?baseUrl=https%3A%2F%2Fexample.com%2Fv1",
      target: "local",
    }).success).toBe(false);
  });

  it("keeps privacy-only configuration local and rejects an explicit hosted route", () => {
    for (const privacyMode of ["local-only", "strict-privacy"] as const) {
      expect(resolveEmbeddingRoute(normalizePipelineFeatures({ privacyMode }).embedding).target).toBe("local");
      expect(() => normalizePipelineFeatures({ privacyMode, embedding: { profile: "cheapest-hosted" } })).toThrow();
    }
  });

  it("defaults new workspaces to hosted Perplexity while preserving explicit model URIs", () => {
    const defaults = normalizePipelineFeatures();
    expect(defaults.embedding.profile).toBe("cheapest-hosted");
    expect(resolveEmbeddingRoute(defaults.embedding)).toMatchObject({ provider: "openrouter", model: "perplexity/pplx-embed-v1-0.6b", dimensions: 1024 });
    expect(embeddingConfigSchema.parse({}).modelUri).toBe(defaults.embedding.modelUri);
    const existing = normalizePipelineFeatures({ embedding: { profile: "cheapest-hosted", modelUri: "llm://openai/text-embedding-3-small", target: "hosted" } });
    expect(resolveEmbeddingRoute(existing.embedding)).toMatchObject({ provider: "openai", model: "text-embedding-3-small", dimensions: 1536 });
    const local = normalizePipelineFeatures({ embedding: { profile: "good-fast-local" } });
    expect(resolveEmbeddingRoute(local.embedding).runtime).toBe("local");
  });

  it("hydrates named embedding profiles into their preset defaults", () => {
    const result = embeddingConfigSchema.safeParse({ profile: "cheapest-hosted" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        ...embeddingProfileCatalog["cheapest-hosted"].config,
        lateChunking: false,
        lateChunkingWindow: 2
      });
    }
  });

  it("rejects dimensions and worker batch sizing in workspace config", () => {
    const result = embeddingConfigSchema.safeParse({
      profile: "good-fast-local",
      dimensions: 42,
      batchSize: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("workspace templates", () => {
  it("defaults lockedSettings to an empty array when omitted", () => {
    const template = workspaceTemplateSchema.parse({
      key: "meeting-notes",
      name: "Meeting Notes",
      description: "Fast preset",
      pipeline: defaultPipelineFeatures
    });

    expect(template.lockedSettings).toEqual([]);
  });

  it("reapplies locked template settings without clobbering unlocked edits", () => {
    const template = getWorkspaceTemplate("engineering-docs");
    expect(template).not.toBeNull();

    const result = applyWorkspaceTemplateLocks(
      {
        ...defaultPipelineFeatures,
        parserPlaybook: "fast",
        preserveCode: false,
        preserveImages: false,
        chunkOverlap: false,
        pageIndex: false,
        embedding: {
          ...defaultPipelineFeatures.embedding,
          profile: "good-fast-local",
          modelUri: "llm://transformers.js/Xenova/bge-m3"
        },
        graphRag: true
      },
      template
    );

    expect(result.parserPlaybook).toBe("layout-aware");
    expect(result.preserveCode).toBe(true);
    expect(result.preserveImages).toBe(true);
    expect(result.chunkOverlap).toBe(true);
    expect(result.pageIndex).toBe(true);
    expect(result.embedding.profile).toBe("code-local");
    expect(result.embedding.modelUri).toBe("llm://huggingface/jinaai/jina-embeddings-v2-base-code");
    expect(result.graphRag).toBe(true);
  });
});

describe("canonicalDocumentSchema", () => {
  it("parses a canonical document artifact with block provenance", () => {
    const result = canonicalDocumentSchema.safeParse({
      documentId: "doc-1",
      generator: "heuristic-markdown-block-tree@v1",
      source: {
        format: "native-pdf-json",
        artifactUri: "s3://bucket/doc-1.md",
        extractor: "docling",
        parser: "native-pdf",
        parserArtifactUri: "s3://bucket/doc-1.native-pdf.json"
      },
      stats: {
        blockCount: 2,
        headingCount: 1,
        paragraphCount: 1,
        codeBlockCount: 0,
        tableCount: 0,
        pageCount: 1
      },
      blocks: [
        {
          id: "doc-1:block:0000",
          type: "heading",
          order: 0,
          text: "# Intro",
          headingPath: ["Intro"],
          pageNumber: 1,
          lineStart: 1,
          lineEnd: 1,
          bbox: null,
          metadata: { level: 1 }
        },
        {
          id: "doc-1:block:0001",
          type: "paragraph",
          order: 1,
          text: "Hello world.",
          headingPath: ["Intro"],
          pageNumber: 1,
          lineStart: 2,
          lineEnd: 2,
          bbox: null,
          metadata: {}
        }
      ]
    });

    expect(result.success).toBe(true);
  });

  it("parses schema-aware table citations", () => {
    const citation = searchCitationSchema.parse({
      documentId: "doc-1",
      filename: "contracts.pdf",
      regionBoxes: [{ pageNumber: 3, x: 12, y: 42, width: 220, height: 30 }],
      regionCoordinateSpace: "page-top-left-points",
      pageNumber: 3,
      pageNumbers: [3],
      headingPath: ["Renewals"],
      chunkIndex: 7,
      blockIds: ["doc-1:block:0005"],
      blockTypes: ["table"],
      evidenceType: "table",
      canonicalDocumentUri: "s3://bucket/doc-1.canonical.json",
      tableGranularity: "row",
      tableRowIndex: 4,
      tableRowCount: 12,
      tableColumnNames: ["Vendor", "Renewal Date", "Amount"],
      tableColumnTypes: ["string", "date", "currency"],
      tableCells: [
        {
          columnIndex: 0,
          columnName: "Vendor",
          rawValue: "Acme",
          valueType: "string",
          typedValue: "Acme"
        },
        {
          columnIndex: 1,
          columnName: "Renewal Date",
          rawValue: "2025-01-05",
          valueType: "date",
          typedValue: "2025-01-05"
        }
      ],
      tableCell: {
        columnIndex: 1,
        columnName: "Renewal Date",
        rawValue: "2025-01-05",
        valueType: "date",
        typedValue: "2025-01-05"
      }
    });
    expect(citation.regionBoxes[0]?.pageNumber).toBe(3);
    expect(citation.regionCoordinateSpace).toBe("page-top-left-points");
  });

  it("parses workspace chat responses with evidence spans", () => {
    const result = workspaceChatResponseSchema.safeParse({
      id: "resp-1",
      sessionId: "session-1",
      searchSessionId: "search-1",
      answer: "Acme renews on 2025-01-05 [1]",
      citations: [{
        text: "Renewal Date: 2025-01-05",
        score: 1,
        citation: {
          documentId: "doc-1",
          filename: "contracts.pdf",
          pageNumber: 3,
          pageNumbers: [3],
          headingPath: ["Renewals"],
          chunkIndex: 2,
          blockIds: ["doc-1:block:0005"],
          blockTypes: ["table"],
          evidenceType: "table"
        }
      }],
      evidenceSpans: [{
        citationIndex: 0,
        answerStart: 0,
        answerEnd: 30,
        answerText: "Acme renews on 2025-01-05 [1]",
        sourceText: "Renewal Date: 2025-01-05",
        sourceStart: 0,
        sourceEnd: 24,
        citation: {
          documentId: "doc-1",
          filename: "contracts.pdf",
          pageNumber: 3,
          pageNumbers: [3],
          headingPath: ["Renewals"],
          chunkIndex: 2,
          blockIds: ["doc-1:block:0005"],
          blockTypes: ["table"],
          evidenceType: "table"
        }
      }],
      usage: {
        inputTokens: 120,
        outputTokens: 24,
        totalTokens: 144
      },
      runtime: {
        startedAt: "2026-04-29T12:00:00.000Z",
        completedAt: "2026-04-29T12:00:01.234Z",
        totalMs: 1234
      },
      debug: {
        citations: 1,
        model: "claude-test",
        fallback: false,
        historyTurns: 0,
        mode: "retrieval",
        wholeCorpus: {
          attempted: false,
          eligible: false,
          documentCount: null,
          chunkCount: null,
          tokenEstimate: null,
          charEstimate: null,
          maxDocuments: 12,
          maxChunks: 24,
          maxTokens: 12000,
          maxChars: 60000,
          fallbackReason: null
        }
      }
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createWorkspaceSchema
// ---------------------------------------------------------------------------

describe("createWorkspaceSchema", () => {
  it("parses a valid workspace creation input", () => {
    const result = createWorkspaceSchema.safeParse({ name: "My Workspace" });
    expect(result.success).toBe(true);
  });

  it("trims whitespace from the name", () => {
    const result = createWorkspaceSchema.safeParse({ name: "  My Workspace  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("My Workspace");
    }
  });

  it("rejects an empty name", () => {
    const result = createWorkspaceSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only name (trimmed to empty)", () => {
    const result = createWorkspaceSchema.safeParse({ name: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects a name exceeding 120 characters", () => {
    const result = createWorkspaceSchema.safeParse({ name: "A".repeat(121) });
    expect(result.success).toBe(false);
  });

  it("accepts a name of exactly 120 characters", () => {
    const result = createWorkspaceSchema.safeParse({ name: "A".repeat(120) });
    expect(result.success).toBe(true);
  });

  it("applies default userId", () => {
    const result = createWorkspaceSchema.safeParse({ name: "Test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userId).toBe("demo-user");
    }
  });
});

// ---------------------------------------------------------------------------
// uploadRequestSchema
// ---------------------------------------------------------------------------

describe("uploadRequestSchema", () => {
  it("accepts a valid upload request", () => {
    const result = uploadRequestSchema.safeParse({
      userId: "user-1",
      filenames: ["doc.pdf"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing userId", () => {
    const result = uploadRequestSchema.safeParse({ filenames: ["doc.pdf"] });
    expect(result.success).toBe(false);
  });

  it("rejects an empty filenames array (min 1 required)", () => {
    const result = uploadRequestSchema.safeParse({
      userId: "user-1",
      filenames: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts multiple filenames", () => {
    const result = uploadRequestSchema.safeParse({
      userId: "user-1",
      filenames: ["a.pdf", "b.docx", "c.txt"],
    });
    expect(result.success).toBe(true);
  });

  it("applies default pipeline features", () => {
    const result = uploadRequestSchema.safeParse({
      userId: "user-1",
      filenames: ["x.pdf"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pipeline.embed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// runStageOrder
// ---------------------------------------------------------------------------

describe("runStageOrder", () => {
  it("starts with 'queued'", () => {
    expect(runStageOrder[0]).toBe("queued");
  });

  it("ends with 'completed'", () => {
    expect(runStageOrder[runStageOrder.length - 1]).toBe("completed");
  });

  it("contains no duplicate stages", () => {
    expect(new Set(runStageOrder).size).toBe(runStageOrder.length);
  });

  it("includes key processing stages", () => {
    expect(runStageOrder).toContain("quarantine");
    expect(runStageOrder).toContain("embed");
    expect(runStageOrder).toContain("normalize");
    expect(runStageOrder).toContain("split-pages");
    expect(runStageOrder).toContain("document-summary");
    expect(runStageOrder).toContain("page-index");
  });

  it("runs quarantine before format detection", () => {
    expect(runStageOrder.indexOf("quarantine")).toBeGreaterThan(-1);
    expect(runStageOrder.indexOf("quarantine")).toBeLessThan(runStageOrder.indexOf("format-detect"));
  });
});

// ---------------------------------------------------------------------------
// pipelineStagePlan
// ---------------------------------------------------------------------------

describe("pipelineStagePlan", () => {
  it("owns runnable stage order", () => {
    expect(pipelineStagePlan.map((item) => item.stage)).toEqual(
      runStageOrder.slice(1, -1),
    );
  });

  it("gates optional stages from PipelineFeatures", () => {
    expect(getPipelineStageOrder({
      ...defaultPipelineFeatures,
      htmlExtraction: false,
      visionFallback: false,
      embed: false,
      indexVectors: false,
      pageIndex: true,
      summarize: true,
    })).toEqual([
      "quarantine",
      "format-detect",
      "to-canonical",
      "format-tooling",
      "normalize",
      "pdf-tooling",
      "split-pages",
      "extract-markdown",
      "classify-route",
      "render-images",
      "document-summary",
      "page-index",
    ]);
  });

  it("compiles a deep Pipeline Plan read model", () => {
    const plan = compilePipelinePlan({
      ...defaultPipelineFeatures,
      summarize: true,
      graphRag: true,
    });

    expect(plan.features.summarize).toBe(true);
    expect(plan.stageOrder).toEqual(plan.stages.map((item) => item.stage));
    expect(plan.phases.map((phase) => phase.key)).toEqual([
      "intake",
      "prep",
      "extract",
      "index",
    ]);
    expect(plan.stageOrder).toContain("graph-enrich");
  });
});

// ---------------------------------------------------------------------------
// workspaceRunSchema
// ---------------------------------------------------------------------------

describe("workspaceRunSchema", () => {
  const validRun = {
    id: "run-1",
    userId: "user-1",
    orgId: "org-1",
    workspaceId: "ws-1",
    workspaceName: "Test Workspace",
    kind: "bulk-upload",
    status: "queued",
    priority: 0,
    controlState: null,
    controlRequestedAt: null,
    stage: "queued",
    totalDocuments: 3,
    processedDocuments: 0,
    pagesTotal: 10,
    pagesProcessed: 0,
    costCents: 0,
    computeEstimated: false,
    pipeline: defaultPipelineFeatures,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("parses a valid workspace run", () => {
    const result = workspaceRunSchema.safeParse(validRun);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid status value", () => {
    const result = workspaceRunSchema.safeParse({ ...validRun, status: "pending" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid stage value", () => {
    const result = workspaceRunSchema.safeParse({ ...validRun, stage: "unknown-stage" });
    expect(result.success).toBe(false);
  });
});
