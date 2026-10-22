import { calculateAiUsageCostCents, resolvePipelineTextModel, type PrivacyMode, type TextGenerationConfig } from "@docslurp/shared";

import type { Config } from "../config.js";
import { generateOpenRouterText } from "../lib/ai.js";
import { textModelApiKey, textUsageLabels } from "../lib/text-model-route.js";
import { allowHostedCall, openRouterTextCall } from "../lib/privacy-guard.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { isCostCapExceeded, runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import { chargeDocumentFeature } from "../pipeline/feature-charges.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { measureOp } from "../lib/perf-context.js";
import { buildTrustedDocumentTaskPrompt } from "../lib/trusted-llm-task.js";
import {
  embedTextChunks,
  embeddingCallCostCents,
  estimateTokens,
} from "./embedding-runtime.js";
import {
  detectLanguage,
  resolveEmbeddingModel,
} from "../embeddings/resolver.js";
import { indexableDocuments } from "../pipeline/pii-gate.js";
import { selectSummaryInput } from "./summary-input.js";
import { readSummarySource } from "./summary-source.js";

export const SUMMARY_MAX_CONCURRENCY = 4;
const SUMMARY_DEADLINE_MS = 120_000;

export class DocumentSummaryStage implements Stage {
  readonly name = "document-summary";

  constructor(
    _runner: CommandRunner,
    private readonly storage: ArtifactStore,
    private readonly config: Config,
  ) {}

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    const model = resolvePipelineTextModel(state.run.pipeline, "document-summary", this.config.textGenerationModel);
    if (!state.run.pipeline.summarize) {
      return;
    }

    if (!textModelApiKey(this.config.openRouterApiKey, model)) {
      return;
    }

    // Summaries need a hosted text model; skip them when privacyMode forbids it.
    if (!(await allowHostedCall(state, openRouterTextCall("document-summary", model), state.documents.map((document) => document.id)))) {
      return;
    }

