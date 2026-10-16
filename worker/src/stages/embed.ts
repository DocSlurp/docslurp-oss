import { createHash } from "node:crypto";

import { RunPolicyError } from "../lib/document-failure.js";
import { calculateAiUsageCostCents, buildPricedAiUsageLedgerEvent, resolvePipelineTextModel, withoutStageSelection } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { adaptiveEmbeddingBatchSizeForStage } from "../pipeline/adaptive-tuning.js";
import { checkDedup, completeDocumentPages, emitDocumentPageProgress, hashContent, isCostCapExceeded, registerHash, runDocumentStage, runDocuments, runSpentCents } from "../pipeline/checkpoints.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { keyFromStorageUri } from "../tools/storage.js";
import { detectLanguage, resolveEmbeddingModel, resolveVectorBackends } from "../embeddings/resolver.js";
import {
  asEmbeddingReuseStore,
  documentContextKey,
  EMBEDDING_REUSE_KEY_VERSION,
  embeddingInputKey,
  embeddingVectorFingerprint,
  EmbeddingReuseLookup,
  type EmbeddingReuseRef,
  type ReusableEmbeddingArtifact,
} from "../embeddings/embedding-reuse.js";
import { buildCanonicalChunksFromDocument, type CanonicalChunk } from "../lib/canonical-document.js";
import { allowHostedCall, openRouterTextCall } from "../lib/privacy-guard.js";
import { createConcurrencyLimiter, createSerialQueue, createThrottledWriter, runBounded, type ConcurrencyLimiter } from "../lib/bounded-concurrency.js";
import { textModelApiKey } from "../lib/text-model-route.js";
import {
  buildChunks,
  contextualizeChunksForEmbedding,
  embedTextChunks,
  estimateTokens,
  resolveDocumentContext,
  type DocumentContext,
  extractTextForEmbedding,
  resolveLocalTransformersJsDtype,
  type EmbeddingArtifact
} from "./embedding-runtime.js";
import { indexableDocuments } from "../pipeline/pii-gate.js";

type ChunkInsertStore = {
  insertChunks: (chunks: Array<{
    id: string;
    documentId: string;
    runId: string;
    userId: string;
    chunkIndex: number;
    text: string;
    headingPath: string[];
    pageNumber?: number;
    tokenEstimate: number;
    metadata: Record<string, unknown>;
    contentHash?: string;
    pipelineVersion?: string;
  }>) => Promise<void>;
  markDocumentLexicalSearchable?: (documentId: string) => Promise<void>;
};

const DEFAULT_MAX_EMBED_WINDOW_PAGES = 100;
const DEFAULT_MAX_EMBED_WINDOW_CHUNKS = 128;

