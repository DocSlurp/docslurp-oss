import { randomUUID } from "node:crypto";
import { splitTextIntoPages as splitDocumentPages } from "@docslurp/shared";

import { sql } from "../db.js";
import { getArtifactJson, getArtifactText } from "../lib/artifacts.js";
import { listAccessibleWorkspaceIds } from "./organizations.js";
import { getDocumentViewerPayload, setDocumentTags } from "./documents.js";
import { runUsageCostSummaries } from "./usage-attribution.js";

type ReviewDocumentRow = {
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
  version_number: number;
  previous_version_id: string | null;
  created_at: string;
  updated_at: string;
};

type ReviewSignalRow = {
  document_id: string;
  plausibility_score: number | null;
  retries: number;
  failed_stages: number;
  schema_errors: number;
  failed_stage_names: string[] | null;
};

type RunCostRow = {
  id: string;
  total_documents: number;
};

type CorrectionRow = {
  id: string;
  document_id: string;
  run_id: string | null;
  user_id: string;
  corrected_markdown: string | null;
  corrected_structured_data: Record<string, unknown> | null;
  notes: string | null;
  reindex_requested_at: string | null;
  reindex_completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type CorrectionProfileHistoryRow = {
  document_id: string;
  workspace_id: string;
  filename: string;
  mime_type: string;
  extraction_mode: string;
  page_count: number;
  correction_id: string;
  corrected_markdown: string | null;
  corrected_structured_data: Record<string, unknown> | null;
  notes: string | null;
  reindex_requested_at: string | null;
  reindex_completed_at: string | null;
  correction_created_at: string;
  correction_updated_at: string;
  plausibility_score: number | null;
  retries: number;
  failed_stages: number;
  schema_errors: number;
  failed_stage_names: string[] | null;
};

type ChunkInsertRow = {
  id: string;
  document_id: string;
  run_id: string;
  user_id: string;
  chunk_index: number;
  text: string;
  heading_path: string[];
  page_number: number;
  token_estimate: number;
  metadata: Record<string, unknown>;
};

type PageInsertRow = {
  id: string;
  document_id: string;
  run_id: string;
  user_id: string;
  page_number: number;
  text: string;
  token_estimate: number;
};

export interface ReviewQueueEntry {
  document: {
    id: string;
    orgId: string;
    workspaceId: string;
    runId: string | null;
    filename: string;
    mimeType: string;
    status: string;
    pageCount: number;
    createdAt: string;
    updatedAt: string;
  };
  severityScore: number;
  estimatedCostCents: number;
  plausibilityScore: number | null;
  retries: number;
  failedStages: number;
  schemaErrors: number;
  failureModes: string[];
  correctionState: "open" | "corrected" | "reindexed";
  correctionUpdatedAt: string | null;
}

export interface CorrectionWorkbenchPayload {
  documentId: string;
  originalMarkdown: string | null;
  originalStructuredData: Record<string, unknown> | null;
  tags: string[];
  correction: {
    markdown: string | null;
    structuredData: Record<string, unknown> | null;
    notes: string | null;
    reindexRequestedAt: string | null;
    reindexCompletedAt: string | null;
    updatedAt: string | null;
  } | null;
  profile: CorrectionProfileSummary;
}

export interface CorrectionProfileSummary {
  profileKey: string;
  workspaceId: string;
  documentType: {
    key: string;
    label: string;
  };
  summary: {
    correctedDocuments: number;
    reindexedDocuments: number;
    pendingReindexDocuments: number;
    lastCorrectedAt: string | null;
  };
  recurringFailureModes: CorrectionProfileFailureMode[];
  correctionPatterns: CorrectionProfileSignal[];
  currentDocumentSignals: string[];
  examples: CorrectionProfileExample[];
}

export interface CorrectionProfileFailureMode {
  code: string;
  label: string;
  count: number;
  share: number;
  lastSeenAt: string;
  exampleDocumentIds: string[];
}

export interface CorrectionProfileSignal {
  key: string;
  label: string;
  count: number;
  lastSeenAt: string;
  exampleDocumentIds: string[];
}

export interface CorrectionProfileExample {
  documentId: string;
  filename: string;
  plausibilityScore: number | null;
  correctionState: "corrected" | "reindexed";
  updatedAt: string;
  reindexedAt: string | null;
  pageCount: number;
  failureModes: string[];
  signalKeys: string[];
  noteExcerpt: string | null;
  correctedMarkdownPreview: string | null;
  structuredDataKeys: string[];
  isCurrentDocument: boolean;
}

const failureModeLabels: Record<string, string> = {
  low_plausibility: "Low text plausibility",
  retries: "Repeated retries",
  stage_failure: "Stage failure",
  schema_validation: "Schema validation issues"
};

const correctionSignalLabels: Record<string, string> = {
  markdown_rewrite: "Corrected markdown saved",
  structured_patch: "Structured fields patched",
  table_structure: "Table structure repaired",
  list_cleanup: "Lists and numbering cleaned up",
  page_segmentation: "Page or section boundaries restored",
  schema_repair: "Schema-shaped extraction repaired",
  ocr_cleanup: "OCR text cleanup",
  layout_repair: "Layout or column ordering fixed"
};

function tokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function splitMarkdownIntoPages(markdown: string, pageCount?: number): string[] {
  return splitDocumentPages(markdown, pageCount);
}

export function chunkCorrectionPage(pageText: string, chunkSize = 1200): string[] {
  const normalized = pageText.trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > chunkSize && current) {
      chunks.push(current);
      current = paragraph;
      continue;
    }
    current = candidate;
  }

  if (current) {
    chunks.push(current);
  }

  if (chunks.length === 0) {
    return [normalized];
  }

  return chunks;
}