    await runDocuments(
      indexableDocuments(state),
      Math.min(state.docConcurrency, SUMMARY_MAX_CONCURRENCY),
      async (document) => {
        const artifactSlot = `${document.id}:document-summary`;

        await runDocumentStage(
          state,
          document,
          this.name,
          artifactSlot,
          "document summary ready",
          async () => {
            if (isCostCapExceeded(state)) {
              return { message: "Document summary skipped: run cost cap reached", stats: { summarySkipped: "cost-cap" } };
            }
            const deadline = AbortSignal.timeout(SUMMARY_DEADLINE_MS);
            const summarySignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
            const extracted = await readSummarySource(
              this.storage,
              document,
              state.artifactLedger.readDocument(document.id, "markdown"),
              summarySignal,
              state.artifactLedger.readDocument(document.id, "summary-evidence"),
            );
            if (!extracted?.text.trim()) {
              return { message: "Document summary skipped: no bounded extracted text available", stats: { summarySkipped: "source-unavailable" } };
            }
            const selected = selectSummaryInput(extracted.text, extracted.sampled);
            const sourceStats = { sourceBytes: extracted.sourceBytes, readBytes: extracted.readBytes,
              inputCharacters: selected.text.length, inputBytes: Buffer.byteLength(selected.text), sampled: selected.sampled,
              coverage: extracted.coverage ?? { totalPages: document.pageCount || null, pages: [], pageReferences: "unavailable" } };
            const {
              text: generatedSummary,
              finishReason,
              inputTokens: summaryInputTokens,
              outputTokens: summaryOutputTokens,
              costCents: providerCostCents,
              metadata: costMetadata,
            } = await measureOp(
              "summary-llm-latency",
              () => this.generateSummary(selected, model, state.run.pipeline.privacyMode, summarySignal, state.run.pipeline.textGeneration),
              { metadata: { documentId: document.id } },
            );

            const summaryCostCents = providerCostCents ?? calculateAiUsageCostCents({
              inputTokens: summaryInputTokens,
              outputTokens: summaryOutputTokens,
              costPer1kInputTokens: this.config.costPer1kInputTokens,
              costPer1kOutputTokens: this.config.costPer1kOutputTokens,
            });

            // Account for generation even if embedding or persistence fails later.
            state.usageLedger.record({
              ...textUsageLabels(model),
              metric: "summary-generation",
              amount: 1,
              unit: "document",
              costCents: summaryCostCents,
              inputTokens: summaryInputTokens,
              outputTokens: summaryOutputTokens,
              metadata: { ...costMetadata, documentId: document.id, ...sourceStats },
            });

            if (finishReason === "length" || !generatedSummary.trim()) {
              return { message: "Document summary skipped: incomplete model output",
                stats: { summarySkipped: "incomplete-output", finishReason, ...sourceStats } };
            }
            // Price card: one summary per document per run (provider tokens above bill 0).
            chargeDocumentFeature(state, document, "documentSummary");
            // Coverage is a product guarantee, not an instruction the model may ignore.
            const coverage = extracted.coverage;
            const notice = selected.sampled
              ? coverage?.pageReferences === "verified"
                ? `Sampled document overview (${coverage.pages.length} of ${coverage.totalPages} pages; excerpts may be clipped). `
                : "Sampled document overview (page references unavailable). "
              : "";
            const summaryText = notice + generatedSummary.trim();
            const detectedLang = detectLanguage(summaryText);
            const profile = resolveEmbeddingModel(
              this.config,
              state.run.pipeline,
              detectedLang,
            );
            const embedded = await embedTextChunks({
              chunks: [summaryText],
              profile,
              config: this.config,
              privacyMode: state.run.pipeline.privacyMode,
              signal: summarySignal,
            });

            const vector = embedded.vectors[0] ?? [];

            if (state.store && "insertSummary" in state.store) {
              await (
                state.store as {
                  insertSummary: (s: {
                    id: string;
                    documentId: string;
                    runId: string;
                    userId: string;
                    summary: string;
                  }) => Promise<void>;
                }
              ).insertSummary({
                id: `${document.id}-summary`,
                documentId: document.id,
                runId: state.run.id,
                userId: document.userId,
                summary: summaryText,
              });
            }

            const key = `${document.userId}/${state.run.id}/summaries/${document.id}.json`;
            await this.storage.putJson(key, {
              documentId: document.id,
              summary: summaryText,
              sourceSelection: sourceStats,
              tokenEstimate: estimateTokens(summaryText),
              embedding: {
                model: profile.model,
                dimensions: vector.length || profile.dimensions,
                vector,
              },
            });

            const embeddingTokens =
              embedded.totalTokens ?? estimateTokens(summaryText);
            const costCents = embeddingCallCostCents(profile, embedded, embeddingTokens, this.config.costPer1kInputTokens);
            state.usageLedger.record({
                provider: profile.provider,
                model: profile.model,
                metric: "summary-embedding",
                amount: embeddingTokens,
                unit: "token",
                costCents,
                inputTokens: embeddingTokens,
                outputTokens: 0,
                logOutputTokens: false,
                metadata: {
                  documentId: document.id,
                  runtime: profile.runtime,
                },
              },
            );

            return {
              artifactUri: this.storage.uri(key),
              stats: {
                summaryLength: summaryText.length,
                embeddingDimensions: vector.length,
                ...sourceStats,
              },
            };
          },
          signal,
        );
      },
    );
  }

  private async generateSummary(
    selected: { text: string; sampled: boolean },
    model: string,
    privacyMode: PrivacyMode,
    signal?: AbortSignal,
    textGeneration?: TextGenerationConfig,
  ): Promise<{ text: string; finishReason: string; inputTokens: number; outputTokens: number; costCents?: number; metadata?: Record<string, unknown> }> {
    const task = buildTrustedDocumentTaskPrompt({
      instruction:
        "Generate a one-paragraph summary of this document for use in a search index.",
      outputContract:
        "Return only the summary paragraph. Be concise and capture the main topics, entities, and purpose."
        + (selected.sampled ? " The input contains representative excerpts, not the full document. Do not claim exhaustive coverage or infer details from omitted sections." : ""),
      untrustedContent: selected.text,
      untrustedContentLabel: "document text",
    });

    const result = await generateOpenRouterText({
      operation: "document-summary",
      apiKey: textModelApiKey(this.config.openRouterApiKey, model),
      privacyMode,
      model,
      maxOutputTokens: 256,
      textGeneration: {
        model: textGeneration?.model ?? null,
        models: textGeneration?.models ?? {},
        ...textGeneration,
        reasoningEfforts: { ...textGeneration?.reasoningEfforts,
          "document-summary": textGeneration?.reasoningEfforts?.["document-summary"] ?? textGeneration?.reasoningEffort ?? "none" },
        maxOutputTokens: { ...textGeneration?.maxOutputTokens,
          "document-summary": Math.min(256, textGeneration?.maxOutputTokens?.["document-summary"] ?? 256) },
      },
      deploymentProfile: this.config.textGenerationProfile,
      system: task.system,
      prompt: task.prompt,
      signal,
    });

    return {
      text: result.text,
      finishReason: result.finishReason,
      ...result.usage,
    };
  }
}
