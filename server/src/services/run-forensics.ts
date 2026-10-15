import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { DocumentRecord, WorkspaceRun, WorkspaceRunStageState } from "@docslurp/shared";

import { env } from "../config.js";
import { sql } from "../db.js";
import { getArtifactText, parseArtifactUri } from "../lib/artifacts.js";
import { fileUrlForArtifact } from "../lib/file-urls.js";
import { getRun, listRunStageStates, summarizeStageResources } from "./runs.js";
import { s3ClientConfig } from "@docslurp/shared";
import { loadWithheldArtifactUrisForRun } from "./pii-artifact-guard.js";

type RunDocumentRow = {
  id: string;
  org_id: string;
  user_id: string;
  workspace_id: string;
  run_id: string | null;
  filename: string;
  mime_type: string;
  source_key: string;
  status: string;
  extraction_mode: string;
  page_count: number;
  source_sha256?: string | null;
  deduped_from_document_id?: string | null;
  dedup_scope?: "workspace" | "org" | null;
  version_number: number;
  previous_version_id: string | null;
  canonical_id?: string | null;
  superseded_at?: string | null;
  superseded_by_document_id?: string | null;
  created_at: string;
  updated_at: string;
};

type PerformanceRow = {
  document_id: string | null;
  stage_name: string;
  metric: string;
  value: number;
  unit: string;
  metadata: Record<string, unknown> | null;
};

type PageStageFailureRow = {
  document_id: string;
  failed_pages: number;
};

type ChunkStatsRow = {
  document_id: string;
  chunk_count: number;
  page_count: number;
  token_estimate: number;
};

type HeatmapPage = {
  pageNumber: number;
  plausibilityScore: number;
  strategy: string;
  charCount: number;
  tokenEstimate: number;
};

type HeatmapArtifact = {
  documentId: string;
  pages: HeatmapPage[];
};

type ArtifactSlotInfo = {
  documentId: string | null;
  name: string;
  category: "markdown" | "html" | "json" | "heatmap" | "vector" | "image" | "other";
  stage: string | null;
};

type ArtifactMetadata = {
  sizeBytes: number | null;
  contentType: string | null;
};

export interface RunForensicsSummary {
  totalCostCents: number;
  estimatedCostPerDocumentCents: number;
  totalArtifactBytes: number;
  artifactBytesPerPage: number;
  totalRetries: number;
  failedPages: number;
  averagePlausibilityScore: number | null;
  lowPlausibilityPages: number;
  strategyBreakdown: Array<{
    strategy: string;
    documents: number;
    pages: number;
    averagePlausibilityScore: number;
  }>;
}

export interface RunForensicsTimelineEntry {
  stage: string;
  scope: "run" | "document";
  documentId: string | null;
  documentFilename: string | null;
  status: WorkspaceRunStageState["status"];
  attempts: number;
  retries: number;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  failedPages: number;
  cpuMs: number | null;
  memoryMb: number | null;
}

export interface RunArtifactEconomicsEntry {
  slot: string;
  documentId: string | null;
  artifactName: string;
  category: ArtifactSlotInfo["category"];
  stage: string | null;
  uri: string;
  downloadUrl: string;
  sizeBytes: number | null;
  contentType: string | null;
  pageCount: number | null;
  estimatedCostCents: number;
}

export interface RunDocumentForensicsEntry {
  document: DocumentRecord;
  pageCount: number;
  chunkCount: number;
  tokenEstimate: number;
  artifactBytes: number;
  artifactCount: number;
  estimatedCostCents: number;
  retries: number;
  failedPages: number;
  plausibilityScore: number | null;
  lowPlausibilityPages: number;
  strategy: string | null;
}

export interface RunForensicsPayload {
  run: WorkspaceRun;
  summary: RunForensicsSummary;
  timeline: RunForensicsTimelineEntry[];
  artifacts: RunArtifactEconomicsEntry[];
  documents: RunDocumentForensicsEntry[];
}

const LOW_CONFIDENCE_THRESHOLD = 0.45;

const s3Client = new S3Client(s3ClientConfig(env.storage));

