import {
  defaultPipelineFeatures,
  parserPlaybookCatalog,
  runProcessingPreviewRequestSchema,
  runProcessingPreviewSchema,
  visionModelCatalogByUri,
  type ParserPlaybookKey,
  type PipelineFeatures,
  type RunProcessingPreview,
  type RunProcessingPreviewRequest,
  type RunProcessingPreviewScenario,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { getWorkspaceAccess } from "./organizations.js";

type PreviewSourceDescriptor = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: "file" | "url";
};

export type RunPreviewHistoryRow = {
  parser_playbook: string | null;
  completed_runs: number;
  sampled_documents: number;
  avg_plausibility_score: number | null;
  avg_seconds_per_page: number | null;
};

function normalizePreviewSources(
  request: RunProcessingPreviewRequest,
): PreviewSourceDescriptor[] {
  const files = request.files.map((file) => ({
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    kind: "file" as const,
  }));
  const urls = request.urls.map((entry) => {
    const url = new URL(entry.url);
    const pathname =
      url.pathname.split("/").filter(Boolean).pop() ?? url.hostname;
    return {
      filename: pathname || url.hostname,
      mimeType: "remote/url",
      sizeBytes: 0,
      kind: "url" as const,
    };
  });
  return [...files, ...urls];
}

function estimatePreviewPageCount(source: PreviewSourceDescriptor): number {
  const name = source.filename.toLowerCase();
  const mimeType = source.mimeType.toLowerCase();
  const sizeBytes = Math.max(0, source.sizeBytes);
  const sizeKb = sizeBytes / 1024;
  const sizeMb = sizeBytes / (1024 * 1024);

  if (source.kind === "url") {
    return 4;
  }

  if (mimeType === "application/pdf" || name.endsWith(".pdf")) {
    return Math.max(1, Math.round(sizeKb / 180));
  }

  if (mimeType.startsWith("image/")) {
    return 1;
  }

  if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) {
    return 1;
  }

  if (
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    name.endsWith(".csv") ||
    name.endsWith(".tsv") ||
    name.endsWith(".xlsx")
  ) {
    return Math.max(1, Math.round(sizeKb / 80));
  }

  if (
    mimeType.includes("word") ||
    mimeType.includes("officedocument.wordprocessingml") ||
    name.endsWith(".docx") ||
    name.endsWith(".doc") ||
    name.endsWith(".epub")
  ) {
    return Math.max(1, Math.round(Math.max(sizeMb, 0.1) * 6));
  }

  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/x-ndjson" ||
    mimeType === "application/xml" ||
    mimeType === "application/x-yaml" ||
    name.endsWith(".md") ||
    name.endsWith(".txt")
  ) {
    return Math.max(1, Math.round(sizeKb / 24));
  }

  return Math.max(1, Math.round(Math.max(sizeMb, 0.1) * 3));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function qualityLabel(
  score: number,
): RunProcessingPreviewScenario["estimatedQualityLabel"] {
  if (score >= 0.85) {
    return "strong";
  }
  if (score >= 0.72) {
    return "good";
  }
  if (score >= 0.58) {
    return "watch";
  }
  return "risky";
}

