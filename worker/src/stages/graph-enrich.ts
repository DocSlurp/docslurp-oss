import {
  defaultGraphConfig,
  graphConfigFingerprint,
  resolvePipelineTextModel,
  type GraphConfig,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import { type ArtifactStore, keyFromStorageUri, runArtifactRoot } from "../tools/storage.js";
import type { CommunityRefreshResult, CommunitySummaryContext } from "../graph/communities.js";
import { extractDocumentGraph, type GraphChunk } from "../graph/extract.js";
import type { ReplaceDocumentGraphInput } from "../graph/graph-store.js";
import type { EmbeddingArtifact } from "./embedding-runtime.js";
import { indexableDocuments } from "../pipeline/pii-gate.js";
import { allowHostedCall, openRouterTextCall } from "../lib/privacy-guard.js";
import { textFallbackCost, textModelApiKey, textUsageLabels } from "../lib/text-model-route.js";
import { chargeDocumentFeature } from "../pipeline/feature-charges.js";

/** Store surface graph enrichment writes through (the Postgres `Store`). */
export interface KnowledgeGraphStore {
  /** Current relational chunks; reused embedding artifacts can contain old document IDs. */
  loadDocumentGraphChunks(workspaceId: string, documentId: string): Promise<GraphChunk[]>;
  replaceDocumentGraph(input: ReplaceDocumentGraphInput): Promise<{ nodes: number; edges: number }>;
  refreshWorkspaceCommunities(args: {
    workspaceId: string;
    userId: string;
    runId: string | null;
    context: CommunitySummaryContext;
  }): Promise<CommunityRefreshResult>;
  /** Documents already extracted with this config; a re-run (e.g. retrying failed Documents) skips them. */
  documentsWithGraph?(workspaceId: string, configHash: string, documentIds: readonly string[]): Promise<Set<string>>;
  /** The workspace's own definition, used as scope when no domain is set. */
  workspaceGraphScope(workspaceId: string): Promise<string>;
}

function graphStoreOf(state: WorkflowState): KnowledgeGraphStore | null {
  const store = state.store as unknown;
  return store && typeof store === "object" && "replaceDocumentGraph" in store
    ? (store as KnowledgeGraphStore)
    : null;
}

/**
 * Builds the workspace knowledge graph progressively: each document is
 * extracted and merged into the workspace graph as soon as it is read, so the
 * graph grows while a large run is still going. Communities are re-clustered
 * across the whole workspace once the run's documents are in.
 */
export class GraphEnrichStage implements Stage {
  readonly name = "graph-enrich";

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore,
    private readonly config: Config,
  ) {}

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    const pipeline = state.run.pipeline;
    if (!pipeline.graphRag && !pipeline.entityIndex && !pipeline.graphCommunitySummaries) return;
    if (!state.run.workspaceId) return;

    const graphStore = graphStoreOf(state);
    const graphModel = resolvePipelineTextModel(pipeline, "graph-extraction", this.config.textGenerationModel);
    const communityModel = resolvePipelineTextModel(pipeline, "community-summary", this.config.textGenerationModel);
    const graphConfig: GraphConfig = { ...defaultGraphConfig, ...(pipeline.graph ?? {}) };
    const configHash = graphConfigFingerprint(graphConfig, graphModel);
    // Graph extraction and community summaries fall back to heuristics without
    // a key, so a privacy block withholds the key instead of failing the stage.
    const documentIds = indexableDocuments(state).map((document) => document.id);
    const graphApiKey = pipeline.graphRag
      && textModelApiKey(this.config.openRouterApiKey, graphModel)
      && await allowHostedCall(state, openRouterTextCall("graph-extraction", graphModel), documentIds)
      ? textModelApiKey(this.config.openRouterApiKey, graphModel)
      : undefined;
    const includeCommunitySummaries = pipeline.graphRag || pipeline.graphCommunitySummaries;
    const communityApiKey = includeCommunitySummaries
      && textModelApiKey(this.config.openRouterApiKey, communityModel)
      && await allowHostedCall(state, openRouterTextCall("community-summary", communityModel))
      ? textModelApiKey(this.config.openRouterApiKey, communityModel)
      : undefined;
    const scope = graphConfig.domain
      ?? (graphStore ? await graphStore.workspaceGraphScope(state.run.workspaceId) : "Workspace documents");

    const documents: Array<Record<string, unknown>> = [];
    let windows = 0;
    let llmDocuments = 0;
    let nodes = 0;
    let edges = 0;

    const alreadyExtracted = graphStore?.documentsWithGraph
      ? await graphStore.documentsWithGraph(state.run.workspaceId, configHash, documentIds)
      : new Set<string>();
    for (const document of indexableDocuments(state)) {
      if (alreadyExtracted.has(document.id)) continue;
      const artifactUri = state.artifactLedger.readDocument(document.id, "embeddings");
      const key = artifactUri ? keyFromStorageUri(artifactUri, this.storage.bucket) : null;
      if (!key) continue;
      // Reused embedding artifacts keep the source document's chunk IDs, while
      // reuse materializes new relational IDs. Graph mentions must point at the
      // current document's rows, just as workspace graph rebuilds do.
      const chunks: GraphChunk[] = graphStore
        ? await graphStore.loadDocumentGraphChunks(state.run.workspaceId, document.id)
        : ((await this.storage.getJson<EmbeddingArtifact>(key)).chunks ?? []).map((chunk) => ({
            id: chunk.id,
            text: chunk.text,
            pageNumber: chunk.pageNumber,
          }));

      const graph = await extractDocumentGraph({
        filename: document.filename,
        chunks,
        context: {
          config: graphConfig,
          scope,
          model: graphModel,
          apiKey: graphApiKey,
          useLlm: pipeline.graphRag,
          privacyMode: pipeline.privacyMode,
          textGeneration: pipeline.textGeneration,
          deploymentProfile: this.config.textGenerationProfile,
          signal,
          onUsage: (usage, details) => {
            state.usageLedger.record({
              ...textUsageLabels(graphModel),
              metric: "graphrag-extract",
              amount: usage.inputTokens + usage.outputTokens,
              unit: "token",
              costCents: usage.costCents ?? textFallbackCost({
                model: graphModel,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                costPer1kInputTokens: this.config.costPer1kInputTokens,
                costPer1kOutputTokens: this.config.costPer1kOutputTokens,
              }).costCents,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              metadata: {
                ...usage.metadata,
                workspaceId: state.run.workspaceId,
                documentId: document.id,
                depth: graphConfig.depth,
                ...details,
              },
            });
          },
        },
      });
      windows += graph.windows;
      if (graph.source === "llm") {
        llmDocuments += 1;
        // Price card: knowledge graph per started 10 pages, once per document per run, only when the
        // model extracted it (heuristic fallback graphs are free). Community summaries are included.
        chargeDocumentFeature(state, document, "knowledgeGraph");
      }

      // Persist per document: search sees the graph grow during long runs.
      const written = graphStore
        ? await graphStore.replaceDocumentGraph({
            workspaceId: state.run.workspaceId,
            userId: state.run.userId,
            runId: state.run.id,
            documentId: document.id,
            configHash,
            graph,
          })
        : { nodes: graph.nodes.length, edges: graph.edges.length };
      nodes += written.nodes;
      edges += written.edges;
      documents.push({
        documentId: document.id,
        filename: document.filename,
        entities: graph.nodes.length,
        relationships: graph.edges.length,
        chunks: chunks.length,
        windows: graph.windows,
        source: graph.source,
        durationMs: graph.durationMs,
      });
    }

    const includeCommunities = pipeline.graphRag || pipeline.graphCommunitySummaries;
    const communities = includeCommunities && graphStore
      ? await graphStore.refreshWorkspaceCommunities({
          workspaceId: state.run.workspaceId,
          userId: state.run.userId,
          runId: state.run.id,
          context: {
            scope,
            model: communityModel,
            apiKey: communityApiKey,
            privacyMode: pipeline.privacyMode,
            textGeneration: pipeline.textGeneration,
            deploymentProfile: this.config.textGenerationProfile,
            signal,
          },
        })
      : null;
    if (communities && (communities.inputTokens > 0 || communities.outputTokens > 0)) {
      state.usageLedger.record({
          ...textUsageLabels(communityModel),
          metric: "community-summary",
          amount: communities.inputTokens + communities.outputTokens,
          unit: "token",
          costCents: textFallbackCost({
              model: communityModel,
              inputTokens: communities.inputTokens,
              outputTokens: communities.outputTokens,
              costPer1kInputTokens: this.config.costPer1kInputTokens,
              costPer1kOutputTokens: this.config.costPer1kOutputTokens,
            }).costCents,
          inputTokens: communities.inputTokens,
          outputTokens: communities.outputTokens,
          metadata: {
            workspaceId: state.run.workspaceId,
            communities: communities.communities,
            summarized: communities.summarized,
            reused: communities.reused,
          },
        },
      );
    }

    const artifactKey = `${runArtifactRoot(state.run, state.run.userId)}/graph/workspace-graph.json`;
    await this.storage.putJson(artifactKey, {
      config: graphConfig,
      configHash,
      scope,
      documents,
      communities,
    });
    state.artifacts["knowledge-graph"] = this.storage.uri(artifactKey);
    state.run.artifacts["knowledge-graph"] = this.storage.uri(artifactKey);

    const metadata = { workspaceId: state.run.workspaceId };
    state.pendingPerformance.push(
      { scope: "run", stageName: this.name, metric: "graph-node-count", value: nodes, unit: "node", tags: ["graph", "entity"], metadata },
      { scope: "run", stageName: this.name, metric: "graph-edge-count", value: edges, unit: "edge", tags: ["graph", "relationship"], metadata },
      { scope: "run", stageName: this.name, metric: "graph-community-count", value: communities?.communities ?? 0, unit: "community", tags: ["graph", "community"], metadata },
      {
        scope: "run",
        stageName: this.name,
        metric: "graph-extraction-windows",
        value: windows,
        unit: "window",
        tags: ["graph", "llm"],
        metadata: {
          ...metadata,
          depth: graphConfig.depth,
          llmDocuments,
          documents: state.documents.length,
          customEntityTypes: graphConfig.entityTypes.length > 0,
          domain: Boolean(graphConfig.domain),
        },
      },
    );
  }
}