function mapDocument(row: RunDocumentRow): DocumentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sourceKey: row.source_key,
    status: row.status,
    extractionMode: row.extraction_mode,
    pageCount: row.page_count,
    sourceSha256: row.source_sha256 ?? null,
    dedupedFromDocumentId: row.deduped_from_document_id ?? null,
    dedupScope: row.dedup_scope ?? null,
    tags: [],
    versionNumber: row.version_number ?? 1,
    previousVersionId: row.previous_version_id ?? null,
    canonicalId: row.canonical_id ?? null,
    supersededAt: row.superseded_at ?? null,
    supersededByDocumentId: row.superseded_by_document_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function parseArtifactSlot(slot: string): ArtifactSlotInfo {
  const [prefix, ...rest] = slot.split(":");
  const name = rest.length > 0 ? rest.join(":") : prefix;
  const documentId = rest.length > 0 ? prefix : null;
  const lowered = name.toLowerCase();

  let category: ArtifactSlotInfo["category"] = "other";
  if (lowered.includes("heatmap")) category = "heatmap";
  else if (lowered.includes("markdown")) category = "markdown";
  else if (lowered.includes("html")) category = "html";
  else if (lowered.includes("vector") || lowered.includes("embedding") || lowered.includes("index")) category = "vector";
  else if (lowered.includes("image")) category = "image";
  else if (lowered.includes("json") || lowered.includes("schema") || lowered.includes("manifest")) category = "json";

  const stage = name.includes("-") ? name : null;

  return {
    documentId,
    name,
    category,
    stage
  };
}

export function summarizeHeatmapPages(pages: HeatmapPage[]): {
  averagePlausibilityScore: number | null;
  lowPlausibilityPages: number;
  strategy: string | null;
} {
  if (pages.length === 0) {
    return {
      averagePlausibilityScore: null,
      lowPlausibilityPages: 0,
      strategy: null
    };
  }

  const averagePlausibilityScore =
    pages.reduce((total, page) => total + page.plausibilityScore, 0) / Math.max(1, pages.length);
  const lowPlausibilityPages = pages.filter((page) => page.plausibilityScore < LOW_CONFIDENCE_THRESHOLD).length;

  const strategyCounts = new Map<string, number>();
  for (const page of pages) {
    strategyCounts.set(page.strategy, (strategyCounts.get(page.strategy) ?? 0) + 1);
  }

  let strategy: string | null = null;
  let bestCount = -1;
  for (const [key, count] of strategyCounts.entries()) {
    if (count > bestCount) {
      strategy = key;
      bestCount = count;
    }
  }

  return {
    averagePlausibilityScore,
    lowPlausibilityPages,
    strategy
  };
}

async function headArtifact(uri: string): Promise<ArtifactMetadata> {
  const parsed = parseArtifactUri(uri);
  if (!parsed) {
    return {
      sizeBytes: null,
      contentType: null
    };
  }

  try {
    const response = await s3Client.send(
      new HeadObjectCommand({
        Bucket: parsed.bucket,
        Key: parsed.key
      })
    );

    return {
      sizeBytes: response.ContentLength ?? null,
      contentType: response.ContentType ?? null
    };
  } catch {
    return {
      sizeBytes: null,
      contentType: null
    };
  }
}

async function loadHeatmap(uri: string): Promise<HeatmapArtifact | null> {
  const parsed = parseArtifactUri(uri);
  if (!parsed) {
    return null;
  }

  try {
    const response = await s3Client.send(
      new HeadObjectCommand({
        Bucket: parsed.bucket,
        Key: parsed.key
      })
    );
    if ((response.ContentType ?? "").includes("json") === false && !parsed.key.endsWith(".json")) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    // Read privately; no presigned URL is ever created for reads.
    return JSON.parse(await getArtifactText(uri, 8 * 1024 * 1024)) as HeatmapArtifact;
  } catch {
    return null;
  }
}