function estimateComplexitySignals(sources: PreviewSourceDescriptor[]): {
  targetQuality: number;
  topSignals: string[];
  tableHeavy: boolean;
  scanHeavy: boolean;
  mediaHeavy: boolean;
} {
  let tableHeavy = false;
  let scanHeavy = false;
  let mediaHeavy = false;
  let proseHeavy = false;
  let codeHeavy = false;
  const signalSet = new Set<string>();

  for (const source of sources) {
    const name = source.filename.toLowerCase();
    const mimeType = source.mimeType.toLowerCase();

    if (
      mimeType.includes("spreadsheet") ||
      mimeType.includes("excel") ||
      name.endsWith(".csv") ||
      name.endsWith(".tsv") ||
      /invoice|statement|ledger|form|schedule|table/.test(name)
    ) {
      tableHeavy = true;
      signalSet.add("table-heavy inputs favor layout-aware extraction");
    }

    if (
      mimeType.startsWith("image/") ||
      /scan|ocr|receipt|fax|handwritten/.test(name) ||
      (mimeType === "application/pdf" && source.sizeBytes > 8 * 1024 * 1024)
    ) {
      scanHeavy = true;
      signalSet.add(
        "scan-like inputs raise the quality bar for fallback vision",
      );
    }

    if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) {
      mediaHeavy = true;
      signalSet.add("media sources typically need richer multimodal handling");
    }

    if (
      mimeType.startsWith("text/") ||
      name.endsWith(".docx") ||
      name.endsWith(".md") ||
      name.endsWith(".html")
    ) {
      proseHeavy = true;
    }

    if (
      /(^|\.)(ts|tsx|js|jsx|py|java|go|rs|rb|json|yaml|yml)$/.test(name) ||
      /api|schema|spec|code/.test(name)
    ) {
      codeHeavy = true;
      signalSet.add("code-like sources benefit from preserving syntax exactly");
    }
  }

  let targetQuality = 0.72;
  if (tableHeavy) {
    targetQuality += 0.05;
  }
  if (scanHeavy) {
    targetQuality += 0.06;
  }
  if (mediaHeavy) {
    targetQuality += 0.07;
  }
  if (codeHeavy) {
    targetQuality += 0.03;
  }
  if (proseHeavy && !tableHeavy && !scanHeavy && !mediaHeavy) {
    signalSet.add("mostly prose documents can stay on a cheaper path");
  }

  return {
    targetQuality: clamp(targetQuality, 0.68, 0.9),
    topSignals: [...signalSet].slice(0, 4),
    tableHeavy,
    scanHeavy,
    mediaHeavy,
  };
}

type PreviewHistorySummary = {
  completedRuns: number;
  sampledDocuments: number;
  averagePlausibilityScore: number | null;
  averageLatencyMinutes: number | null;
  byPlaybook: Partial<
    Record<
      ParserPlaybookKey,
      {
        sampledDocuments: number;
        averagePlausibilityScore: number | null;
        averageSecondsPerPage: number | null;
      }
    >
  >;
};

function summarizePreviewHistory(
  rows: RunPreviewHistoryRow[],
): PreviewHistorySummary {
  const byPlaybook: PreviewHistorySummary["byPlaybook"] = {};
  let completedRuns = 0;
  let sampledDocuments = 0;
  let weightedPlausibilityTotal = 0;
  let weightedPlausibilityDocs = 0;
  let weightedSecondsPerPage = 0;
  let weightedLatencyDocs = 0;

  for (const row of rows) {
    const playbook = (row.parser_playbook ?? "balanced") as ParserPlaybookKey;
    completedRuns += row.completed_runs;
    sampledDocuments += row.sampled_documents;
    if (playbook in parserPlaybookCatalog) {
      byPlaybook[playbook] = {
        sampledDocuments: row.sampled_documents,
        averagePlausibilityScore: row.avg_plausibility_score,
        averageSecondsPerPage: row.avg_seconds_per_page,
      };
    }
    if (typeof row.avg_plausibility_score === "number") {
      weightedPlausibilityTotal +=
        row.avg_plausibility_score * row.sampled_documents;
      weightedPlausibilityDocs += row.sampled_documents;
    }
    if (typeof row.avg_seconds_per_page === "number") {
      weightedSecondsPerPage +=
        row.avg_seconds_per_page * row.sampled_documents;
      weightedLatencyDocs += row.sampled_documents;
    }
  }

  return {
    completedRuns,
    sampledDocuments,
    averagePlausibilityScore:
      weightedPlausibilityDocs > 0
        ? weightedPlausibilityTotal / weightedPlausibilityDocs
        : null,
    averageLatencyMinutes:
      weightedLatencyDocs > 0
        ? weightedSecondsPerPage / weightedLatencyDocs / 60
        : null,
    byPlaybook,
  };
}