function normalizeCorrectionText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function clipText(text: string | null | undefined, maxLength: number): string | null {
  const normalized = normalizeCorrectionText(text);
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function hasStructuredData(value: Record<string, unknown> | null | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0);
}

function inferDocumentExtension(filename: string): string {
  const [, extension = ""] = filename.toLowerCase().match(/\.([a-z0-9]+)$/) ?? [];
  return extension;
}

export function classifyCorrectionDocumentType(input: {
  filename: string;
  mimeType: string;
  extractionMode?: string | null;
}): { key: string; label: string } {
  const mime = input.mimeType.toLowerCase();
  const extension = inferDocumentExtension(input.filename);

  if (mime.includes("pdf") || extension === "pdf") {
    return { key: "pdf", label: "PDF documents" };
  }
  if (mime.startsWith("image/")) {
    return { key: "image", label: "Images" };
  }
  if (mime.startsWith("audio/")) {
    return { key: "audio", label: "Audio" };
  }
  if (mime.startsWith("video/")) {
    return { key: "video", label: "Video" };
  }
  if (
    ["csv", "tsv", "xls", "xlsx", "ods"].includes(extension) ||
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime.includes("csv")
  ) {
    return { key: "spreadsheet", label: "Spreadsheets" };
  }
  if (
    ["ppt", "pptx", "key"].includes(extension) ||
    mime.includes("presentation") ||
    mime.includes("powerpoint")
  ) {
    return { key: "presentation", label: "Presentations" };
  }
  if (["epub", "mobi"].includes(extension) || mime.includes("epub")) {
    return { key: "ebook", label: "Ebooks" };
  }
  if (["eml", "msg"].includes(extension) || mime.includes("message/")) {
    return { key: "email", label: "Email" };
  }
  if (["html", "htm"].includes(extension) || mime.includes("html")) {
    return { key: "html", label: "HTML pages" };
  }
  if (
    ["doc", "docx", "odt", "rtf", "txt", "md"].includes(extension) ||
    mime.includes("word") ||
    mime.includes("officedocument.wordprocessingml") ||
    mime.startsWith("text/")
  ) {
    return { key: "text-document", label: "Text documents" };
  }
  if (input.extractionMode?.toLowerCase() === "vision") {
    return { key: "vision-first", label: "Vision-routed documents" };
  }
  return { key: "other", label: "Other documents" };
}

function buildCorrectionProfileKey(workspaceId: string, documentTypeKey: string): string {
  return `${workspaceId}:${documentTypeKey}`;
}

function getStageFailureLabel(stageName: string): string {
  return `${stageName.replace(/-/g, " ")} failed`;
}