function numericStat(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function durationForStage(stage: WorkspaceRunStageState): number | null {
  const statsDuration = numericStat(stage.stats?.durationMs);
  if (statsDuration !== null) {
    return statsDuration;
  }

  const startedAt = timestampMs(stage.startedAt);
  const completedAt = timestampMs(stage.completedAt ?? stage.updatedAt);

  if (startedAt === null || completedAt === null) {
    return null;
  }

  return Math.max(0, completedAt - startedAt);
}

export async function getRunForensics(runId: string, userId: string): Promise<RunForensicsPayload | null> {
  const run = await getRun(runId, userId);
  if (!run) {
    return null;
  }

  const [documents, stageStates, performanceRows, failureRows, chunkRows] = await Promise.all([
    sql<RunDocumentRow[]>`
      select
        id,
        org_id,
        user_id,
        workspace_id,
        run_id,
        filename,
        mime_type,
        source_key,
        status,
        extraction_mode,
        page_count,
        version_number,
        previous_version_id,
        canonical_id,
        superseded_at::text,
        superseded_by_document_id,
        created_at::text,
        updated_at::text
      from documents
      where run_id = ${runId}
      order by created_at asc
    `,
    listRunStageStates(runId, userId),
    sql<PerformanceRow[]>`
      select
        document_id,
        stage_name,
        metric,
        value,
        unit,
        metadata
      from performance_log
      where run_id = ${runId}
    `,
    sql<PageStageFailureRow[]>`
      select document_id, count(*)::int as failed_pages
      from page_stage_states
      where run_id = ${runId} and status = 'failed'
      group by document_id
    `,
    sql<ChunkStatsRow[]>`
      select
        d.id as document_id,
        coalesce(count(distinct c.id), 0)::int as chunk_count,
        coalesce(count(distinct p.id), 0)::int as page_count,
        coalesce(sum(c.token_estimate), 0)::int as token_estimate
      from documents d
      left join document_chunks c on c.document_id = d.id
      left join document_pages p on p.document_id = d.id
      where d.run_id = ${runId}
      group by d.id
    `
  ]);

  const documentRecords = documents.map(mapDocument);
  const documentLookup = new Map(documentRecords.map((document) => [document.id, document]));
  const chunkLookup = new Map(chunkRows.map((row) => [row.document_id, row]));
  const failureLookup = new Map(failureRows.map((row) => [row.document_id, row.failed_pages]));

  const heatmapUris = Object.entries(run.artifacts)
    .filter(([slot]) => slot.endsWith(":heatmap"))
    .map(([slot, uri]) => [slot, uri] as const);

  const heatmaps = await Promise.all(
    heatmapUris.map(async ([slot, uri]) => {
      const slotInfo = parseArtifactSlot(slot);
      return {
        documentId: slotInfo.documentId,
        heatmap: await loadHeatmap(uri)
      };
    })
  );

  const heatmapLookup = new Map<string, HeatmapArtifact>();
  for (const entry of heatmaps) {
    if (entry.documentId && entry.heatmap) {
      heatmapLookup.set(entry.documentId, entry.heatmap);
    }
  }

  const withheld = await loadWithheldArtifactUrisForRun(run.id);
  const artifactEntries = await Promise.all(
    Object.entries(run.artifacts).filter(([, uri]) => !withheld.has(uri)).map(async ([slot, uri]) => {
      const slotInfo = parseArtifactSlot(slot);
      const metadata = await headArtifact(uri);
      const associatedDocument = slotInfo.documentId ? documentLookup.get(slotInfo.documentId) ?? null : null;
      const pageCount = associatedDocument?.pageCount ?? null;
      const estimatedCostCents =
        pageCount && run.pagesTotal > 0
          ? Number(((run.costCents * pageCount) / run.pagesTotal).toFixed(2))
          : 0;

      return {
        slot,
        documentId: slotInfo.documentId,
        artifactName: slotInfo.name,
        category: slotInfo.category,
        stage: slotInfo.stage,
        uri,
        downloadUrl: fileUrlForArtifact(uri).url,
        sizeBytes: metadata.sizeBytes,
        contentType: metadata.contentType,
        pageCount,
        estimatedCostCents
      } satisfies RunArtifactEconomicsEntry;
    })
  );

  const artifactsByDocument = new Map<string, RunArtifactEconomicsEntry[]>();
  for (const artifact of artifactEntries) {
    if (!artifact.documentId) {
      continue;
    }
    const entries = artifactsByDocument.get(artifact.documentId) ?? [];
    entries.push(artifact);
    artifactsByDocument.set(artifact.documentId, entries);
  }

  const plausibilityMetricLookup = new Map<string, number>();
  for (const row of performanceRows) {
    if (row.metric === "extraction-plausibility" && row.document_id) {
      plausibilityMetricLookup.set(row.document_id, row.value);
    }
  }

  const documentEntries: RunDocumentForensicsEntry[] = documentRecords.map((document) => {
    const artifactSet = artifactsByDocument.get(document.id) ?? [];
    const artifactBytes = artifactSet.reduce((total, artifact) => total + (artifact.sizeBytes ?? 0), 0);
    const documentStages = stageStates.filter((stage) => stage.documentId === document.id);
    const heatmap = heatmapLookup.get(document.id);
    const heatmapSummary = summarizeHeatmapPages(heatmap?.pages ?? []);
    const estimatedCostCents =
      run.pagesTotal > 0
        ? Number(((run.costCents * document.pageCount) / run.pagesTotal).toFixed(2))
        : 0;
    const chunkStats = chunkLookup.get(document.id);
    const failedPages = failureLookup.get(document.id) ?? 0;
    const retries = documentStages.reduce((total, stage) => total + Math.max(0, stage.attempts - 1), 0);

    return {
      document,
      pageCount: chunkStats?.page_count ?? document.pageCount,
      chunkCount: chunkStats?.chunk_count ?? 0,
      tokenEstimate: chunkStats?.token_estimate ?? 0,
      artifactBytes,
      artifactCount: artifactSet.length,
      estimatedCostCents,
      retries,
      failedPages,
      plausibilityScore:
        heatmapSummary.averagePlausibilityScore ??
        plausibilityMetricLookup.get(document.id) ??
        null,
      lowPlausibilityPages: heatmapSummary.lowPlausibilityPages,
      strategy: heatmapSummary.strategy
    };
  });

  // The worker records run-scoped stage resources as stage-cpu-user/-system (ms)
  // and stage-rss-peak (absolute bytes); see worker/src/lib/perf-context.ts.
  const stageResources = summarizeStageResources(
    performanceRows
      .filter((row) => row.document_id === null)
      .map((row) => ({ stage_name: row.stage_name, metric: row.metric, total: row.value, peak: row.value })),
  ).byStage;
  const stageCpuMs = (stage: string) => stageResources[stage]?.cpuMs ?? null;
  const stageMemoryMb = (stage: string) => {
    const bytes = stageResources[stage]?.peakRssBytes ?? 0;
    return bytes > 0 ? Number((bytes / (1024 * 1024)).toFixed(1)) : null;
  };

  const timeline = stageStates
    .map((stage) => {
      const document = stage.documentId ? documentLookup.get(stage.documentId) ?? null : null;
      return {
        stage: stage.stage,
        scope: stage.documentId ? "document" : "run",
        documentId: stage.documentId ?? null,
        documentFilename: document?.filename ?? null,
        status: stage.status,
        attempts: stage.attempts,
        retries: Math.max(0, stage.attempts - 1),
        durationMs: durationForStage(stage),
        startedAt: stage.startedAt,
        completedAt: stage.completedAt,
        updatedAt: stage.updatedAt,
        failedPages: stage.documentId ? failureLookup.get(stage.documentId) ?? 0 : 0,
        cpuMs: stage.documentId ? null : stageCpuMs(stage.stage),
        memoryMb: stage.documentId ? null : stageMemoryMb(stage.stage)
      } satisfies RunForensicsTimelineEntry;
    })
    .sort((left, right) => {
      const leftMs = timestampMs(left.startedAt ?? left.updatedAt) ?? 0;
      const rightMs = timestampMs(right.startedAt ?? right.updatedAt) ?? 0;
      return leftMs - rightMs;
    });

  const strategyRollup = new Map<string, { documents: number; pages: number; plausibilityTotal: number }>();
  for (const document of documentEntries) {
    if (!document.strategy || document.plausibilityScore === null) {
      continue;
    }

    const existing = strategyRollup.get(document.strategy) ?? { documents: 0, pages: 0, plausibilityTotal: 0 };
    existing.documents += 1;
    existing.pages += document.pageCount;
    existing.plausibilityTotal += document.plausibilityScore;
    strategyRollup.set(document.strategy, existing);
  }

  const totalArtifactBytes = artifactEntries.reduce((total, artifact) => total + (artifact.sizeBytes ?? 0), 0);
  const totalRetries = timeline.reduce((total, entry) => total + entry.retries, 0);
  const failedPages = documentEntries.reduce((total, document) => total + document.failedPages, 0);
  const plausibilityDocuments = documentEntries.filter((document) => document.plausibilityScore !== null);
  const totalCostCents = run.costCents;

  return {
    run,
    summary: {
      totalCostCents,
      estimatedCostPerDocumentCents:
        documentEntries.length > 0 ? Number((totalCostCents / documentEntries.length).toFixed(2)) : 0,
      totalArtifactBytes,
      artifactBytesPerPage:
        run.pagesTotal > 0 ? Number((totalArtifactBytes / Math.max(1, run.pagesTotal)).toFixed(2)) : 0,
      totalRetries,
      failedPages,
      averagePlausibilityScore:
        plausibilityDocuments.length > 0
          ? plausibilityDocuments.reduce((total, document) => total + (document.plausibilityScore ?? 0), 0) / plausibilityDocuments.length
          : null,
      lowPlausibilityPages: documentEntries.reduce((total, document) => total + document.lowPlausibilityPages, 0),
      strategyBreakdown: Array.from(strategyRollup.entries())
        .map(([strategy, stats]) => ({
          strategy,
          documents: stats.documents,
          pages: stats.pages,
          averagePlausibilityScore:
            stats.documents > 0 ? stats.plausibilityTotal / stats.documents : 0
        }))
        .sort((left, right) => right.documents - left.documents)
    },
    timeline,
    artifacts: artifactEntries.sort((left, right) => (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0)),
    documents: documentEntries.sort((left, right) => {
      const leftSeverity = left.lowPlausibilityPages * 100 + left.failedPages * 50 + left.retries * 10;
      const rightSeverity = right.lowPlausibilityPages * 100 + right.failedPages * 50 + right.retries * 10;
      return rightSeverity - leftSeverity;
    })
  };
}