function estimateScenario(args: {
  parserPlaybook: ParserPlaybookKey;
  pipeline: PipelineFeatures;
  estimatedPages: number;
  documentCount: number;
  signals: ReturnType<typeof estimateComplexitySignals>;
  history: PreviewHistorySummary;
}): RunProcessingPreviewScenario {
  const pagesPerDollar = (costCentsPer100Pages: number) =>
    Math.round(10000 / costCentsPer100Pages);
  const playbook = parserPlaybookCatalog[args.parserPlaybook];
  const modelCostPerPage =
    visionModelCatalogByUri[args.pipeline.vision.modelUri]
      ?.estimatedCostPerPageCents ?? 0.3;
  const fallbackCostPerPage = args.pipeline.vision.remoteFallbackModelUri
    ? (visionModelCatalogByUri[args.pipeline.vision.remoteFallbackModelUri]
        ?.estimatedCostPerPageCents ?? modelCostPerPage)
    : modelCostPerPage;
  const historyForPlaybook = args.history.byPlaybook[args.parserPlaybook];
  const extractionCost =
    (playbook.est.costCentsPer100Pages / 100) * args.estimatedPages;
  const embeddingCost = args.pipeline.embed ? args.estimatedPages * 0.002 : 0;
  const overheadCost = args.documentCount * 0.01;
  const visionShare = {
    fast: 0.03,
    balanced: 0.1,
    "layout-aware": 0.16,
    agentic: 0.24,
    "review-grade": 0.32,
  }[args.parserPlaybook];
  const expectedVisionCost = args.pipeline.visionFallback
    ? args.estimatedPages *
      visionShare *
      Math.max(modelCostPerPage, fallbackCostPerPage)
    : 0;

  const baseQuality = {
    fast: 0.57,
    balanced: 0.72,
    "layout-aware": 0.82,
    agentic: 0.86,
    "review-grade": 0.9,
  }[args.parserPlaybook];
  let quality = baseQuality;

  if (args.signals.tableHeavy) {
    quality +=
      args.parserPlaybook === "layout-aware" ||
      args.parserPlaybook === "review-grade"
        ? 0.05
        : -0.08;
  }
  if (args.signals.scanHeavy) {
    quality +=
      args.parserPlaybook === "fast"
        ? -0.16
        : args.parserPlaybook === "balanced"
          ? -0.08
          : 0.02;
  }
  if (args.signals.mediaHeavy) {
    quality += args.parserPlaybook === "review-grade" ? 0.03 : -0.05;
  }
  quality = clamp(quality, 0.3, 0.97);

  const baseLatencyMinutes =
    ((playbook.est.latencySecPer100Pages / 100) * args.estimatedPages) / 60;
  let estimatedLatencyMinutes = baseLatencyMinutes;
  if (typeof historyForPlaybook?.averageSecondsPerPage === "number") {
    const historicalLatencyMinutes =
      (historyForPlaybook.averageSecondsPerPage * args.estimatedPages) / 60;
    estimatedLatencyMinutes =
      baseLatencyMinutes * 0.55 + historicalLatencyMinutes * 0.45;
  }

  const confidence = clamp(
    0.45 +
      (Math.min(args.history.sampledDocuments, 40) / 40) * 0.25 +
      (Math.min(args.documentCount, 10) / 10) * 0.1,
    0.45,
    0.9,
  );

  const reasoning = [
    `${playbook.label} targets about ${playbook.est.latencySecPer100Pages}s per 100 pages and roughly $1 = ${pagesPerDollar(playbook.est.costCentsPer100Pages).toLocaleString()} pages.`,
    ...args.signals.topSignals.slice(0, 2),
    historyForPlaybook?.sampledDocuments
      ? `Workspace history has ${historyForPlaybook.sampledDocuments} sampled docs for this profile.`
      : "No matching workspace history yet, so this recommendation leans on file metadata.",
  ].filter(Boolean);

  return {
    parserPlaybook: args.parserPlaybook,
    label: playbook.label,
    estimatedCost: {
      minCents:
        Math.round(
          (extractionCost * 0.85 + embeddingCost + overheadCost) * 100,
        ) / 100,
      maxCents:
        Math.round(
          (extractionCost * 1.15 +
            embeddingCost +
            overheadCost +
            expectedVisionCost) *
            100,
        ) / 100,
    },
    estimatedLatencyMinutes: Math.round(estimatedLatencyMinutes * 100) / 100,
    estimatedQualityScore: Math.round(quality * 100) / 100,
    estimatedQualityLabel: qualityLabel(quality),
    confidence: Math.round(confidence * 100) / 100,
    reasoning,
    recommended: false,
  };
}