export function buildReviewFailureModes(
  input: {
    plausibilityScore: number | null;
    retries: number;
    failedStages: number;
    schemaErrors: number;
    failedStageNames?: string[] | null;
  },
  options?: {
    includeStageNames?: boolean;
  }
): string[] {
  const modes = [
    input.plausibilityScore !== null && input.plausibilityScore < 0.65
      ? "low_plausibility"
      : null,
    input.retries > 0 ? "retries" : null,
    input.failedStages > 0 ? "stage_failure" : null,
    input.schemaErrors > 0 ? "schema_validation" : null
  ].filter((value): value is string => Boolean(value));

  if (options?.includeStageNames !== false) {
    for (const stageName of input.failedStageNames ?? []) {
      if (!stageName) {
        continue;
      }
      modes.push(`stage:${stageName}`);
    }
  }

  return Array.from(new Set(modes));
}

function labelFailureMode(code: string): string {
  if (code.startsWith("stage:")) {
    return getStageFailureLabel(code.slice("stage:".length));
  }
  return failureModeLabels[code] ?? code.replace(/_/g, " ");
}

function labelCorrectionSignal(signalKey: string): string {
  return correctionSignalLabels[signalKey] ?? signalKey.replace(/_/g, " ");
}

export function deriveCorrectionPatternSignals(input: {
  correctedMarkdown?: string | null;
  structuredData?: Record<string, unknown> | null;
  notes?: string | null;
  failureModes?: string[];
}): string[] {
  const markdown = input.correctedMarkdown ?? "";
  const flattenedMarkdown = normalizeCorrectionText(input.correctedMarkdown);
  const notes = normalizeCorrectionText(input.notes).toLowerCase();
  const failureModes = new Set(input.failureModes ?? []);
  const signals = new Set<string>();

  if (flattenedMarkdown) {
    signals.add("markdown_rewrite");
  }
  if (hasStructuredData(input.structuredData)) {
    signals.add("structured_patch");
    signals.add("schema_repair");
  }
  if (failureModes.has("schema_validation")) {
    signals.add("schema_repair");
  }
  if (failureModes.has("retries") || failureModes.has("stage_failure")) {
    signals.add("layout_repair");
  }
  if (((markdown.match(/(?:^|\n)\|.+\|/g)?.length ?? 0) >= 2) || /\b(table|column|header|cell)\b/.test(notes)) {
    signals.add("table_structure");
  }
  if (
    ((markdown.match(/(?:^|\n)(?:[-*]\s+|\d+\.\s+)/g)?.length ?? 0) >= 2) ||
    /\b(list|bullet|numbering|ordered)\b/.test(notes)
  ) {
    signals.add("list_cleanup");
  }
  if (
    markdown.includes("\f") ||
    /(?:^|\n)---(?:\n|$)/.test(markdown) ||
    /\b(page|footer|header|section break|pagination|split)\b/.test(notes)
  ) {
    signals.add("page_segmentation");
  }
  if (/\b(ocr|scan|scanned|typo|garbled|recognition)\b/.test(notes)) {
    signals.add("ocr_cleanup");
  }
  if (/\b(layout|column|reading order|merged|alignment|wrap)\b/.test(notes)) {
    signals.add("layout_repair");
  }

  return Array.from(signals);
}

export function calculateReviewSeverity(input: {
  plausibilityScore: number | null;
  retries: number;
  failedStages: number;
  schemaErrors: number;
  estimatedCostCents: number;
}): number {
  const plausibilityPenalty =
    input.plausibilityScore === null
      ? 30
      : Math.max(0, (1 - input.plausibilityScore) * 100);
  return Number(
    (
      plausibilityPenalty +
      input.retries * 12 +
      input.failedStages * 20 +
      input.schemaErrors * 25 +
      input.estimatedCostCents / 10
    ).toFixed(2)
  );
}

async function getAccessibleDocument(docId: string, userId: string): Promise<ReviewDocumentRow | null> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) {
    return null;
  }

  const [row] = await sql<ReviewDocumentRow[]>`
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
      created_at::text,
      updated_at::text
    from documents
    where id = ${docId}
      and workspace_id = any(${sql.array(workspaceIds)})
    limit 1
  `;

  return row ?? null;
}

async function getCorrectionRow(docId: string): Promise<CorrectionRow | null> {
  const [row] = await sql<CorrectionRow[]>`
    select
      id,
      document_id,
      run_id,
      user_id,
      corrected_markdown,
      corrected_structured_data,
      notes,
      reindex_requested_at::text,
      reindex_completed_at::text,
      created_at::text,
      updated_at::text
    from document_corrections
    where document_id = ${docId}
    limit 1
  `;

  return row ?? null;
}

