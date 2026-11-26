import { calculateAiUsageCostCents, resolveAllowedPipelineTextModel, summaryScanAvailable, type PrivacyMode, type TextGenerationConfig } from "@docslurp/shared";

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
  resolveEmbeddingModel,
} from "../embeddings/resolver.js";
import { indexableDocuments } from "../pipeline/pii-gate.js";
import { selectSummaryInput } from "./summary-input.js";
import { readSummarySource } from "./summary-source.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { evidenceIsWholeDocument, openScanSource, runEvidenceLabels, runSummaryScan, scanArtifactFields, scanEligible, type ScanModelCall, type ScanOutcome } from "./summary-scan.js";

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
    if (!state.run.pipeline.summarize) {
      return;
    }
    // Resolved (and policed) only when the stage runs: a disabled stage never fails on its model.
    const model = resolveAllowedPipelineTextModel(state.run.pipeline, "document-summary", this.config.textGenerationModel);

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
            const summaryStartedAt = Date.now();
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
            const baseStats = { sourceBytes: extracted.sourceBytes, readBytes: extracted.readBytes,
              inputCharacters: selected.text.length, inputBytes: Buffer.byteLength(selected.text), sampled: selected.sampled,
              coverage: extracted.coverage ?? { totalPages: document.pageCount || null, pages: [], pageReferences: "unavailable" } };
            // Adaptive labels (DOCSLURP_SUMMARY_SCAN): null unless the flag is on and the document qualifies.
            const scan = summaryScanAvailable(process.env) && extracted.coverage
              ? await this.scanSummary({ state, document, extracted, selected, model, signal: summarySignal,
                  wallMs: SUMMARY_DEADLINE_MS - (Date.now() - summaryStartedAt) })
              : null;
            // A scan that read more pages than the evidence reports them: the artifact coverage and the notice below follow
            // what was read, not the evidence sample. Pages the scan read are listed as clipped (its slices are capped).
            const sourceStats = scan && scan.extraPages.length > 0
              ? { ...baseStats, coverage: { ...baseStats.coverage,
                  pages: [...baseStats.coverage.pages, ...scan.extraPages.map((pageNumber) => ({ pageNumber, clipped: true }))] } }
              : baseStats;
            const {
              text: generatedSummary,
              finishReason,
              inputTokens: summaryInputTokens,
              outputTokens: summaryOutputTokens,
              costCents: providerCostCents,
              metadata: costMetadata,
            } = scan ? { text: scan.state.summary, finishReason: "stop", inputTokens: scan.inputTokens, outputTokens: scan.outputTokens,
              costCents: scan.costCents, metadata: undefined } : await measureOp(
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

            // Account for generation even if embedding or persistence fails later. This is the document's one
            // `summary-generation` unit on every path. The scan already recorded the tokens and cost of each of its
            // calls (amount 0), so on that path this row carries none, and nothing is counted twice or lost.
            state.usageLedger.record({
              ...textUsageLabels(model),
              metric: "summary-generation",
              amount: 1,
              unit: "document",
              costCents: scan ? 0 : summaryCostCents,
              inputTokens: scan ? 0 : summaryInputTokens,
              outputTokens: scan ? 0 : summaryOutputTokens,
              metadata: { ...costMetadata, documentId: document.id, ...sourceStats },
            });

            if (finishReason === "length" || !generatedSummary.trim()) {
              return { message: "Document summary skipped: incomplete model output",
                stats: { summarySkipped: "incomplete-output", finishReason, ...sourceStats } };
            }
            // Price card: one summary per document per run (provider tokens above bill 0).
            chargeDocumentFeature(state, document, "documentSummary");
            // Coverage is a product guarantee, not an instruction the model may ignore.
            const coverage = sourceStats.coverage;
            const notice = selected.sampled
              ? coverage?.pageReferences === "verified"
                ? `Sampled document overview (${coverage.pages.length} of ${coverage.totalPages} pages; excerpts may be clipped). `
                : "Sampled document overview (page references unavailable). "
              : "";
            const summaryText = notice + generatedSummary.trim();
            const profile = resolveEmbeddingModel(this.config, state.run.pipeline);
            const embedded = await embedTextChunks({
              chunks: [summaryText],
              profile,
              config: this.config,
              privacyMode: state.run.pipeline.privacyMode,
              signal: summarySignal,
            });

            const vector = embedded.vectors[0] ?? [];

            // Unbound states (unit tests) persist no row; every stage activity's state is bound (loadRunState).
            if (state.store) {
              await state.store.content.insertSummary({ orgId: state.run.orgId ?? null, runId: state.run.id, documentId: document.id }, {
                id: `${document.id}-summary`,
                documentId: document.id,
                runId: state.run.id,
                userId: document.userId,
                summary: summaryText,
              });
            }

            const key = `${runArtifactRoot(state.run, document.userId)}/summaries/${document.id}.json`;
            await this.storage.putJson(key, {
              documentId: document.id,
              summary: summaryText,
              sourceSelection: sourceStats,
              ...(scan ? scanArtifactFields(scan) : {}),
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

  /**
   * The adaptive scan: null (today's single call) unless the evidence is a verified page sample, a page offset index
   * describes the current Markdown and the document's text was not rewritten for PII. Logs ids, counts and the stop
   * reason only: never page text, labels, summaries or file names.
   */
  private async scanSummary(args: {
    state: WorkflowState;
    document: { id: string; filename?: string | null };
    extracted: NonNullable<Awaited<ReturnType<typeof readSummarySource>>>;
    selected: { text: string; sampled: boolean };
    model: string;
    signal: AbortSignal;
    wallMs: number;
  }): Promise<ScanOutcome | null> {
    const { state, document, extracted, selected, model, signal } = args;
    try {
      const coverage = extracted.coverage;
      if (!coverage || coverage.totalPages === null) return null;
      const pagesTotal = coverage.totalPages;
      // A document whose evidence holds every page is labelled by one call over that evidence; nothing is left to scan.
      const whole = evidenceIsWholeDocument(coverage);
      let source: Awaited<ReturnType<typeof openScanSource>> = null;
      if (!whole) {
        if (!scanEligible(coverage, selected.sampled)) return null;
        // Redaction rewrites the Markdown under the same key; never read pages of a document it touched.
        if (state.documentStage?.(document.id, "pii-detect")?.stats?.redacted === true) return null;
        const evidenceUri = state.artifactLedger.readDocument(document.id, "summary-evidence");
        const markdownUri = state.artifactLedger.readDocument(document.id, "markdown");
        if (!evidenceUri || !markdownUri) return null;
        source = await openScanSource({ storage: this.storage, documentId: document.id, evidenceUri, markdownUri,
          pagesTotal, signal });
        if (!source) return null;
      }
      const textGeneration = state.run.pipeline.textGeneration;
      const call: ScanModelCall = async ({ system, prompt, maxOutputTokens, signal: callSignal }) => {
        const result = await generateOpenRouterText({
          operation: "document-summary",
          apiKey: textModelApiKey(this.config.openRouterApiKey, model),
          privacyMode: state.run.pipeline.privacyMode,
          model,
          maxOutputTokens,
          textGeneration: {
            ...textGeneration,
            model: textGeneration?.model ?? null,
            models: textGeneration?.models ?? {},
            reasoningEfforts: { ...textGeneration?.reasoningEfforts,
              "document-summary": textGeneration?.reasoningEfforts?.["document-summary"] ?? textGeneration?.reasoningEffort ?? "none" },
            maxOutputTokens: { ...textGeneration?.maxOutputTokens,
              "document-summary": Math.min(maxOutputTokens, textGeneration?.maxOutputTokens?.["document-summary"] ?? maxOutputTokens) },
          },
          deploymentProfile: this.config.textGenerationProfile,
          system,
          prompt,
          signal: callSignal,
        });
        const { inputTokens, outputTokens, costCents, metadata } = result.usage;
        return { text: result.text, finishReason: result.finishReason, inputTokens, outputTokens, metadata,
          costCents: costCents ?? calculateAiUsageCostCents({ inputTokens, outputTokens,
            costPer1kInputTokens: this.config.costPer1kInputTokens, costPer1kOutputTokens: this.config.costPer1kOutputTokens }) };
      };
      const onAttempt = (result: Parameters<Parameters<typeof runSummaryScan>[0]["onAttempt"]>[0], info: { step: number; attempt: number }) => {
          state.usageLedger.record({
            ...textUsageLabels(model),
            metric: "summary-generation",
            // Tokens and cost only: the stage records the document's one unit itself, exactly once.
            amount: 0,
            unit: "document",
            costCents: result.costCents ?? 0,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            metadata: { ...result.metadata, documentId: document.id, scanStep: info.step, scanAttempt: info.attempt },
          });
      };
      if (whole) {
        const labelled = await runEvidenceLabels({ call, onAttempt, fileName: document.filename ?? "", evidenceText: selected.text,
          pagesTotal, signal });
        if (!labelled) console.warn(`[document-summary] summary_scan_first_step_failed document=${document.id}`);
        else console.info(`[document-summary] summary_scan document=${document.id} steps=1 stopped_by=exhausted pages_read=${labelled.pagesRead} pages_total=${labelled.pagesTotal}`);
        return labelled;
      }
      if (!source) return null;
      const outcome = await runSummaryScan({
        call,
        onAttempt,
        source,
        fileName: document.filename ?? "",
        evidenceText: selected.text,
        evidencePages: coverage.pages.map((page) => page.pageNumber),
        signal,
        shouldStop: () => isCostCapExceeded(state),
        wallMs: args.wallMs,
      });
      if (!outcome) {
        console.warn(`[document-summary] summary_scan_first_step_failed document=${document.id}`);
        return null;
      }
      console.info(`[document-summary] summary_scan document=${document.id} steps=${outcome.steps} stopped_by=${outcome.stoppedBy} pages_read=${outcome.pagesRead} pages_total=${outcome.pagesTotal}`);
      return outcome;
    } catch (error) {
      console.warn(`[document-summary] summary_scan_unavailable document=${document.id} error=${error instanceof Error ? error.name : "Error"}`);
      return null;
    }
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