export class EmbedStage implements Stage {
  readonly name = "embed";

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore,
    private readonly config: Config
  ) {}

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    if (!state.run.pipeline.embed) {
      return;
    }

    const vectorBackends = resolveVectorBackends(this.config, state.run.pipeline);

    // Documents blocked by the PII policy are terminal and never embedded.
    await runDocuments(indexableDocuments(state), state.docConcurrency, async (document) => {
      if (isCostCapExceeded(state)) {
        state.pendingPerformance.push({
          documentId: document.id,
          scope: "document",
          stageName: this.name,
          metric: "cost-cap-skip",
          value: 1,
          unit: "document",
          tags: ["cost", "cap"],
          metadata: { cap: state.run.pipeline.maxCostCents, totalCost: runSpentCents(state) }
        });
        return;
      }

      const artifactSlot = `${document.id}:embeddings`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "embedding artifact ready",
        async () => {
          // A partial reprocess seeds the source version's embedding artifact
          // into this slot; read it before this run overwrites it.
          const priorEmbeddingsUri = state.artifactLedger.readDocument(document.id, "embeddings");
          const extracted = await extractTextForEmbedding(
            document,
            this.runner,
            this.storage,
            state.artifactLedger.readDocument(document.id, "markdown"),
            signal,
            state.artifactLedger.readDocument(document.id, "canonical-document")
          );

          if (extracted.schemaArtifact) {
            const schemaKey = `${document.userId}/${state.run.id}/json-schema/${document.id}.json`;
            await this.storage.putJson(schemaKey, extracted.schemaArtifact);
            state.artifactLedger.recordDocument(document.id, "json-schema", this.storage.uri(schemaKey));
          }

          const detectedLang = detectLanguage(extracted.text);
          const profile = resolveEmbeddingModel(this.config, state.run.pipeline, detectedLang);
          const tunedProfile = {
            ...profile,
            // Hosted vectors do not load an inference model into the worker.
            // Bound requests to 256 short chunks while avoiding local-model batch limits.
            batchSize: profile.runtime === "remote" ? 256 : adaptiveEmbeddingBatchSizeForStage(
              state, this.name, profile.batchSize,
            ),
          };
          const embeddingConfig = state.run.pipeline.embedding as typeof state.run.pipeline.embedding & {
            lateChunking?: boolean;
            lateChunkingWindow?: number;
          };
          const lateChunkingEnabled = embeddingConfig.lateChunking === true;
          const lateChunkingWindow = Math.max(1, embeddingConfig.lateChunkingWindow ?? 2);
          const reuseStore = asEmbeddingReuseStore(state.store);
          const reuseLookup = new EmbeddingReuseLookup({
            storage: this.storage,
            store: reuseStore,
            orgId: state.run.orgId,
            seedArtifactUris: [priorEmbeddingsUri],
          });
          const artifactKey = `${document.userId}/${state.run.id}/embeddings/${document.id}.json`;
          const preamblesEnabled = state.run.pipeline.contextualChunkPreambles !== false;
          let contextKey: string | undefined;
          let reusedDocumentContext: string | undefined;
          const lookupReusableContext = async () => {
            const contextModel = resolvePipelineTextModel(state.run.pipeline, "contextual-chunk-preamble", this.config.textGenerationModel);
            if (!textModelApiKey(this.config.openRouterApiKey, contextModel)) return;
            // Logs/audits a privacy block; contextualize then uses the local heuristic.
            const hostedContextAllowed = await allowHostedCall(
              state,
              openRouterTextCall("contextual-chunk-preamble", contextModel),
              [document.id],
            );
            if (!hostedContextAllowed) return;
            // The hosted document context prefixes every chunk's embedding
            // input; regenerating it would change every key, so reuse it too.
            contextKey = documentContextKey({
              model: contextModel,
              textGeneration: state.run.pipeline.textGeneration,
              documentTitle: document.filename,
              documentText: extracted.text,
            });
            reusedDocumentContext = await reuseLookup.findDocumentContext(contextKey);
          };
          const startDocumentContext = async (): Promise<DocumentContext> => {
            await lookupReusableContext();
            return await resolveDocumentContext({
              textGeneration: state.run.pipeline.textGeneration,
              privacyMode: state.run.pipeline.privacyMode,
              documentTitle: document.filename,
              documentText: extracted.text,
              config: this.config,
              signal,
              reusedDocumentContext,
            });
          };
          // The context summary is the one LLM call ahead of embedding. In
          // `concurrent` mode it starts before chunking: the reuse lookup is
          // awaited (it decides whether to call at all), the request is sent,
          // and the event loop gets one turn to dispatch it before the
          // synchronous chunking and hashing run beside the remote call.
          let contextTask: Promise<DocumentContext> | undefined;
          if (preamblesEnabled && embedPreambleMode() === "concurrent") {
            await lookupReusableContext();
            contextTask = resolveDocumentContext({
              textGeneration: state.run.pipeline.textGeneration,
              privacyMode: state.run.pipeline.privacyMode,
              documentTitle: document.filename,
              documentText: extracted.text,
              config: this.config,
              signal,
              reusedDocumentContext,
            });
            // It never rejects today; guard the macrotask turn below anyway so a
            // future rejection cannot surface as unhandled before it is awaited.
            contextTask.catch(() => undefined);
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          let contextRecorded = false;
          const recordContextUsage = (context: DocumentContext, chunkCount: number, extra: Record<string, unknown> = {}) => {
            contextRecorded = true;
            const usage = context.usage;
            if ((usage?.inputTokens ?? 0) <= 0 && (usage?.outputTokens ?? 0) <= 0) return;
            // Recorded as soon as the call returns, so the spend is billed even
            // if embedding later fails and the cost cap sees it before embedding.
            state.usageLedger.record({
                provider: usage?.provider ?? "anthropic",
                model: usage?.model ?? "unknown",
                metric: "contextual-chunk-preamble",
                amount: chunkCount,
                unit: "chunk",
                costCents: usage?.costCents ?? calculateAiUsageCostCents({
                  inputTokens: usage?.inputTokens,
                  outputTokens: usage?.outputTokens,
                  costPer1kInputTokens: this.config.costPer1kInputTokens,
                  costPer1kOutputTokens: this.config.costPer1kOutputTokens,
                }),
                inputTokens: usage?.inputTokens ?? 0,
                outputTokens: usage?.outputTokens ?? 0,
                metadata: {
                  documentId: document.id,
                  artifact: this.storage.uri(artifactKey),
                  chunks: chunkCount,
                  ...usage?.metadata,
                  source: usage?.source ?? "heuristic",
                  ...extra,
                },
              },
            );
          };

          let chunkDrafts: CanonicalChunk[] = [];
          let contentHash = "";
          let existingUri: string | undefined;
          let prepFailed = true;
          try {
            chunkDrafts = extracted.canonicalDocument
              ? buildCanonicalChunksFromDocument(extracted.canonicalDocument, document.filename, {
                  chunkOverlap: state.run.pipeline.chunkOverlap,
                  sourceKind: document.mimeType.startsWith("image/") ? "image" : null
                })
              : fallbackChunkDrafts(extracted.text, document.filename, state.run.pipeline.chunkOverlap);
            contentHash = hashContent(
              JSON.stringify({
                documentTitle: document.filename,
                extractor: extracted.extractor,
                chunks: chunkDrafts.map((chunk) => ({
                  text: chunk.text,
                  headingPath: chunk.headingPath ?? [],
                  pageNumber: chunk.pageNumber ?? null,
                  pageNumbers: chunk.pageNumbers ?? []
                }))
              })
            );
            existingUri = checkDedup(state, contentHash, artifactSlot);
            prepFailed = false;
          } finally {
            // A summary call already started is paid for even when this
            // document stops here (an in-run duplicate or a chunking error).
            if (contextTask && (prepFailed || existingUri)) {
              const settled = await contextTask.catch(() => undefined);
              if (settled) recordContextUsage(settled, chunkDrafts.length, { discarded: existingUri ? "deduplicated" : "failed" });
            }
          }
          if (existingUri) {
            await this.materializeChunksFromArtifact({
              state,
              document,
              artifactUri: existingUri,
              contentHash
            });
            return {
              artifactUri: existingUri,
              stats: { deduplicated: true }
            };
          }
          if (preamblesEnabled && !contextTask) contextTask = startDocumentContext();
          const documentContext = contextTask ? await contextTask : undefined;
          if (documentContext && !contextRecorded) recordContextUsage(documentContext, chunkDrafts.length);
          const contextualized: Awaited<ReturnType<typeof contextualizeChunksForEmbedding>> = !documentContext
            ? {
                chunks: chunkDrafts.map((chunk) => {
                  const rawText = chunk.text.trim();
                  return {
                    rawText,
                    contextPreamble: "",
                    text: rawText
                  };
                }),
                documentContext: "",
                usage: {
                  provider: "heuristic",
                  model: "disabled-contextual-chunk-preambles",
                  inputTokens: 0,
                  outputTokens: 0,
                  source: "heuristic"
                }
              }
            : await contextualizeChunksForEmbedding({
                textGeneration: state.run.pipeline.textGeneration,
                privacyMode: state.run.pipeline.privacyMode,
                documentTitle: document.filename,
                documentText: extracted.text,
                chunks: chunkDrafts.map((chunk) => ({
                  text: chunk.text,
                  headingPath: chunk.headingPath,
                  pageNumber: chunk.pageNumber,
                  pageNumbers: chunk.pageNumbers
                })),
                config: this.config,
                signal,
                documentContext,
              });
          const embeddingInputs = buildLateChunkedEmbeddingInputs(
            contextualized.chunks.map((chunk) => chunk.text),
            lateChunkingEnabled,
            lateChunkingWindow
          );
          const embedWindows = buildEmbeddingWindows(chunkDrafts, {
            maxPages: maxEmbedWindowPages(),
            maxChunks: maxEmbedWindowChunks(tunedProfile.runtime)
          });
          const completedPagesByWindow = embeddingPageCompletions(chunkDrafts, embedWindows);
          const vectorFingerprint = embeddingVectorFingerprint({
            ...tunedProfile,
            localDtype: tunedProfile.runtime === "local" ? resolveLocalTransformersJsDtype() : undefined,
          });
          const embeddingKeys = embeddingInputs.map((input) => embeddingInputKey(input, vectorFingerprint));
          const reusedVectors = await reuseLookup.findVectors(embeddingKeys);
          const freshVectors = new Map<string, number[]>();
          const embeddedVectors: number[][] = Array.from({ length: embeddingInputs.length });
          const providerUsage: Record<string, unknown>[] = new Array(embedWindows.length);
          let embeddedTotalTokens = 0;
          let embeddedChunkCount = 0;

          // Plan every window's provider inputs up front, in window order, so a
          // key repeated across windows is still sent once (by its first window).
          const scheduled = new Set<string>();
          const windowMisses = embedWindows.map((window) => {
            const missIndexes: number[] = [];
            for (const index of window.chunkIndexes) {
              const key = embeddingKeys[index]!;
              if (reusedVectors.has(key) || scheduled.has(key)) continue;
              scheduled.add(key);
              missIndexes.push(index);
            }
            return missIndexes;
          });
          // Hosted routes overlap requests: windows and their batches share one
          // pool of EMBED_BATCH_CONCURRENCY slots. In-process models stay serial.
          const batchConcurrency = tunedProfile.runtime === "remote" ? embedBatchConcurrency() : 1;
          const batchLimiter = createConcurrencyLimiter(batchConcurrency);
          // Usage lands in the ledger per batch; the DB checkpoint (and its
          // spend check) is coalesced off the request path, with a final write.
          const progress = state.store
            ? createThrottledWriter(() => state.store!.updateProgress(state), embedProgressIntervalMs())
            : undefined;
          // Once any batch or window fails (a reached cost cap, a refused spend
          // check, a provider error), batches still queued for a slot are not
          // sent: overshoot is bounded by the requests already in flight.
          let stopError: unknown;
          let stopped = false;
          const stop = (error: unknown) => {
            if (!stopped) {
              stopped = true;
              stopError = error;
            }
          };
          // Credit leases: when this run's unflushed usage would use up its
          // lease, checkpoint before sending more, so the lease is consumed and
          // renewed (or the run paused) at exhaustion rather than at the next
          // throttled write. One forced checkpoint is shared by every batch
          // waiting on it.
          let leaseFlush: Promise<void> | null = null;
          const beforeBatch = async () => {
            if (stopped) throw stopError;
            progress?.check();
            if (isCostCapExceeded(state)) throw new RunPolicyError("Embedding cost cap reached before sending an embedding batch");
            if (progress && state.store?.creditLeaseWouldExhaust?.(state)) {
              leaseFlush ??= progress.flush().finally(() => { leaseFlush = null; });
              await leaseFlush;
              if (stopped) throw stopError;
            }
          };
          // Every hosted batch runs through this pool, so a failed batch stops
          // queued siblings in other windows too, not just its own window.
          const stoppingLimiter: ConcurrencyLimiter = {
            limit: batchLimiter.limit,
            run: (task) => batchLimiter.run(task).catch((error: unknown) => {
              stop(error);
              throw error;
            }),
          };
          const windowDone: boolean[] = embedWindows.map(() => false);
          let committedWindows = 0;
          const commitInOrder = createSerialQueue();
          // Pages complete in window order: a page is done only when its last
          // window and every window before it have their vectors.
          const commitReadyWindows = () => commitInOrder(async () => {
            while (committedWindows < embedWindows.length && windowDone[committedWindows]) {
              const windowIndex = committedWindows++;
              const window = embedWindows[windowIndex]!;
              for (const chunkIndex of window.chunkIndexes) {
                const key = embeddingKeys[chunkIndex]!;
                embeddedVectors[chunkIndex] = reusedVectors.get(key) ?? freshVectors.get(key) ?? [];
              }
              await completeDocumentPages(
                state, document, this.name, completedPagesByWindow[windowIndex] ?? [],
                document.pageCount ?? window.endPage ?? 1,
              );
            }
          });

          const embedWindow = async (windowIndex: number) => {
            const window = embedWindows[windowIndex]!;
            const missIndexes = windowMisses[windowIndex]!;
            if (missIndexes.length > 0) {
              const embeddedWindow = await embedTextChunks({
                chunks: missIndexes.map((index) => embeddingInputs[index] ?? ""),
                profile: tunedProfile,
                config: this.config,
                privacyMode: state.run.pipeline.privacyMode,
                runner: this.runner,
                signal,
                batchConcurrency,
                batchLimiter: stoppingLimiter,
                beforeBatch,
                onRemoteUsage: async ({ inputTokens, chunks, costCents: privateCostCents, costMetadata }) => {
                  // Private routes price themselves from the operator registry.
                  const priced = buildPricedAiUsageLedgerEvent({
                    provider: tunedProfile.provider, model: tunedProfile.model,
                    metric: "embedding-tokens", inputTokens,
                    ...(privateCostCents !== undefined ? { costCents: privateCostCents, metadata: costMetadata } : {}),
                  }, { fallback: { costPer1kInputTokens: this.config.costPer1kInputTokens, costPer1kOutputTokens: 0 } });
                  state.usageLedger.record({
                    provider: tunedProfile.provider, model: tunedProfile.model,
                    metric: "embedding-tokens", amount: inputTokens, unit: "token",
                    inputTokens, costCents: priced.costCents,
                    metadata: { ...priced.metadata, documentId: document.id, runtime: "remote",
                      dimensions: tunedProfile.dimensions, chunks, tokenSource: "api", windowIndex },
                  });
                  // Throws a refused spend check from an earlier background write.
                  progress?.request();
                  if (isCostCapExceeded(state)) throw new RunPolicyError("Embedding cost cap reached after recording provider usage");
                },
                onBatchComplete: async (batchProgress) => {
                  await emitDocumentPageProgress(
                    state,
                    document,
                    this.name,
                    window.endPage ?? windowIndex + 1,
                    document.pageCount ?? window.endPage ?? embedWindows.length,
                    "processing",
                    {
                      unit: "embedding-batch",
                      windowIndex: windowIndex + 1,
                      windows: embedWindows.length,
                      completedChunks: batchProgress.completed,
                      totalChunks: batchProgress.total,
                      batchSize: batchProgress.batchSize,
                      durationMs: batchProgress.durationMs,
                      rssBytes: batchProgress.rssBytes
                    }
                  );
                }
              });

              missIndexes.forEach((index, localIndex) => {
                freshVectors.set(embeddingKeys[index]!, embeddedWindow.vectors[localIndex] ?? []);
              });
              embeddedChunkCount += missIndexes.length;
              embeddedTotalTokens += embeddedWindow.totalTokens ?? missIndexes.reduce(
                (sum, index) => sum + estimateTokens(embeddingInputs[index] ?? ""),
                0
              );
              providerUsage[windowIndex] = {
                windowIndex: windowIndex + 1,
                startPage: window.startPage,
                endPage: window.endPage,
                chunks: missIndexes.length,
                reusedChunks: window.chunkIndexes.length - missIndexes.length,
                usage: embeddedWindow.usage
              };
            } else {
              providerUsage[windowIndex] = {
                windowIndex: windowIndex + 1,
                startPage: window.startPage,
                endPage: window.endPage,
                chunks: 0,
                reusedChunks: window.chunkIndexes.length,
              };
            }
            windowDone[windowIndex] = true;
            await commitReadyWindows();
          };

          try {
            await runBounded(embedWindows.length, batchConcurrency, async (windowIndex) => {
              try {
                await embedWindow(windowIndex);
              } catch (error) {
                stop(error);
                throw error;
              }
            });
          } catch (error) {
            // Persist the usage of every batch that was sent before failing:
            // cancelled/interrupted activities rethrow without a checkpoint.
            await progress?.drain();
            throw error;
          }
          // Always leave a final checkpoint with every batch's usage.
          await progress?.flush();

          const reuseHits = embeddingKeys.filter((key) => reusedVectors.has(key)).length;
          const reuseMisses = embeddingKeys.length - reuseHits;
          console.log(
            `[embed-reuse] document=${document.id} hits=${reuseHits} misses=${reuseMisses} provider_inputs=${embeddedChunkCount}` +
            ` context_reused=${reusedDocumentContext !== undefined} model=${tunedProfile.model} dimensions=${tunedProfile.dimensions}` +
            ` lookup_ms=${reuseLookup.stats.lookupMs} artifacts_loaded=${reuseLookup.stats.artifactsLoaded}`
          );

          const embedded = {
            vectors: embeddedVectors,
            usage: {
              windows: providerUsage,
              windowCount: embedWindows.length,
              maxWindowPages: maxEmbedWindowPages(),
              maxWindowChunks: maxEmbedWindowChunks(tunedProfile.runtime)
            },
            totalTokens: embeddedTotalTokens
          };

          if (embedded.vectors.length !== chunkDrafts.length) {
            throw new Error(
              `embedding vector count mismatch for ${document.id}: got ${chunkDrafts.length} chunks and ${embedded.vectors.length} vectors`
            );
          }
          if (embedded.vectors.some((vector) => !Array.isArray(vector))) {
            throw new Error(`embedding vector window assembly failed for ${document.id}`);
          }

          const chunks = chunkDrafts.map((chunk, index) => {
            const contextualizedChunk = contextualized.chunks[index];
            const rawText = contextualizedChunk?.rawText ?? chunk.text;
            const text = contextualizedChunk?.text ?? rawText;
            const tokenEstimate = estimateTokens(text);
            return {
              id: `${document.id}-${index.toString().padStart(3, "0")}`,
              index,
              text,
              tokenEstimate,
              vector: embedded.vectors[index] ?? [],
              headingPath: chunk.headingPath,
              pageNumber: chunk.pageNumber,
              pageNumbers: chunk.pageNumbers,
              blockIds: chunk.blockIds,
              blockTypes: chunk.blockTypes,
              evidenceType: chunk.evidenceType,
              canonicalDocumentUri: state.artifactLedger.readDocument(document.id, "canonical-document") ?? null,
              tableGranularity: chunk.tableGranularity ?? null,
              tableRowIndex: chunk.tableRowIndex ?? null,
              tableRowCount: chunk.tableRowCount ?? null,
              tableColumnNames: chunk.tableColumnNames ?? [],
              tableColumnTypes: chunk.tableColumnTypes ?? [],
              tableCells: chunk.tableCells ?? [],
              tableCell: chunk.tableCell ?? null,
              regionBoxes: chunk.regionBoxes ?? [],
              regions: chunk.regions ?? chunk.regionBoxes ?? [],
              regionCoordinateSpace: chunk.regionCoordinateSpace ?? null,
              sourceTrace: chunk.sourceTrace ?? null,
              metadata: {
                documentId: document.id,
                source: extracted.extractor,
                headingPath: chunk.headingPath,
                pageNumber: chunk.pageNumber,
                pageNumbers: chunk.pageNumbers,
                blockIds: chunk.blockIds,
                blockTypes: chunk.blockTypes,
                evidenceType: chunk.evidenceType,
                tableGranularity: chunk.tableGranularity ?? null,
                tableRowIndex: chunk.tableRowIndex ?? null,
                tableRowCount: chunk.tableRowCount ?? null,
                tableColumnNames: chunk.tableColumnNames ?? [],
                tableColumnTypes: chunk.tableColumnTypes ?? [],
                tableCells: chunk.tableCells ?? [],
                tableCell: chunk.tableCell ?? null,
                regionBoxes: chunk.regionBoxes ?? [],
                regions: chunk.regions ?? chunk.regionBoxes ?? [],
                regionCoordinateSpace: chunk.regionCoordinateSpace ?? null,
                locator: chunk.locator ?? null,
                sourceTrace: chunk.sourceTrace ?? {
                  canonicalDocumentUri: state.artifactLedger.readDocument(document.id, "canonical-document") ?? null,
                  parserArtifactUri: extracted.canonicalDocument?.source.parserArtifactUri ?? null,
                  sourceArtifactUri: extracted.canonicalDocument?.source.artifactUri ?? null,
                  blockIds: chunk.blockIds,
                  pageNumbers: chunk.pageNumbers,
                  extractor: extracted.extractor
                },
                overlapIndex: chunk.overlapIndex ?? 0,
                canonicalDocumentUri: state.artifactLedger.readDocument(document.id, "canonical-document") ?? null,
                rawText,
                contextPreamble: contextualizedChunk?.contextPreamble ?? "",
                contextualized: text !== rawText,
                contextualizationSource: contextualized.usage?.source ?? "heuristic",
                embeddingInputKey: embeddingKeys[index],
                embeddingReused: reusedVectors.has(embeddingKeys[index] ?? "")
              }
            };
          });

          const estimatedTokens = chunks.reduce((sum, c) => sum + c.tokenEstimate, 0);
          const totalTokens = embedded.totalTokens ?? estimatedTokens;
          const tokenSource = tunedProfile.runtime === "remote" && embedded.totalTokens !== undefined ? "api" : "estimate";

          const key = artifactKey;
          const artifact: ReusableEmbeddingArtifact = {
            documentId: document.id,
            embedding: tunedProfile,
            vectorBackends,
            chunking: "semantic-heading-max-1800-chars",
            source: {
              mimeType: document.mimeType,
              filename: document.filename,
              extractor: extracted.extractor
            },
            chunks,
            usage: {
              estimatedTokens,
              tokenSource,
              providerUsage: embedded.usage,
              contextualizationUsage: contextualized.usage
            },
            runtime: {
              kind: tunedProfile.runtime === "remote" ? "ai-sdk" : "transformers.js",
              provider: tunedProfile.provider,
              batchSize: tunedProfile.batchSize
            },
            reuse: {
              keyVersion: EMBEDDING_REUSE_KEY_VERSION,
              fingerprint: vectorFingerprint,
              hits: reuseHits,
              misses: reuseMisses,
              documentContextReused: reusedDocumentContext !== undefined
            },
            ...(contextKey && (contextualized.usage?.source === "openrouter" || contextualized.usage?.source === "reused")
              ? { documentContext: { key: contextKey, summary: contextualized.documentContext, source: contextualized.usage.source } }
              : {})
          };
          await this.storage.putJson(key, artifact);
          registerHash(state, contentHash, this.storage.uri(key));
          await this.recordReuseRefs(state, this.storage.uri(key), chunks, artifact.documentContext?.key);

          const pipelineVersion = createHash("sha256")
            .update(JSON.stringify(withoutStageSelection(state.run.pipeline)))
            .digest("hex")
            .slice(0, 8);

          await this.materializeChunks({
            state,
            document,
            chunks,
            contentHash,
            pipelineVersion
          });

          if (lateChunkingEnabled) {
            state.pendingPerformance.push({
              documentId: document.id,
              scope: "document",
              stageName: this.name,
              metric: "late-chunking-window",
              value: lateChunkingWindow,
              unit: "chunk",
              tags: ["document", "embedding", "late-chunking"],
              metadata: {
                chunkCount: chunks.length
              }
            });
          }

          const pricedEmbedding = buildPricedAiUsageLedgerEvent({
            provider: tunedProfile.provider,
            model: tunedProfile.model,
            metric: "embedding-tokens",
            inputTokens: totalTokens,
            ...(tunedProfile.runtime === "remote" ? {} : { costCents: 0 }),
          }, { fallback: { costPer1kInputTokens: this.config.costPer1kInputTokens, costPer1kOutputTokens: 0 } });
          const costCents = pricedEmbedding.costCents;

          if (tunedProfile.runtime !== "remote" && embeddedChunkCount > 0) state.usageLedger.record({
              provider: tunedProfile.provider,
              model: tunedProfile.model,
              metric: "embedding-tokens",
              amount: totalTokens,
              unit: "token",
              costCents,
              inputTokens: totalTokens,
              metadata: {
                documentId: document.id,
                artifact: this.storage.uri(key),
                runtime: tunedProfile.runtime,
                dimensions: embedded.vectors[0]?.length ?? tunedProfile.dimensions,
                batchSize: tunedProfile.batchSize,
                vectorBackends,
                chunks: chunks.length,
                canonicalBacked: Boolean(extracted.canonicalDocument),
                tokenSource,
                estimatedTokens,
                ...pricedEmbedding.metadata,
              }
            },
          );
          state.pendingPerformance.push({
            documentId: document.id,
            scope: "document",
            stageName: this.name,
            metric: "embedding-dimensions",
            value: embedded.vectors[0]?.length ?? tunedProfile.dimensions,
            unit: "dimension",
            tags: ["document", "embedding", tunedProfile.runtime],
            metadata: {
              provider: tunedProfile.provider,
              model: tunedProfile.model,
              batchSize: tunedProfile.batchSize
            }
          });
          state.pendingPerformance.push({
            documentId: document.id,
            scope: "document",
            stageName: this.name,
            metric: "embedding-chunk-count",
            value: chunks.length,
            unit: "chunk",
            tags: ["document", "embedding", "chunking"],
            metadata: {
              extractor: extracted.extractor,
              canonicalBacked: Boolean(extracted.canonicalDocument)
            }
          });
          state.pendingPerformance.push({
            documentId: document.id,
            scope: "document",
            stageName: this.name,
            metric: "detected-language",
            value: detectedLang === "en" ? 0 : 1,
            unit: "is-multilingual",
            tags: ["document", "language"],
            metadata: { detectedLanguage: detectedLang, model: tunedProfile.model }
          });
          const reuseMetadata = {
            provider: tunedProfile.provider,
            model: tunedProfile.model,
            dimensions: tunedProfile.dimensions,
            documentContextReused: reusedDocumentContext !== undefined,
            seededFromPriorArtifact: Boolean(priorEmbeddingsUri),
            ...reuseLookup.stats
          };
          state.pendingPerformance.push({
            documentId: document.id,
            scope: "document",
            stageName: this.name,
            metric: "embedding-reuse-hits",
            value: reuseHits,
            unit: "chunk",
            tags: ["document", "embedding", "reuse"],
            metadata: reuseMetadata
          });
          state.pendingPerformance.push({
            documentId: document.id,
            scope: "document",
            stageName: this.name,
            metric: "embedding-reuse-misses",
            value: reuseMisses,
            unit: "chunk",
            tags: ["document", "embedding", "reuse"],
            metadata: { ...reuseMetadata, providerInputs: embeddedChunkCount }
          });
          return {
            artifactUri: this.storage.uri(key),
            stats: {
              chunks: chunks.length,
              dimensions: embedded.vectors[0]?.length ?? tunedProfile.dimensions,
              estimatedTokens: totalTokens,
              costCents,
              reuseHits,
              reuseMisses,
              providerInputs: embeddedChunkCount,
              documentContextReused: reusedDocumentContext !== undefined
            }
          };
        },
        signal
      );
    });
  }

  /** Point this org's reuse refs at the artifact just written; never fails the stage. */
  private async recordReuseRefs(
    state: WorkflowState,
    artifactUri: string,
    chunks: EmbeddingArtifact["chunks"],
    documentContextKey: string | undefined,
  ): Promise<void> {
    const store = asEmbeddingReuseStore(state.store);
    if (!store || !state.run.orgId) return;
    const refs: EmbeddingReuseRef[] = [];
    for (const chunk of chunks) {
      const key = chunk.metadata?.embeddingInputKey;
      if (typeof key === "string" && chunk.vector.length > 0) refs.push({ key, artifactUri, chunkIndex: chunk.index });
    }
    if (documentContextKey) refs.push({ key: documentContextKey, artifactUri, chunkIndex: -1 });
    try {
      await store.recordEmbeddingReuseRefs(state.run.orgId, refs);
    } catch (error) {
      console.warn(`[embed-reuse] ref write failed run=${state.run.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async materializeChunksFromArtifact(args: {
    state: WorkflowState;
    document: WorkflowState["documents"][number];
    artifactUri: string;
    contentHash: string;
  }): Promise<void> {
    const key = keyFromStorageUri(args.artifactUri, this.storage.bucket);
    if (!key) {
      throw new Error(`unable to materialize deduplicated chunks from external artifact URI: ${args.artifactUri}`);
    }

    const artifact = await this.storage.getJson<EmbeddingArtifact>(key);
    const pipelineVersion = createHash("sha256")
      .update(JSON.stringify(withoutStageSelection(args.state.run.pipeline)))
      .digest("hex")
      .slice(0, 8);

    await this.materializeChunks({
      state: args.state,
      document: args.document,
      chunks: artifact.chunks,
      contentHash: args.contentHash,
      pipelineVersion
    });
  }

  private async materializeChunks(args: {
    state: WorkflowState;
    document: WorkflowState["documents"][number];
    chunks: EmbeddingArtifact["chunks"];
    contentHash: string;
    pipelineVersion: string;
  }): Promise<void> {
    if (!args.state.store || !("insertChunks" in args.state.store)) {
      return;
    }

    const dbChunks = args.chunks.map((c) => ({
      id: c.id,
      documentId: args.document.id,
      runId: args.state.run.id,
      userId: args.document.userId,
      chunkIndex: c.index,
      text: c.text,
      headingPath: c.headingPath ?? [],
      pageNumber: c.pageNumber ?? undefined,
      tokenEstimate: c.tokenEstimate,
      metadata: c.metadata ?? {},
      contentHash: args.contentHash,
      pipelineVersion: args.pipelineVersion
    }));
    const store = args.state.store as ChunkInsertStore;
    await store.insertChunks(dbChunks);
    // Keyword search can serve the chunks from here on, ahead of the index stage.
    if (dbChunks.length > 0) await store.markDocumentLexicalSearchable?.(args.document.id);
  }
}

function buildLateChunkedEmbeddingInputs(chunks: string[], enabled: boolean, windowSize: number): string[] {
  if (!enabled || chunks.length <= 1) {
    return chunks;
  }

  const radius = Math.max(1, Math.min(windowSize, 6));
  return chunks.map((chunk, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(chunks.length, index + radius + 1);
    const prefix = chunks.slice(start, index).join("\n\n");
    const suffix = chunks.slice(index + 1, end).join("\n\n");
    return [prefix ? `Context before:\n${prefix}` : "", `Focus chunk:\n${chunk}`, suffix ? `Context after:\n${suffix}` : ""]
      .filter(Boolean)
      .join("\n\n");
  });
}

const DEFAULT_EMBED_BATCH_CONCURRENCY = 4;
const DEFAULT_EMBED_PROGRESS_INTERVAL_MS = 500;

/** Hosted embedding requests in flight per document (EMBED_BATCH_CONCURRENCY, 1 = serial). */
export function embedBatchConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.EMBED_BATCH_CONCURRENCY ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 32) : DEFAULT_EMBED_BATCH_CONCURRENCY;
}

/** Minimum gap between embed progress checkpoints (EMBED_PROGRESS_INTERVAL_MS, 0 = every batch). */
export function embedProgressIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.EMBED_PROGRESS_INTERVAL_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_EMBED_PROGRESS_INTERVAL_MS;
}

/**
 * When the document-context summary call starts (EMBED_PREAMBLE_MODE):
 * `inline` (default) after the in-run dedup check; `concurrent` before
 * chunking and hashing. Those take ~20-30 ms for 100-500 pages, so
 * `concurrent` saves little and pays for the call on an in-run duplicate.
 */
export function embedPreambleMode(env: NodeJS.ProcessEnv = process.env): "inline" | "concurrent" {
  return env.EMBED_PREAMBLE_MODE?.trim().toLowerCase() === "concurrent" ? "concurrent" : "inline";
}

function maxEmbedWindowPages(): number {
  return Math.max(
    1,
    Number(process.env.DOCSLURP_EMBED_MAX_WINDOW_PAGES ?? DEFAULT_MAX_EMBED_WINDOW_PAGES),
  );
}

function maxEmbedWindowChunks(runtime?: string): number {
  return Math.max(
    1,
    Number(process.env.DOCSLURP_EMBED_MAX_WINDOW_CHUNKS ?? (runtime === "remote" ? 512 : DEFAULT_MAX_EMBED_WINDOW_CHUNKS)),
  );
}

/** Count a physical page only after its last chunk's window succeeds. */
export function embeddingPageCompletions(
  chunks: Array<{ pageNumber?: number | null; pageNumbers?: number[] }>,
  windows: Array<{ chunkIndexes: number[] }>,
): number[][] {
  const lastWindow = new Map<number, number>();
  windows.forEach((window, windowIndex) => {
    for (const index of window.chunkIndexes) {
      const chunk = chunks[index];
      for (const page of [...(chunk?.pageNumbers ?? []), chunk?.pageNumber]) {
        if (typeof page === "number" && Number.isInteger(page) && page > 0) lastWindow.set(page, windowIndex);
      }
    }
  });
  const result: number[][] = windows.map(() => []);
  for (const [page, windowIndex] of lastWindow) result[windowIndex]!.push(page);
  return result.map(pages => pages.sort((a, b) => a - b));
}

function buildEmbeddingWindows(
  chunks: CanonicalChunk[],
  options: { maxPages: number; maxChunks: number },
): Array<{
  chunkIndexes: number[];
  startPage?: number;
  endPage?: number;
}> {
  const windows: Array<{
    chunkIndexes: number[];
    startPage?: number;
    endPage?: number;
  }> = [];
  let current: {
    chunkIndexes: number[];
    startPage?: number;
    endPage?: number;
  } = { chunkIndexes: [] };

  for (let index = 0; index < chunks.length; index++) {
    const pageNumbers = normalizedChunkPages(chunks[index]);
    const chunkStart = pageNumbers[0];
    const chunkEnd = pageNumbers[pageNumbers.length - 1];
    const nextStart = current.startPage ?? chunkStart;
    const nextEnd = Math.max(
      current.endPage ?? chunkEnd ?? 0,
      chunkEnd ?? current.endPage ?? 0,
    ) || undefined;
    const pageSpan =
      nextStart && nextEnd ? Math.max(1, nextEnd - nextStart + 1) : undefined;
    const shouldStartNewWindow =
      current.chunkIndexes.length > 0 &&
      (current.chunkIndexes.length >= options.maxChunks ||
        (pageSpan !== undefined && pageSpan > options.maxPages));

    if (shouldStartNewWindow) {
      windows.push(current);
      current = { chunkIndexes: [] };
    }

    current.chunkIndexes.push(index);
    if (chunkStart) {
      current.startPage = current.startPage
        ? Math.min(current.startPage, chunkStart)
        : chunkStart;
    }
    if (chunkEnd) {
      current.endPage = current.endPage
        ? Math.max(current.endPage, chunkEnd)
        : chunkEnd;
    }
  }

  if (current.chunkIndexes.length > 0) {
    windows.push(current);
  }

  return windows;
}

function normalizedChunkPages(chunk: CanonicalChunk | undefined): number[] {
  const pages = [
    ...(Array.isArray(chunk?.pageNumbers) ? chunk.pageNumbers : []),
    typeof chunk?.pageNumber === "number" ? chunk.pageNumber : undefined,
  ].filter((page): page is number => typeof page === "number" && page > 0);

  return [...new Set(pages)].sort((a, b) => a - b);
}

function fallbackChunkDrafts(
  text: string,
  fallback: string,
  chunkOverlap: boolean
): CanonicalChunk[] {
  const { texts, headingPaths } = buildChunks(text, fallback, { chunkOverlap });
  return texts.map((chunkText, index) => ({
    text: chunkText,
    headingPath: headingPaths[index] ?? [],
    pageNumber: null,
    pageNumbers: [],
    blockIds: [],
    blockTypes: ["raw"],
    evidenceType: "raw",
    chunkIndex: index
  }));
}