async function getReviewSignalSnapshot(docId: string): Promise<ReviewSignalRow | null> {
  const [row] = await sql<ReviewSignalRow[]>`
    select
      d.id as document_id,
      (
        select max(value)
        from performance_log
        where document_id = d.id and metric = 'extraction-plausibility'
      ) as plausibility_score,
      (
        select coalesce(sum(greatest(attempts - 1, 0)), 0)::int
        from document_run_stage_states
        where document_id = d.id
      ) as retries,
      (
        select coalesce(sum(case when status = 'failed' then 1 else 0 end), 0)::int
        from document_run_stage_states
        where document_id = d.id
      ) as failed_stages,
      (
        select coalesce(sum(case when stage_name = 'structured-extract' and error is not null then 1 else 0 end), 0)::int
        from document_run_stage_states
        where document_id = d.id
      ) as schema_errors,
      (
        select coalesce(array_agg(distinct stage_name) filter (where status = 'failed'), '{}')
        from document_run_stage_states
        where document_id = d.id
      ) as failed_stage_names
    from documents d
    where d.id = ${docId}
    limit 1
  `;

  return row ?? null;
}

async function listWorkspaceCorrectionHistory(workspaceId: string): Promise<CorrectionProfileHistoryRow[]> {
  return await sql<CorrectionProfileHistoryRow[]>`
    select
      d.id as document_id,
      d.workspace_id,
      d.filename,
      d.mime_type,
      d.extraction_mode,
      d.page_count,
      dc.id as correction_id,
      dc.corrected_markdown,
      dc.corrected_structured_data,
      dc.notes,
      dc.reindex_requested_at::text,
      dc.reindex_completed_at::text,
      dc.created_at::text as correction_created_at,
      dc.updated_at::text as correction_updated_at,
      (
        select max(value)
        from performance_log
        where document_id = d.id and metric = 'extraction-plausibility'
      ) as plausibility_score,
      (
        select coalesce(sum(greatest(attempts - 1, 0)), 0)::int
        from document_run_stage_states
        where document_id = d.id
      ) as retries,
      (
        select coalesce(sum(case when status = 'failed' then 1 else 0 end), 0)::int
        from document_run_stage_states
        where document_id = d.id
      ) as failed_stages,
      (
        select coalesce(sum(case when stage_name = 'structured-extract' and error is not null then 1 else 0 end), 0)::int
        from document_run_stage_states
        where document_id = d.id
      ) as schema_errors,
      (
        select coalesce(array_agg(distinct stage_name) filter (where status = 'failed'), '{}')
        from document_run_stage_states
        where document_id = d.id
      ) as failed_stage_names
    from document_corrections dc
    join documents d on d.id = dc.document_id
    where d.workspace_id = ${workspaceId}
    order by dc.updated_at desc
    limit 80
  `;
}

type CorrectionProfileSummaryInput = {
  document: Pick<ReviewDocumentRow, "id" | "workspace_id" | "filename" | "mime_type" | "extraction_mode">;
  correction: CorrectionRow | null;
  reviewSignal: ReviewSignalRow | null;
  history: CorrectionProfileHistoryRow[];
};

