import { calculateAiUsageCostCents, resolvePipelineTextModel, type PrivacyMode, type TextGenerationConfig } from "@docslurp/shared";

import type { Config } from "../config.js";
import { generateOpenRouterText } from "../lib/ai.js";
import { textModelApiKey, textUsageLabels } from "../lib/text-model-route.js";
import { allowHostedCall, openRouterTextCall } from "../lib/privacy-guard.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { measureOp } from "../lib/perf-context.js";
import { buildTrustedDocumentTaskPrompt } from "../lib/trusted-llm-task.js";
import {
  extractTextForEmbedding,
  embedTextChunks,
  embeddingCallCostCents,
  estimateTokens,
} from "./embedding-runtime.js";
import {
  detectLanguage,
  resolveEmbeddingModel,
} from "../embeddings/resolver.js";
import { indexableDocuments } from "../pipeline/pii-gate.js";

export class DocumentSummaryStage implements Stage {
  readonly name = "document-summary";

  constructor(
    private readonly runner: CommandRunner,
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
      state.docConcurrency,
      async (document) => {
        const artifactSlot = `${document.id}:document-summary`;

        await runDocumentStage(
          state,
          document,
          this.name,
          artifactSlot,
          "document summary ready",
          async () => {
            const extracted = await extractTextForEmbedding(
              document,
              this.runner,
              this.storage,
              state.artifactLedger.readDocument(document.id, "markdown"),
              signal,
            );
            const {
              text: summaryText,
              inputTokens: summaryInputTokens,
              outputTokens: summaryOutputTokens,
              costCents: providerCostCents,
              metadata: costMetadata,
            } = await measureOp(
              "summary-llm-latency",
              () => this.generateSummary(extracted.text, model, state.run.pipeline.privacyMode, signal, state.run.pipeline.textGeneration),
              { metadata: { documentId: document.id } },
            );

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
              signal,
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
            const summaryCostCents = providerCostCents ?? calculateAiUsageCostCents({
              inputTokens: summaryInputTokens,
              outputTokens: summaryOutputTokens,
              costPer1kInputTokens: this.config.costPer1kInputTokens,
              costPer1kOutputTokens: this.config.costPer1kOutputTokens,
            });

            state.usageLedger.record({
                ...textUsageLabels(model),
                metric: "summary-generation",
                amount: 1,
                unit: "document",
                costCents: summaryCostCents,
                inputTokens: summaryInputTokens,
                outputTokens: summaryOutputTokens,
                metadata: { ...costMetadata, documentId: document.id },
              },
            );

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
              },
            };
          },
          signal,
        );
      },
    );
  }

  private async generateSummary(
    text: string,
    model: string,
    privacyMode: PrivacyMode,
    signal?: AbortSignal,
    textGeneration?: TextGenerationConfig,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number; costCents?: number; metadata?: Record<string, unknown> }> {
    const task = buildTrustedDocumentTaskPrompt({
      instruction:
        "Generate a one-paragraph summary of this document for use in a search index.",
      outputContract:
        "Return only the summary paragraph. Be concise and capture the main topics, entities, and purpose.",
      untrustedContent: text,
      untrustedContentLabel: "document text",
    });

    const result = await generateOpenRouterText({
      operation: "document-summary",
      apiKey: textModelApiKey(this.config.openRouterApiKey, model),
      privacyMode,
      model,
      maxOutputTokens: 512,
      textGeneration,
      deploymentProfile: this.config.textGenerationProfile,
      system: task.system,
      prompt: task.prompt,
      signal,
    });

    return {
      text: result.text,
      ...result.usage,
    };
  }
}
