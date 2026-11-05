import {
  defaultPipelineFeatures,
  detectFileFormat,
  estimateProfileFor,
  parserPlaybookCatalog,
  parserPlaybookForQuality,
  QUALITY_MODE_ORDER,
  QUALITY_MODES,
  qualityModeSchema,
  quoteFilePages,
  quoteUpload,
  runProcessingPreviewRequestSchema,
  runProcessingPreviewSchema,
  type PipelineFeatures,
  type QuoteFile,
  type QualityMode,
  type RunProcessingPreview,
  type RunProcessingPreviewRequest,
  type RunProcessingPreviewScenario,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { getProjectAccess } from "./organizations.js";

function uploadMediaKindOf(file: QuoteFile): boolean {
  const format = detectFileFormat({ filename: file.name, mimeType: file.type });
  return format === "audio" || format === "video";
}

type PreviewSourceDescriptor = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Counted pages, when the caller has them. */
  pages?: number;
  kind: "file" | "url";
};

/** A web page ingested from a URL: its size is unknown until fetched, so it is priced as a few pages of HTML. */
const ASSUMED_URL_PAGES = 4;

export type RunPreviewHistoryRow = {
  quality: string | null;
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
    ...(file.pages !== undefined ? { pages: file.pages } : {}),
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

/** The quote's view of a source: pricing, pages and ranges all come from `quoteUpload`, the one place upload prices are decided. */
function quoteFileOf(source: PreviewSourceDescriptor): QuoteFile {
  if (source.kind === "url") return { name: source.filename, size: source.sizeBytes, type: "text/html", pages: ASSUMED_URL_PAGES };
  return {
    name: source.filename,
    size: source.sizeBytes,
    type: source.mimeType,
    ...(source.pages !== undefined ? { pages: source.pages } : {}),
  };
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

/**
 * What the sources are, from their format (the same table intake uses), never from words in a filename. A PDF is
 * scan-like only when its counted pages carry a photograph's worth of bytes each.
 */
const SCAN_LIKE_BYTES_PER_PAGE = 200 * 1024;

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
    if (source.kind === "url") continue;
    const format = detectFileFormat({ filename: source.filename, mimeType: source.mimeType });

    if (format === "structured-csv" || format === "office-excel") {
      tableHeavy = true;
      signalSet.add("table-heavy inputs favor layout-aware extraction");
    }

    if (format === "image" || (format === "pdf" && source.pages && source.sizeBytes / source.pages > SCAN_LIKE_BYTES_PER_PAGE)) {
      scanHeavy = true;
      signalSet.add(
        "scan-like inputs raise the quality bar for fallback vision",
      );
    }

    if (format === "audio" || format === "video") {
      mediaHeavy = true;
      signalSet.add("media sources typically need richer multimodal handling");
    }

    if (format === "plain-text" || format === "markdown" || format === "html" || format === "office-word") {
      proseHeavy = true;
    }

    if (format === "structured-json") {
      codeHeavy = true;
      signalSet.add("structured data sources benefit from preserving syntax exactly");
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
  byQuality: Partial<
    Record<
      QualityMode,
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
  const byQuality: PreviewHistorySummary["byQuality"] = {};
  let completedRuns = 0;
  let sampledDocuments = 0;
  let weightedPlausibilityTotal = 0;
  let weightedPlausibilityDocs = 0;
  let weightedSecondsPerPage = 0;
  let weightedLatencyDocs = 0;

  for (const row of rows) {
    const quality = qualityModeSchema.safeParse(row.quality ?? "auto");
    completedRuns += row.completed_runs;
    sampledDocuments += row.sampled_documents;
    if (quality.success) {
      byQuality[quality.data] = {
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
    byQuality,
  };
}

const BASE_QUALITY: Record<QualityMode, number> = { fast: 0.57, auto: 0.76, good: 0.9 };

function estimateScenario(args: {
  quality: QualityMode;
  pipeline: PipelineFeatures;
  estimatedPages: number;
  documentCount: number;
  files: QuoteFile[];
  signals: ReturnType<typeof estimateComplexitySignals>;
  history: PreviewHistorySummary;
}): RunProcessingPreviewScenario {
  const mode = QUALITY_MODES[args.quality];
  const playbook = parserPlaybookCatalog[parserPlaybookForQuality(args.quality)];
  const historyForQuality = args.history.byQuality[args.quality];
  // Customer price in credits (= cents) from PRICE_CARD, by the same quote an upload gets: counted pages price exactly, uncounted
  // ones over the range their size allows, with the high end every page read by a vision model.
  const profile = { ...estimateProfileFor({ ...args.pipeline, quality: args.quality }, { env: process.env }), billing: "enforced" as const };
  const quoted = quoteUpload({ files: args.files, profile, speedBoost: args.pipeline.speedBoost }).estimate.credits ?? { low: 0, high: 0 };
  const minCents = quoted.low;
  const maxCents = Math.max(minCents, quoted.high);

  let quality = BASE_QUALITY[args.quality];
  if (args.signals.tableHeavy) quality += args.quality === "fast" ? -0.08 : args.quality === "good" ? 0.05 : 0.02;
  if (args.signals.scanHeavy) quality += args.quality === "fast" ? -0.2 : args.quality === "good" ? 0.04 : 0;
  if (args.signals.mediaHeavy) quality += args.quality === "good" ? 0.03 : -0.05;
  quality = clamp(quality, 0.3, 0.97);

  const baseLatencyMinutes =
    ((playbook.est.latencySecPer100Pages / 100) * args.estimatedPages) / 60;
  let estimatedLatencyMinutes = baseLatencyMinutes;
  if (typeof historyForQuality?.averageSecondsPerPage === "number") {
    const historicalLatencyMinutes =
      (historyForQuality.averageSecondsPerPage * args.estimatedPages) / 60;
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
    mode.description,
    ...args.signals.topSignals.slice(0, 2),
    historyForQuality?.sampledDocuments
      ? `Project history has ${historyForQuality.sampledDocuments} sampled docs at this quality.`
      : "No matching project history yet, so this recommendation leans on file metadata.",
  ].filter(Boolean);

  return {
    quality: args.quality,
    label: mode.label,
    estimatedCost: {
      minCents: Math.round(minCents * 100) / 100,
      maxCents: Math.round(maxCents * 100) / 100,
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
  const files = sources.map(quoteFileOf);
  const estimatedPages = Math.max(
    1,
    files.reduce((total, file) => total + (uploadMediaKindOf(file) ? 1 : quoteFilePages(file)), 0),
  );
  const totalBytes = sources.reduce(
    (total, source) => total + source.sizeBytes,
    0,
  );
  const pipeline = { ...(request.pipeline ?? defaultPipelineFeatures), speedBoost: request.speedBoost === true };
  const history = summarizePreviewHistory(args.historyRows ?? []);
  const signals = estimateComplexitySignals(sources);

  const options = QUALITY_MODE_ORDER.map((quality) =>
    estimateScenario({
      quality,
      pipeline,
      estimatedPages,
      documentCount: sources.length,
      files,
      signals,
      history,
    }),
  );

  const current =
    options.find((option) => option.quality === pipeline.quality) ??
    options[0]!;
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
      recommended: option.quality === recommended.quality,
    })),
  });
}

export async function getRunProcessingPreview(
  request: RunProcessingPreviewRequest & { projectId: string },
  userId: string,
): Promise<RunProcessingPreview> {
  // Callers resolve the project reference first (requireActorProject).
  const parsed = { ...runProcessingPreviewRequestSchema.parse(request), projectId: request.projectId };
  const access = await getProjectAccess(parsed.projectId, userId);
  if (!access) {
    throw new Error("Project not found");
  }

  const historyRows = await sql<RunPreviewHistoryRow[]>`
    select
      -- Runs stored before pipeline.quality carry the retired parserPlaybook / vision.forceAllPages keys.
      coalesce(
        runs.pipeline->>'quality',
        case
          when runs.pipeline->'vision'->>'forceAllPages' = 'true' or runs.pipeline->>'parserPlaybook' = 'review-grade' then 'good'
          when runs.pipeline->>'parserPlaybook' = 'fast' then 'fast'
          else 'auto'
        end
      ) as quality,
      count(distinct runs.id)::int as completed_runs,
      count(distinct d.id)::int as sampled_documents,
      avg(nullif(drss.stats->>'plausibilityScore', '')::numeric)::float8 as avg_plausibility_score,
      avg(
        extract(epoch from (runs.updated_at - runs.created_at))
        / greatest(nullif(runs.pages_total, 0), greatest(d.page_count, 1))
      )::float8 as avg_seconds_per_page
    from project_runs runs
    join documents d on d.run_id = runs.id
    left join document_run_stage_states drss
      on drss.run_id = runs.id
      and drss.document_id = d.id
      and drss.stage_name = 'extract-markdown'
      and drss.status = 'completed'
    where runs.project_id = ${parsed.projectId}
      and runs.status = 'completed'
      and d.status = 'completed'
      and runs.created_at > now() - interval '90 days'
    group by 1
  `;

  return buildRunProcessingPreview({
    request: parsed,
    historyRows,
  });
}