export function buildCorrectionProfileSummary(args: CorrectionProfileSummaryInput): CorrectionProfileSummary {
  const documentType = classifyCorrectionDocumentType({
    filename: args.document.filename,
    mimeType: args.document.mime_type,
    extractionMode: args.document.extraction_mode
  });
  const profileKey = buildCorrectionProfileKey(args.document.workspace_id, documentType.key);
  const scopedHistory = args.history.filter((entry) => {
    return (
      classifyCorrectionDocumentType({
        filename: entry.filename,
        mimeType: entry.mime_type,
        extractionMode: entry.extraction_mode
      }).key === documentType.key
    );
  });
  const failureCounts = new Map<
    string,
    { count: number; lastSeenAt: string; exampleDocumentIds: string[] }
  >();
  const signalCounts = new Map<
    string,
    { count: number; lastSeenAt: string; exampleDocumentIds: string[] }
  >();

  const examples = scopedHistory
    .map((entry) => {
      const failureModes = buildReviewFailureModes(
        {
          plausibilityScore: entry.plausibility_score,
          retries: entry.retries,
          failedStages: entry.failed_stages,
          schemaErrors: entry.schema_errors,
          failedStageNames: entry.failed_stage_names
        },
        { includeStageNames: true }
      );
      const signalKeys = deriveCorrectionPatternSignals({
        correctedMarkdown: entry.corrected_markdown,
        structuredData: entry.corrected_structured_data,
        notes: entry.notes,
        failureModes
      });

      for (const code of failureModes) {
        const current = failureCounts.get(code);
        if (current) {
          current.count += 1;
          current.lastSeenAt = current.lastSeenAt > entry.correction_updated_at ? current.lastSeenAt : entry.correction_updated_at;
          if (!current.exampleDocumentIds.includes(entry.document_id)) {
            current.exampleDocumentIds.push(entry.document_id);
          }
        } else {
          failureCounts.set(code, {
            count: 1,
            lastSeenAt: entry.correction_updated_at,
            exampleDocumentIds: [entry.document_id]
          });
        }
      }

      for (const signalKey of signalKeys) {
        const current = signalCounts.get(signalKey);
        if (current) {
          current.count += 1;
          current.lastSeenAt = current.lastSeenAt > entry.correction_updated_at ? current.lastSeenAt : entry.correction_updated_at;
          if (!current.exampleDocumentIds.includes(entry.document_id)) {
            current.exampleDocumentIds.push(entry.document_id);
          }
        } else {
          signalCounts.set(signalKey, {
            count: 1,
            lastSeenAt: entry.correction_updated_at,
            exampleDocumentIds: [entry.document_id]
          });
        }
      }

      return {
        documentId: entry.document_id,
        filename: entry.filename,
        plausibilityScore: entry.plausibility_score,
        correctionState: entry.reindex_completed_at ? "reindexed" : "corrected",
        updatedAt: entry.correction_updated_at,
        reindexedAt: entry.reindex_completed_at,
        pageCount: entry.page_count,
        failureModes,
        signalKeys,
        noteExcerpt: clipText(entry.notes, 220),
        correctedMarkdownPreview: clipText(entry.corrected_markdown, 320),
        structuredDataKeys: Object.keys(entry.corrected_structured_data ?? {}).slice(0, 8),
        isCurrentDocument: entry.document_id === args.document.id
      } satisfies CorrectionProfileExample;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const peerExamples = examples.filter((entry) => !entry.isCurrentDocument);
  const visibleExamples = (peerExamples.length > 0 ? peerExamples : examples).slice(0, 5);
  const currentDocumentFailureModes = buildReviewFailureModes(
    {
      plausibilityScore: args.reviewSignal?.plausibility_score ?? null,
      retries: args.reviewSignal?.retries ?? 0,
      failedStages: args.reviewSignal?.failed_stages ?? 0,
      schemaErrors: args.reviewSignal?.schema_errors ?? 0,
      failedStageNames: args.reviewSignal?.failed_stage_names ?? []
    },
    { includeStageNames: true }
  );
  const currentDocumentSignals = deriveCorrectionPatternSignals({
    correctedMarkdown: args.correction?.corrected_markdown,
    structuredData: args.correction?.corrected_structured_data,
    notes: args.correction?.notes,
    failureModes: currentDocumentFailureModes
  });

  return {
    profileKey,
    workspaceId: args.document.workspace_id,
    documentType,
    summary: {
      correctedDocuments: scopedHistory.length,
      reindexedDocuments: scopedHistory.filter((entry) => entry.reindex_completed_at).length,
      pendingReindexDocuments: scopedHistory.filter((entry) => !entry.reindex_completed_at).length,
      lastCorrectedAt: scopedHistory[0]?.correction_updated_at ?? null
    },
    recurringFailureModes: Array.from(failureCounts.entries())
      .map(([code, aggregate]) => ({
        code,
        label: labelFailureMode(code),
        count: aggregate.count,
        share: Number((aggregate.count / Math.max(1, scopedHistory.length)).toFixed(2)),
        lastSeenAt: aggregate.lastSeenAt,
        exampleDocumentIds: aggregate.exampleDocumentIds.slice(0, 4)
      }))
      .sort((left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, 6),
    correctionPatterns: Array.from(signalCounts.entries())
      .map(([key, aggregate]) => ({
        key,
        label: labelCorrectionSignal(key),
        count: aggregate.count,
        lastSeenAt: aggregate.lastSeenAt,
        exampleDocumentIds: aggregate.exampleDocumentIds.slice(0, 4)
      }))
      .sort((left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, 6),
    currentDocumentSignals,
    examples: visibleExamples
  };
}

export async function listLowConfidenceReviewQueue(args: {
  userId: string;
  orgId?: string;
  runId?: string;
  workspaceId?: string;
  sort?: "severity" | "cost" | "org" | "failure-mode";
}): Promise<ReviewQueueEntry[]> {
  const workspaceIds = await listAccessibleWorkspaceIds(args.userId);
  if (workspaceIds.length === 0) {
    return [];
  }

  const scopedIds = args.workspaceId ? [args.workspaceId] : workspaceIds;
  const documents = await sql<ReviewDocumentRow[]>`
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
      created_at::text,
      updated_at::text
    from documents
    where workspace_id = any(${sql.array(scopedIds)})
      and (${args.orgId ?? null}::text is null or org_id = ${args.orgId ?? null})
      and (${args.runId ?? null}::text is null or run_id = ${args.runId ?? null})
    order by created_at desc
  `;

  if (documents.length === 0) {
    return [];
  }

  const documentIds = documents.map((document) => document.id);
  const runIds = Array.from(new Set(documents.map((document) => document.run_id).filter((value): value is string => Boolean(value))));

  const [signals, runs, corrections, runCosts] = await Promise.all([
    sql<ReviewSignalRow[]>`
      select
        d.id as document_id,
        (
          select max(value)
          from performance_log
          where document_id = d.id and metric = 'extraction-plausibility'
        ) as plausibility_score,
        (
          select coalesce(sum(greatest(attempts - 1, 0)), 0)::int
          from document_run_stage_states
          where document_id = d.id
        ) as retries,
        (
          select coalesce(sum(case when status = 'failed' then 1 else 0 end), 0)::int
          from document_run_stage_states
          where document_id = d.id
        ) as failed_stages,
        (
          select coalesce(sum(case when stage_name = 'structured-extract' and error is not null then 1 else 0 end), 0)::int
          from document_run_stage_states
          where document_id = d.id
        ) as schema_errors,
        (
          select coalesce(array_agg(distinct stage_name) filter (where status = 'failed'), '{}')
          from document_run_stage_states
          where document_id = d.id
        ) as failed_stage_names
      from documents d
      where d.id = any(${sql.array(documentIds)})
    `,
    runIds.length > 0
      ? sql<RunCostRow[]>`
          select id, total_documents
          from workspace_runs
          where id = any(${sql.array(runIds)})
        `
      : Promise.resolve([] as RunCostRow[]),
    sql<CorrectionRow[]>`
      select
        id,
        document_id,
        run_id,
        user_id,
        corrected_markdown,
        corrected_structured_data,
        notes,
        reindex_requested_at::text,
        reindex_completed_at::text,
        created_at::text,
        updated_at::text
      from document_corrections
      where document_id = any(${sql.array(documentIds)})
    `,
    // The run cost every surface reports (usage ledger), spread per document.
    runUsageCostSummaries(runIds),
  ]);

  const signalLookup = new Map(signals.map((row) => [row.document_id, row]));
  const runLookup = new Map(runs.map((row) => [row.id, row]));
  const correctionLookup = new Map(corrections.map((row) => [row.document_id, row]));

  const queue = documents
    .map((document) => {
      const signal = signalLookup.get(document.id);
      const run = document.run_id ? runLookup.get(document.run_id) ?? null : null;
      const estimatedCostCents = run ? (runCosts.get(run.id)?.costCents ?? 0) / Math.max(1, run.total_documents) : 0;
      const correction = correctionLookup.get(document.id) ?? null;
      const plausibilityScore = signal?.plausibility_score ?? null;
      const failureModes = buildReviewFailureModes(
        {
          plausibilityScore,
          retries: signal?.retries ?? 0,
          failedStages: signal?.failed_stages ?? 0,
          schemaErrors: signal?.schema_errors ?? 0,
          failedStageNames: signal?.failed_stage_names ?? []
        },
        { includeStageNames: false }
      );

      return {
        document: {
          id: document.id,
          orgId: document.org_id,
          workspaceId: document.workspace_id,
          runId: document.run_id,
          filename: document.filename,
          mimeType: document.mime_type,
          status: document.status,
          pageCount: document.page_count,
          createdAt: document.created_at,
          updatedAt: document.updated_at
        },
        severityScore: calculateReviewSeverity({
          plausibilityScore,
          retries: signal?.retries ?? 0,
          failedStages: signal?.failed_stages ?? 0,
          schemaErrors: signal?.schema_errors ?? 0,
          estimatedCostCents
        }),
        estimatedCostCents,
        plausibilityScore,
        retries: signal?.retries ?? 0,
        failedStages: signal?.failed_stages ?? 0,
        schemaErrors: signal?.schema_errors ?? 0,
        failureModes,
        correctionState: correction?.reindex_completed_at
          ? "reindexed"
          : correction
            ? "corrected"
            : "open",
        correctionUpdatedAt: correction?.updated_at ?? null
      } satisfies ReviewQueueEntry;
    })
    .filter((entry) => entry.failureModes.length > 0);

  const sort = args.sort ?? "severity";
  queue.sort((left, right) => {
    if (sort === "cost") {
      return right.estimatedCostCents - left.estimatedCostCents;
    }
    if (sort === "org") {
      return left.document.orgId.localeCompare(right.document.orgId) || right.severityScore - left.severityScore;
    }
    if (sort === "failure-mode") {
      return left.failureModes.join(",").localeCompare(right.failureModes.join(",")) || right.severityScore - left.severityScore;
    }
    return right.severityScore - left.severityScore;
  });

  return queue;
}

export async function getCorrectionWorkbench(docId: string, userId: string): Promise<CorrectionWorkbenchPayload | null> {
  const document = await getAccessibleDocument(docId, userId);
  if (!document) {
    return null;
  }

  const [viewer, correction, reviewSignal, correctionHistory] = await Promise.all([
    getDocumentViewerPayload(docId, userId),
    getCorrectionRow(docId),
    getReviewSignalSnapshot(docId),
    listWorkspaceCorrectionHistory(document.workspace_id)
  ]);

  const markdownUri = viewer?.artifacts.find((artifact) => artifact.slot === `${docId}:markdown`)?.uri;
  const structuredUri = viewer?.stages.find((stage) => stage.stage_name === "structured-extract")?.artifact_uri ?? null;

  let originalMarkdown: string | null = null;
  let originalStructuredData: Record<string, unknown> | null = null;

  if (markdownUri) {
    originalMarkdown = await getArtifactText(markdownUri).catch(() => null);
  }

  if (structuredUri) {
    originalStructuredData = await getArtifactJson<Record<string, unknown>>(structuredUri).catch(() => null);
  }

  return {
    documentId: docId,
    originalMarkdown,
    originalStructuredData,
    tags: viewer?.tags ?? [],
    correction: correction
      ? {
          markdown: correction.corrected_markdown,
          structuredData: correction.corrected_structured_data,
          notes: correction.notes,
          reindexRequestedAt: correction.reindex_requested_at,
          reindexCompletedAt: correction.reindex_completed_at,
          updatedAt: correction.updated_at
        }
      : null,
    profile: buildCorrectionProfileSummary({
      document,
      correction,
      reviewSignal,
      history: correctionHistory
    })
  };
}

export async function saveDocumentCorrection(args: {
  docId: string;
  userId: string;
  markdown?: string | null;
  structuredData?: Record<string, unknown> | null;
  notes?: string | null;
  tags?: string[];
}): Promise<CorrectionWorkbenchPayload | null> {
  const document = await getAccessibleDocument(args.docId, args.userId);
  if (!document) {
    return null;
  }

  if (args.tags) {
    await setDocumentTags(args.docId, args.userId, args.tags);
  }

  await sql`
    insert into document_corrections (
      id,
      document_id,
      run_id,
      user_id,
      corrected_markdown,
      corrected_structured_data,
      notes,
      created_at,
      updated_at
    )
    values (
      gen_random_uuid()::text,
      ${args.docId},
      ${document.run_id},
      ${args.userId},
      ${args.markdown ?? null},
      ${args.structuredData ? sql.json(JSON.parse(JSON.stringify(args.structuredData))) : null}::jsonb,
      ${args.notes ?? null},
      now(),
      now()
    )
    on conflict (document_id) do update
    set user_id = excluded.user_id,
        corrected_markdown = excluded.corrected_markdown,
        corrected_structured_data = excluded.corrected_structured_data,
        notes = excluded.notes,
        updated_at = now()
  `;

  return await getCorrectionWorkbench(args.docId, args.userId);
}

export async function reindexDocumentCorrection(args: {
  docId: string;
  userId: string;
}): Promise<{ documentId: string; pageCount: number; chunkCount: number; profileKey: string; signalKeys: string[] } | null> {
  const document = await getAccessibleDocument(args.docId, args.userId);
  if (!document || !document.run_id) {
    return null;
  }

  const [correction, reviewSignal] = await Promise.all([
    getCorrectionRow(args.docId),
    getReviewSignalSnapshot(args.docId)
  ]);
  if (!correction?.corrected_markdown) {
    return null;
  }

  const documentType = classifyCorrectionDocumentType({
    filename: document.filename,
    mimeType: document.mime_type,
    extractionMode: document.extraction_mode
  });
  const profileKey = buildCorrectionProfileKey(document.workspace_id, documentType.key);
  const failureModes = buildReviewFailureModes(
    {
      plausibilityScore: reviewSignal?.plausibility_score ?? null,
      retries: reviewSignal?.retries ?? 0,
      failedStages: reviewSignal?.failed_stages ?? 0,
      schemaErrors: reviewSignal?.schema_errors ?? 0,
      failedStageNames: reviewSignal?.failed_stage_names ?? []
    },
    { includeStageNames: true }
  );
  const signalKeys = deriveCorrectionPatternSignals({
    correctedMarkdown: correction.corrected_markdown,
    structuredData: correction.corrected_structured_data,
    notes: correction.notes,
    failureModes
  });

  const pages = splitMarkdownIntoPages(correction.corrected_markdown, document.page_count);
  const pageRows: PageInsertRow[] = pages.map((page, index) => ({
    id: randomUUID(),
    document_id: args.docId,
    run_id: document.run_id!,
    user_id: args.userId,
    page_number: index + 1,
    text: page,
    token_estimate: tokenEstimate(page)
  }));

  const chunkRows: ChunkInsertRow[] = [];
  let nextChunkIndex = 0;
  for (const page of pageRows) {
    const chunks = chunkCorrectionPage(page.text);
    chunks.forEach((chunk, index) => {
      chunkRows.push({
        id: randomUUID(),
        document_id: args.docId,
        run_id: document.run_id!,
        user_id: args.userId,
        chunk_index: nextChunkIndex++,
        text: chunk,
        heading_path: [],
        page_number: page.page_number,
        token_estimate: tokenEstimate(chunk),
        metadata: {
          source: "human-correction",
          correctionId: correction.id,
          reindexedAt: new Date().toISOString(),
          extractionProfile: {
            key: profileKey,
            workspaceId: document.workspace_id,
            documentType: documentType.key,
            signalKeys,
            failureModes
          }
        }
      });
    });
  }

  await sql.begin(async (tx) => {
    const transaction = tx as unknown as typeof sql;

    await transaction`
      update document_corrections
      set reindex_requested_at = coalesce(reindex_requested_at, now()),
          reindex_completed_at = now(),
          updated_at = now()
      where document_id = ${args.docId}
    `;

    await transaction`delete from document_chunks where document_id = ${args.docId}`;
    await transaction`delete from document_pages where document_id = ${args.docId}`;

    for (const page of pageRows) {
      await transaction`
        insert into document_pages (
          id,
          document_id,
          run_id,
          user_id,
          page_number,
          text,
          token_estimate
        )
        values (
          ${page.id},
          ${page.document_id},
          ${page.run_id},
          ${page.user_id},
          ${page.page_number},
          ${page.text},
          ${page.token_estimate}
        )
      `;
    }

    for (const chunk of chunkRows) {
      await transaction`
        insert into document_chunks (
          id,
          document_id,
          run_id,
          user_id,
          chunk_index,
          text,
          heading_path,
          page_number,
          token_estimate,
          metadata
        )
        values (
          ${chunk.id},
          ${chunk.document_id},
          ${chunk.run_id},
          ${chunk.user_id},
          ${chunk.chunk_index},
          ${chunk.text},
          ${transaction.array(chunk.heading_path)},
          ${chunk.page_number},
          ${chunk.token_estimate},
          ${transaction.json(JSON.parse(JSON.stringify(chunk.metadata)))}
        )
      `;
    }

    await transaction`
      update documents
      set page_count = ${pageRows.length},
          updated_at = now()
      where id = ${args.docId}
    `;
  });

  return {
    documentId: args.docId,
    pageCount: pageRows.length,
    chunkCount: chunkRows.length,
    profileKey,
    signalKeys
  };
}