export function buildRunProcessingPreview(args: {
  request: RunProcessingPreviewRequest;
  historyRows?: RunPreviewHistoryRow[];
}): RunProcessingPreview {
  const request = runProcessingPreviewRequestSchema.parse(args.request);
  const sources = normalizePreviewSources(request);
  const estimatedPages = Math.max(
    1,
    sources.reduce(
      (total, source) => total + estimatePreviewPageCount(source),
      0,
    ),
  );
  const totalBytes = sources.reduce(
    (total, source) => total + source.sizeBytes,
    0,
  );
  const pipeline = request.pipeline ?? defaultPipelineFeatures;
  const history = summarizePreviewHistory(args.historyRows ?? []);
  const signals = estimateComplexitySignals(sources);

  const candidatePlaybooks = new Set<ParserPlaybookKey>([
    "fast",
    "balanced",
    "layout-aware",
    "review-grade",
    pipeline.parserPlaybook,
  ]);
  if (signals.mediaHeavy) {
    candidatePlaybooks.add("agentic");
  }

  const options = [...candidatePlaybooks]
    .map((parserPlaybook) =>
      estimateScenario({
        parserPlaybook,
        pipeline: {
          ...pipeline,
          parserPlaybook,
        },
        estimatedPages,
        documentCount: sources.length,
        signals,
        history,
      }),
    )
    .sort(
      (left, right) =>
        left.estimatedCost.maxCents - right.estimatedCost.maxCents,
    );

  const current =
    options.find(
      (option) => option.parserPlaybook === pipeline.parserPlaybook,
    ) ?? options[0]!;
  const recommendedBase =
    options.find(
      (option) => option.estimatedQualityScore >= signals.targetQuality,
    ) ??
    options.reduce(
      (best, option) =>
        option.estimatedQualityScore > best.estimatedQualityScore
          ? option
          : best,
      options[0]!,
    );
  const recommended: RunProcessingPreviewScenario = {
    ...recommendedBase,
    recommended: true,
  };

  return runProcessingPreviewSchema.parse({
    documentCount: sources.length,
    estimatedPages,
    totalBytes,
    topSignals: signals.topSignals,
    history: {
      completedRuns: history.completedRuns,
      sampledDocuments: history.sampledDocuments,
      averagePlausibilityScore:
        history.averagePlausibilityScore === null
          ? null
          : Math.round(history.averagePlausibilityScore * 100) / 100,
      averageLatencyMinutes:
        history.averageLatencyMinutes === null
          ? null
          : Math.round(history.averageLatencyMinutes * estimatedPages * 100) /
            100,
    },
    current,
    recommended,
    options: options.map((option) => ({
      ...option,
      recommended: option.parserPlaybook === recommended.parserPlaybook,
    })),
  });
}

export async function getRunProcessingPreview(
  request: RunProcessingPreviewRequest & { workspaceId: string },
  userId: string,
): Promise<RunProcessingPreview> {
  // Callers resolve the workspace reference first (requireActorWorkspace).
  const parsed = { ...runProcessingPreviewRequestSchema.parse(request), workspaceId: request.workspaceId };
  const access = await getWorkspaceAccess(parsed.workspaceId, userId);
  if (!access) {
    throw new Error("Workspace not found");
  }

  const historyRows = await sql<RunPreviewHistoryRow[]>`
    select
      coalesce(runs.pipeline->>'parserPlaybook', 'balanced') as parser_playbook,
      count(distinct runs.id)::int as completed_runs,
      count(distinct d.id)::int as sampled_documents,
      avg(nullif(drss.stats->>'plausibilityScore', '')::numeric)::float8 as avg_plausibility_score,
      avg(
        extract(epoch from (runs.updated_at - runs.created_at))
        / greatest(nullif(runs.pages_total, 0), greatest(d.page_count, 1))
      )::float8 as avg_seconds_per_page
    from workspace_runs runs
    join documents d on d.run_id = runs.id
    left join document_run_stage_states drss
      on drss.run_id = runs.id
      and drss.document_id = d.id
      and drss.stage_name = 'extract-markdown'
      and drss.status = 'completed'
    where runs.workspace_id = ${parsed.workspaceId}
      and runs.status = 'completed'
      and d.status = 'completed'
      and runs.created_at > now() - interval '90 days'
    group by coalesce(runs.pipeline->>'parserPlaybook', 'balanced')
  `;

  return buildRunProcessingPreview({
    request: parsed,
    historyRows,
  });
}
