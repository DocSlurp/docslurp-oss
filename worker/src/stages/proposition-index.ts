import { resolvePipelineTextModel, type PrivacyMode, type TextGenerationConfig } from "@docslurp/shared";

import type { Config } from "../config.js";
import { generateOpenRouterText } from "../lib/ai.js";
import { textFallbackCost, textModelApiKey, textUsageLabels } from "../lib/text-model-route.js";
import { allowHostedCall, openRouterTextCall } from "../lib/privacy-guard.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import { chargeDocumentFeature } from "../pipeline/feature-charges.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
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

export class PropositionIndexStage implements Stage {
  readonly name = "proposition-index";

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore,
    private readonly config: Config,
  ) {}

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    const model = resolvePipelineTextModel(state.run.pipeline, "proposition-extraction", this.config.textGenerationModel);
    if (!state.run.pipeline.propositionIndex) {
      return;
    }

    if (!textModelApiKey(this.config.openRouterApiKey, model)) {
      return;
    }

    // Propositions need a hosted text model; skip them when privacyMode forbids it.
    if (!(await allowHostedCall(state, openRouterTextCall("proposition-extraction", model), state.documents.map((document) => document.id)))) {
      return;
    }

    await runDocuments(
      indexableDocuments(state),
      state.docConcurrency,
      async (document) => {
        const artifactSlot = `${document.id}:proposition-index`;

        await runDocumentStage(
          state,
          document,
          this.name,
          artifactSlot,
          "proposition index ready",
          async () => {
            const extracted = await extractTextForEmbedding(
              document,
              this.runner,
              this.storage,
              state.artifactLedger.readDocument(document.id, "markdown"),
              signal,
            );
            const paragraphs = extracted.text
              .split(/\n\n+/)
              .map((p) => p.trim())
              .filter((p) => p.length >= 100);

            if (paragraphs.length === 0) {
              return {
                artifactUri: "",
                stats: { propositions: 0, paragraphs: 0 },
              };
            }

            const allPropositions: Array<{
              text: string;
              sourceParagraph: string;
            }> = [];
            let actualInputTokens = 0;
            let actualOutputTokens = 0;

            // Batch paragraphs to reduce API calls (up to ~3000 chars per batch)
            const batches = batchParagraphs(paragraphs, 3000);

            for (const batch of batches) {
              if (signal?.aborted) break;

              try {
                const {
                  groups: propositionTexts,
                  inputTokens: batchIn,
                  outputTokens: batchOut,
                } = await this.atomizeParagraphs(batch, model, state.run.pipeline.privacyMode, signal, state.run.pipeline.textGeneration);
                actualInputTokens += batchIn;
                actualOutputTokens += batchOut;
                for (let i = 0; i < batch.length; i++) {
                  const paragraph = batch[i]!;
                  const props = propositionTexts[i] ?? [];
                  for (const prop of props) {
                    if (prop.trim().length > 0) {
                      allPropositions.push({
                        text: prop.trim(),
                        sourceParagraph: paragraph,
                      });
                    }
                  }
                }
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                state.pendingPerformance.push({
                  documentId: document.id,
                  scope: "document",
                  stageName: this.name,
                  metric: "proposition-llm-error",
                  value: 1,
                  unit: "error",
                  tags: ["proposition", "llm", "error"],
                  metadata: { error: message },
                });
              }
            }

            if (allPropositions.length === 0) {
              return {
                artifactUri: "",
                stats: { propositions: 0, paragraphs: paragraphs.length },
              };
            }

            // Embed all propositions
            const detectedLang = detectLanguage(extracted.text);
            const profile = resolveEmbeddingModel(
              this.config,
              state.run.pipeline,
              detectedLang,
            );
            const embedded = await embedTextChunks({
              chunks: allPropositions.map((p) => p.text),
              profile,
              config: this.config,
              privacyMode: state.run.pipeline.privacyMode,
              signal,
            });

            // Build rows for DB insertion
            const rows = allPropositions.map((prop, index) => ({
              id: `${document.id}-prop-${index.toString().padStart(4, "0")}`,
              documentId: document.id,
              runId: state.run.id,
              userId: document.userId,
              chunkIndex: index,
              text: prop.text,
              sourceParagraph: prop.sourceParagraph,
              tokenEstimate: estimateTokens(prop.text),
            }));

            if (state.store && "insertPropositions" in state.store) {
              await (
                state.store as {
                  insertPropositions: (props: typeof rows) => Promise<void>;
                }
              ).insertPropositions(rows);
            }

            const key = `${document.userId}/${state.run.id}/propositions/${document.id}.json`;
            await this.storage.putJson(key, {
              documentId: document.id,
              propositions: rows.length,
              paragraphs: paragraphs.length,
              embedding: {
                model: profile.model,
                dimensions: embedded.vectors[0]?.length ?? profile.dimensions,
              },
              records: rows.map((row, index) => ({
                ...row,
                vector: embedded.vectors[index] ?? [],
              })),
            });

            const generationCost = textFallbackCost({
              model,
              inputTokens: actualInputTokens,
              outputTokens: actualOutputTokens,
              costPer1kInputTokens: this.config.costPer1kInputTokens,
              costPer1kOutputTokens: this.config.costPer1kOutputTokens,
            });

            state.usageLedger.record({
                ...textUsageLabels(model),
                metric: "proposition-generation",
                amount: batches.length,
                unit: "batch",
                costCents: generationCost.costCents,
                inputTokens: actualInputTokens,
                outputTokens: actualOutputTokens,
                metadata: { ...generationCost.metadata, documentId: document.id },
              },
            );
            // Price card (provisional): propositions per started 10 pages, once per document per run.
            chargeDocumentFeature(state, document, "propositions");

            // Record usage for embedding calls
            const embeddingTokens =
              embedded.totalTokens ??
              rows.reduce((sum, r) => sum + r.tokenEstimate, 0);
            const costCents = embeddingCallCostCents(profile, embedded, embeddingTokens, this.config.costPer1kInputTokens);

            state.usageLedger.record({
                provider: profile.provider,
                model: profile.model,
                metric: "proposition-embedding-tokens",
                amount: embeddingTokens,
                unit: "token",
                costCents,
                inputTokens: embeddingTokens,
                metadata: { documentId: document.id },
              },
            );

            return {
              artifactUri: this.storage.uri(key),
              stats: {
                propositions: rows.length,
                paragraphs: paragraphs.length,
              },
            };
          },
          signal,
        );
      },
    );
  }

  private async atomizeParagraphs(
    paragraphs: string[],
    model: string,
    privacyMode: PrivacyMode,
    signal?: AbortSignal,
    textGeneration?: TextGenerationConfig,
  ): Promise<{
    groups: string[][];
    inputTokens: number;
    outputTokens: number;
  }> {
    const combined = paragraphs
      .map((p, i) => `[PARAGRAPH ${i + 1}]\n${p}`)
      .join("\n\n");

    const task = buildTrustedDocumentTaskPrompt({
      instruction:
        paragraphs.length === 1
          ? "Convert the supplied paragraph into concise, self-contained declarative sentences."
          : "Convert each supplied paragraph into concise, self-contained declarative sentences.",
      outputContract:
        paragraphs.length === 1
          ? "Each proposition should be a complete statement of fact or claim. Return one proposition per line, no bullets or numbering."
          : "Each proposition should be a complete statement of fact or claim. Return one proposition per line, no bullets or numbering. Separate each paragraph's propositions with a blank line. Maintain the same order as the input paragraphs.",
      untrustedContent: paragraphs.length === 1 ? paragraphs[0]! : combined,
      untrustedContentLabel:
        paragraphs.length === 1 ? "paragraph" : "paragraph batch",
      maxContentChars: -1,
    });

    const result = await generateOpenRouterText({
      operation: "proposition-extraction",
      apiKey: textModelApiKey(this.config.openRouterApiKey, model),
      privacyMode,
      model,
      maxOutputTokens: 4096,
      textGeneration,
      deploymentProfile: this.config.textGenerationProfile,
      system: task.system,
      prompt: task.prompt,
      signal,
    });

    const inputTokens = result.usage.inputTokens;
    const outputTokens = result.usage.outputTokens;
    console.log(
      `[ai-usage] proposition-index model=${model} input_tokens=${inputTokens} output_tokens=${outputTokens}`,
    );

    const raw = result.text;

    let groups: string[][];
    if (paragraphs.length === 1) {
      groups = [raw.split("\n").filter((l) => l.trim().length > 0)];
    } else {
      // Split by blank lines to get per-paragraph proposition groups
      const rawGroups = raw.split(/\n\n+/);
      groups = [];
      for (let i = 0; i < paragraphs.length; i++) {
        const group = rawGroups[i] ?? "";
        groups.push(group.split("\n").filter((l) => l.trim().length > 0));
      }
    }
    return { groups, inputTokens, outputTokens };
  }
}

function batchParagraphs(paragraphs: string[], maxChars: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const p of paragraphs) {
    if (current.length > 0 && currentLen + p.length > maxChars) {
      batches.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(p);
    currentLen += p.length;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}
