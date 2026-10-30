import { cleanDocumentTitle, mediaSummarySchema, publicDiagnostics, publicDocumentError, sanitizeStoredPipeline, type MediaSummary } from "@docslurp/shared";
import path from "node:path";

import {
  defaultPipelineFeatures,
  PII_BLOCKED_DOCUMENT_STATUS,
  documentIndexEntrySchema,
  effectiveIndexingMode,
  documentSchema,
  withoutStageSelection,
  type DocumentIndexEntry,
  type DocumentRecord,
  type PipelineFeatures,
  type WorkspaceRun
} from "@docslurp/shared";

import { env } from "../config.js";
import { sql } from "../db.js";
import { notifySearchEligibilityChanged } from "../search/eligibility-hint.js";
import { getArtifactText, parseArtifactUri } from "../lib/artifacts.js";
import { fileUrlForArtifact } from "../lib/file-urls.js";
import { documentWithholdsUri, withheldArtifactUrisFromMetadata } from "./pii-artifact-guard.js";
import { andSqlFragments, type SqlFragment } from "../lib/sql-fragments.js";
import { getWorkspaceAccess, listAccessibleWorkspaceIds, listEditableWorkspaceIds } from "./organizations.js";
import { runCreation } from "./run-creation.js";
import {
  documentUsageTotals,
  runUsageCostTotals,
  runUsageTotals,
  summarizeRunUsageCost,
  type UsageAggregate,
} from "./usage-attribution.js";
import { extractNotReprocessable } from "./reprocess-errors.js";

type DocumentRow = {
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
  file_size?: number | string | null;
  source_sha256?: string | null;
  deduped_from_document_id?: string | null;
  dedup_scope?: "workspace" | "org" | null;
  version_number: number;
  previous_version_id: string | null;
  canonical_id?: string | null;
  superseded_at?: string | Date | null;
  superseded_by_document_id?: string | null;
  indexing_mode?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
};

type DocumentIndexRow = DocumentRow & {
  workspace_name: string;
  org_name: string | null;
  summary: string | null;
};

type DocumentStageRow = {
  stage_name: string;
  status: string;
  attempts: number;
  artifact_uri: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
  updated_at: string | Date;
};

type RunRow = {
  id: string;
  org_id: string;
  workspace_id: string;
  user_id: string;
  status: WorkspaceRun["status"];
  stage: WorkspaceRun["stage"];
  total_documents: number;
  pipeline: PipelineFeatures;
  artifacts: Record<string, string> | null;
  updated_at: string | Date;
};

type UsageAggregateRow = {
  input_tokens: number | string;
  output_tokens: number | string;
  cost_cents: number | string;
  events: number | string;
};

function serializeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function parseAggregateInt(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSemanticText(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .replace(/\f/g, "\n\n")
    .replace(/[`*_>#~]/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/[^\p{L}\p{N}%.\-\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenizeSemanticText(value: string): string[] {
  return Array.from(new Set(
    normalizeSemanticText(value)
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 || /\d/.test(token))
  ));
}

function extractSemanticNumbers(value: string): string[] {
  return Array.from(new Set(value.match(/\b\d+(?:\.\d+)?%?\b/g) ?? []));
}

function hasSemanticNegation(value: string): boolean {
  return /\b(no|not|never|without|cannot|can't|won't|none|excluded|deny|denied)\b/i.test(value);
}

function excerptSemanticText(value: string, maxChars = 260): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }

  return `${compact.slice(0, maxChars - 1).trimEnd()}…`;
}

export function extractSemanticBlocks(text: string): SemanticBlock[] {
  const rawSections = text
    .replace(/\r/g, "\n")
    .replace(/\f/g, "\n\n")
    .split(/\n{2,}/)
    .map((section) => section.trim())
    .filter(Boolean);

  const blocks: SemanticBlock[] = [];
  let activeHeading: string | null = null;

  for (const section of rawSections) {
    const lines = section.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      continue;
    }

    let body = lines.join("\n");
    const headingMatch = lines[0]?.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      activeHeading = headingMatch[1]?.trim() ?? null;
      body = lines.slice(1).join("\n").trim();
      if (!body) {
        continue;
      }
    }

    const comparable = activeHeading ? `${activeHeading}\n${body}` : body;
    const normalized = normalizeSemanticText(comparable);
    if (!normalized) {
      continue;
    }

    const tokens = tokenizeSemanticText(comparable);
    blocks.push({
      id: `${blocks.length + 1}`,
      index: blocks.length,
      heading: activeHeading,
      text: body,
      normalized,
      tokens,
      tokenSet: new Set(tokens),
      numbers: extractSemanticNumbers(comparable),
      hasNegation: hasSemanticNegation(comparable)
    });
  }

  if (blocks.length === 0 && text.trim()) {
    const normalized = normalizeSemanticText(text);
    const tokens = tokenizeSemanticText(text);
    blocks.push({
      id: "1",
      index: 0,
      heading: null,
      text: text.trim(),
      normalized,
      tokens,
      tokenSet: new Set(tokens),
      numbers: extractSemanticNumbers(text),
      hasNegation: hasSemanticNegation(text)
    });
  }

  return blocks.slice(0, 120);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function describeRewriteSignals(previousBlock: SemanticBlock, currentBlock: SemanticBlock): { reasons: string[]; contradictionReasons: string[] } {
  const reasons: string[] = [];
  const contradictionReasons: string[] = [];

  if (previousBlock.heading !== currentBlock.heading && currentBlock.heading) {
    reasons.push(`moved under “${currentBlock.heading}”`);
  }

  if (previousBlock.hasNegation !== currentBlock.hasNegation) {
    const reason = "negation flipped between versions";
    reasons.push(reason);
    contradictionReasons.push(reason);
  }

  const previousNumbers = previousBlock.numbers.join(", ");
  const currentNumbers = currentBlock.numbers.join(", ");
  if (previousNumbers && currentNumbers && previousNumbers !== currentNumbers) {
    const reason = `numeric values changed (${previousNumbers} -> ${currentNumbers})`;
    reasons.push(reason);
    contradictionReasons.push(reason);
  }

  if (reasons.length === 0) {
    reasons.push("shared topic with materially revised wording");
  }

  return { reasons, contradictionReasons };
}

function sortChangelogEntries(entries: DocumentVersionChangelogEntry[]): DocumentVersionChangelogEntry[] {
  return [...entries].sort((left, right) => right.score - left.score).slice(0, MAX_CHANGELOG_ENTRIES);
}

export function buildSemanticDocumentChangelog(args: {
  current: DocumentTextSnapshot;
  baseline: DocumentTextSnapshot | null;
}): DocumentVersionChangelog {
  const generatedAt = new Date().toISOString();

  if (!args.baseline) {
    return {
      available: false,
      generatedAt,
      baselineDocument: null,
      currentSource: args.current.source,
      baselineSource: "missing",
      summary: ["No earlier version is available yet, so there is nothing to diff."],
      stats: {
        currentBlocks: extractSemanticBlocks(args.current.text).length,
        baselineBlocks: 0,
        matchedBlocks: 0,
        additions: 0,
        deletions: 0,
        rewrites: 0,
        contradictions: 0,
        changedRatio: 0
      },
      additions: [],
      deletions: [],
      rewrites: [],
      contradictions: []
    };
  }

  const currentBlocks = extractSemanticBlocks(args.current.text);
  const baselineBlocks = extractSemanticBlocks(args.baseline.text);
  const candidates: Array<{ currentIndex: number; baselineIndex: number; score: number }> = [];

  for (const currentBlock of currentBlocks) {
    for (const baselineBlock of baselineBlocks) {
      const score = jaccardSimilarity(currentBlock.tokenSet, baselineBlock.tokenSet);
      if (score >= MATCH_CANDIDATE_THRESHOLD) {
        candidates.push({
          currentIndex: currentBlock.index,
          baselineIndex: baselineBlock.index,
          score
        });
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score);

  const matchedCurrent = new Set<number>();
  const matchedBaseline = new Set<number>();
  const rewrites: DocumentVersionChangelogEntry[] = [];
  const contradictions: DocumentVersionChangelogEntry[] = [];
  let matchedBlocks = 0;

  for (const candidate of candidates) {
    if (matchedCurrent.has(candidate.currentIndex) || matchedBaseline.has(candidate.baselineIndex)) {
      continue;
    }

    const currentBlock = currentBlocks[candidate.currentIndex];
    const baselineBlock = baselineBlocks[candidate.baselineIndex];
    if (!currentBlock || !baselineBlock) {
      continue;
    }

    matchedCurrent.add(candidate.currentIndex);
    matchedBaseline.add(candidate.baselineIndex);
    matchedBlocks += 1;

    if (candidate.score >= UNCHANGED_BLOCK_THRESHOLD && currentBlock.normalized === baselineBlock.normalized) {
      continue;
    }

    if (candidate.score >= REWRITE_BLOCK_THRESHOLD) {
      const { reasons, contradictionReasons } = describeRewriteSignals(baselineBlock, currentBlock);
      rewrites.push({
        id: `rewrite-${currentBlock.id}-${baselineBlock.id}`,
        kind: "rewrite",
        title: currentBlock.heading ? `${currentBlock.heading} revised` : "Section revised",
        score: candidate.score,
        reasons,
        currentExcerpt: excerptSemanticText(currentBlock.text),
        previousExcerpt: excerptSemanticText(baselineBlock.text)
      });

      if (contradictionReasons.length > 0) {
        contradictions.push({
          id: `contradiction-${currentBlock.id}-${baselineBlock.id}`,
          kind: "contradiction",
          title: currentBlock.heading ? `${currentBlock.heading} may conflict` : "Possible contradiction",
          score: Math.min(1, candidate.score + 0.15),
          reasons: contradictionReasons,
          currentExcerpt: excerptSemanticText(currentBlock.text),
          previousExcerpt: excerptSemanticText(baselineBlock.text)
        });
      }
    }
  }

  const additions = currentBlocks
    .filter((block) => !matchedCurrent.has(block.index))
    .map<DocumentVersionChangelogEntry>((block) => ({
      id: `addition-${block.id}`,
      kind: "addition",
      title: block.heading ? `${block.heading} added` : "New section",
      score: Math.min(1, 0.45 + (block.tokens.length / 20)),
      reasons: [block.heading ? `new content under “${block.heading}”` : "content is new in this version"],
      currentExcerpt: excerptSemanticText(block.text),
      previousExcerpt: null
    }));

  const deletions = baselineBlocks
    .filter((block) => !matchedBaseline.has(block.index))
    .map<DocumentVersionChangelogEntry>((block) => ({
      id: `deletion-${block.id}`,
      kind: "deletion",
      title: block.heading ? `${block.heading} removed` : "Removed section",
      score: Math.min(1, 0.45 + (block.tokens.length / 20)),
      reasons: [block.heading ? `content under “${block.heading}” no longer appears` : "content no longer appears in the latest version"],
      currentExcerpt: null,
      previousExcerpt: excerptSemanticText(block.text)
    }));

  const changedCount = additions.length + deletions.length + rewrites.length;
  const totalReferenceBlocks = Math.max(currentBlocks.length, baselineBlocks.length, 1);
  const changedRatio = Math.min(1, changedCount / totalReferenceBlocks);
  const summary = changedCount === 0
    ? ["No material semantic changes were detected between these versions."]
    : [
        `${additions.length} added, ${deletions.length} removed, ${rewrites.length} rewritten block${rewrites.length === 1 ? "" : "s"}.`,
        contradictions.length > 0
          ? `${contradictions.length} likely contradiction${contradictions.length === 1 ? "" : "s"} need operator review.`
          : "No likely contradictions were detected by the heuristic pass."
      ];

  return {
    available: true,
    generatedAt,
    baselineDocument: {
      id: args.baseline.document.id,
      filename: args.baseline.document.filename,
      versionNumber: args.baseline.document.versionNumber,
      updatedAt: args.baseline.document.updatedAt
    },
    currentSource: args.current.source,
    baselineSource: args.baseline.source,
    summary,
    stats: {
      currentBlocks: currentBlocks.length,
      baselineBlocks: baselineBlocks.length,
      matchedBlocks,
      additions: additions.length,
      deletions: deletions.length,
      rewrites: rewrites.length,
      contradictions: contradictions.length,
      changedRatio
    },
    additions: sortChangelogEntries(additions),
    deletions: sortChangelogEntries(deletions),
    rewrites: sortChangelogEntries(rewrites),
    contradictions: sortChangelogEntries(contradictions)
  };
}

export interface DocumentArtifactEntry {
  slot: string;
  uri: string;
  url: string;
}

export interface DocumentSourceEntry {
  key: string;
  url: string;
  filename: string;
  mimeType: string;
  category: "image" | "audio" | "video" | "other";
  previewable: boolean;
  /** The PII policy withholds the original file; url is empty. */
  withheld?: boolean;
}

export interface DocumentViewerPayload {
  document: DocumentRecord;
  tags: string[];
  versions: DocumentVersionEntry[];
  changelog: DocumentVersionChangelog;
  stages: DocumentStageRow[];
  artifacts: DocumentArtifactEntry[];
  source: DocumentSourceEntry;
  pageStats: {
    pageCount: number;
    chunkCount: number;
    pageTextCount: number;
  };
  /** Present for audio/video: stats for the media focus view ("This recording"). */
  media?: MediaSummary | null;
  run: Pick<WorkspaceRun, "id" | "workspaceId" | "stage" | "status" | "updatedAt"> | null;
  usage: {
    document: {
      inputTokens: number;
      outputTokens: number;
      costCents: number;
      events: number;
    };
    run: {
      inputTokens: number;
      outputTokens: number;
      /** The run's cost as every surface reports it (summarizeRunUsageCost). */
      costCents: number;
      /** True when costCents includes an unbilled worker-compute estimate. */
      computeEstimated: boolean;
      totalDocuments: number;
      events: number;
    } | null;
    estimatedDocument: {
      inputTokens: number;
      outputTokens: number;
      costCents: number;
      basis: "document-events" | "run-average" | "none";
    };
  };
}

export interface DocumentVersionChangelogEntry {
  id: string;
  kind: "addition" | "deletion" | "rewrite" | "contradiction";
  title: string;
  score: number;
  reasons: string[];
  currentExcerpt: string | null;
  previousExcerpt: string | null;
}

export interface DocumentVersionChangelog {
  available: boolean;
  generatedAt: string;
  baselineDocument: Pick<DocumentRecord, "id" | "filename" | "versionNumber" | "updatedAt"> | null;
  currentSource: "markdown" | "page-text" | "missing";
  baselineSource: "markdown" | "page-text" | "missing";
  summary: string[];
  stats: {
    currentBlocks: number;
    baselineBlocks: number;
    matchedBlocks: number;
    additions: number;
    deletions: number;
    rewrites: number;
    contradictions: number;
    changedRatio: number;
  };
  additions: DocumentVersionChangelogEntry[];
  deletions: DocumentVersionChangelogEntry[];
  rewrites: DocumentVersionChangelogEntry[];
  contradictions: DocumentVersionChangelogEntry[];
}

interface DocumentTextSnapshot {
  document: DocumentRecord;
  text: string;
  source: "markdown" | "page-text" | "missing";
}

interface SemanticBlock {
  id: string;
  index: number;
  heading: string | null;
  text: string;
  normalized: string;
  tokens: string[];
  tokenSet: Set<string>;
  numbers: string[];
  hasNegation: boolean;
}

const UNCHANGED_BLOCK_THRESHOLD = 0.9;
const REWRITE_BLOCK_THRESHOLD = 0.4;
const MATCH_CANDIDATE_THRESHOLD = 0.18;
const MAX_CHANGELOG_ENTRIES = 6;

/** Explains a status the user did not ask for, such as a PII policy block. */
function documentStatusReason(row: Pick<DocumentRow, "status" | "metadata">): string | null {
  if (row.status !== PII_BLOCKED_DOCUMENT_STATUS) return null;
  const pii = row.metadata?.pii;
  const reason = pii && typeof pii === "object" ? (pii as { reason?: unknown }).reason : null;
  return typeof reason === "string" && reason ? reason : "Blocked from indexing by the workspace PII policy.";
}

/**
 * The friendly title from ingestion (metadata.title), else the page map's title.
 * Both are untrusted document content, so they are re-sanitized for display here.
 */
function documentTitle(row: Pick<DocumentRow, "filename" | "metadata">): string | null {
  const options = { filename: row.filename };
  return cleanDocumentTitle(row.metadata?.title, options) ?? cleanDocumentTitle(row.metadata?.mapTitle, options);
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return documentSchema.parse({
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    filename: row.filename,
    title: documentTitle(row),
    mimeType: row.mime_type,
    sourceKey: row.source_key,
    status: row.status,
    statusReason: documentStatusReason(row),
    extractionMode: row.extraction_mode,
    pageCount: row.page_count,
    sourceSha256: row.source_sha256 ?? null,
    dedupedFromDocumentId: row.deduped_from_document_id ?? null,
    dedupScope: row.dedup_scope ?? null,
    tags: row.tags ?? [],
    versionNumber: row.version_number ?? 1,
    previousVersionId: row.previous_version_id ?? null,
    canonicalId: row.canonical_id ?? null,
    supersededAt: row.superseded_at ? serializeTimestamp(row.superseded_at) : null,
    supersededByDocumentId: row.superseded_by_document_id ?? null,
    createdAt: serializeTimestamp(row.created_at),
    updatedAt: serializeTimestamp(row.updated_at)
  });
}

function mapDocumentIndexEntry(row: DocumentIndexRow): DocumentIndexEntry {
  return documentIndexEntrySchema.parse({
    ...mapDocument(row),
    workspaceName: row.workspace_name,
    orgName: row.org_name ?? null,
    summary: row.summary ?? null
  });
}

/** A session/key-bound file proxy URL; storage is never exposed (lib/file-urls.ts). */
function fileUrl(uri: string, filename?: string | null): string {
  return fileUrlForArtifact(uri, filename).url;
}

function sourceCategoryForMimeType(mimeType: string): DocumentSourceEntry["category"] {
  const lowered = mimeType.toLowerCase();
  if (lowered.startsWith("image/")) {
    return "image";
  }
  if (lowered.startsWith("audio/")) {
    return "audio";
  }
  if (lowered.startsWith("video/")) {
    return "video";
  }
  return "other";
}

async function buildDocumentSource(row: DocumentRow, withheld: Set<string>): Promise<DocumentSourceEntry> {
  const category = sourceCategoryForMimeType(row.mime_type);
  const sourceUri = `s3://${env.s3Bucket}/${row.source_key}`;
  if (withheld.has(sourceUri)) {
    return { key: row.source_key, url: "", filename: row.filename, mimeType: row.mime_type, category, previewable: false, withheld: true };
  }

  return {
    key: row.source_key,
    url: fileUrl(sourceUri, row.filename),
    filename: row.filename,
    mimeType: row.mime_type,
    category,
    previewable: category !== "other"
  };
}

export async function userCanAccessArtifactUri(uri: string, userId: string, orgId?: string | null): Promise<boolean> {
  const parsed = parseArtifactUri(uri);
  if (!parsed || parsed.bucket !== env.s3Bucket) {
    return false;
  }

  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) {
    return false;
  }
  const candidates = Array.from(new Set([uri, `s3://${parsed.bucket}/${parsed.key}`]));

  const [row] = await sql<{ accessible: boolean }[]>`
    select (
      exists(
        select 1
        from documents d
        where d.workspace_id = any(${sql.array(workspaceIds)})
          and (${orgId === undefined} or d.org_id = ${orgId ?? null})
          and d.source_key = ${parsed.key}
      )
      or exists(
        select 1
        from document_run_stage_states stage_states
        join documents d
          on d.id = stage_states.document_id
          and d.run_id = stage_states.run_id
        where d.workspace_id = any(${sql.array(workspaceIds)})
          and (${orgId === undefined} or d.org_id = ${orgId ?? null})
          and stage_states.artifact_uri = ${uri}
      )
      or exists(
        select 1
        from workspace_runs runs
        where runs.workspace_id = any(${sql.array(workspaceIds)})
          and (${orgId === undefined} or runs.org_id = ${orgId ?? null})
          and exists(
            select 1
            from jsonb_each_text(coalesce(runs.artifacts, '{}'::jsonb)) as artifact(slot, value)
            where artifact.value = ${uri}
          )
      )
    )
    -- The PII policy withholds artifacts it did not scan clean or redact.
    and not exists(
      select 1
      from documents d
      where d.workspace_id = any(${sql.array(workspaceIds)})
        and ${documentWithholdsUri(candidates)}
    ) as accessible
  `;

  return row?.accessible ?? false;
}

async function getDocumentRow(docId: string, userId: string): Promise<DocumentRow | null> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) {
    return null;
  }

  const [row] = await sql<DocumentRow[]>`
    select
      d.*,
      coalesce(array_agg(distinct dt.tag) filter (where dt.tag is not null), '{}') as tags
    from documents d
    left join document_tags dt on dt.document_id = d.id
    where d.id = ${docId} and d.workspace_id = any(${sql.array(workspaceIds)})
    group by d.id
    limit 1
  `;

  return row ?? null;
}

export async function listDocumentsWithFilters(args: {
  userId: string;
  orgId?: string;
  runId?: string;
  workspaceId?: string;
  tags?: string[];
}): Promise<DocumentRecord[]> {
  const workspaceIds = await listAccessibleWorkspaceIds(args.userId);
  if (workspaceIds.length === 0) {
    return [];
  }

  const conditions: SqlFragment[] = [sql`d.workspace_id = any(${sql.array(workspaceIds)})`];

  if (args.runId) {
    conditions.push(sql`d.run_id = ${args.runId}`);
  }

  if (args.orgId) {
    conditions.push(sql`d.org_id = ${args.orgId}`);
  }

  if (args.workspaceId) {
    conditions.push(sql`d.workspace_id = ${args.workspaceId}`);
  }

  if (args.tags && args.tags.length > 0) {
    conditions.push(sql`exists (
      select 1 from document_tags tagged
      where tagged.document_id = d.id
        and tagged.tag = any(${sql.array(args.tags)})
    )`);
  }

  const whereClause = andSqlFragments(conditions);
  const rows = await sql<DocumentRow[]>`
    select
       d.*,
       coalesce(array_agg(distinct dt.tag) filter (where dt.tag is not null), '{}') as tags
     from documents d
     left join document_tags dt on dt.document_id = d.id
     where ${whereClause}
     group by d.id
     order by d.created_at desc
     limit 250
  `;

  return rows.map(mapDocument);
}

export async function listDocumentIndexEntries(args: {
  userId: string;
  orgId?: string;
  workspaceId?: string;
  tags?: string[];
  q?: string;
  limit?: number;
  /** Include older versions replaced by a newer document with the same canonical ID. */
  includeSuperseded?: boolean;
}): Promise<{
  documents: DocumentIndexEntry[];
  totalCount: number;
  limit: number;
  truncated: boolean;
}> {
  const workspaceIds = await listAccessibleWorkspaceIds(args.userId);
  if (workspaceIds.length === 0) {
    return {
      documents: [],
      totalCount: 0,
      limit: Math.max(1, Math.min(args.limit ?? 120, 250)),
      truncated: false
    };
  }

  const limit = Math.max(1, Math.min(args.limit ?? 120, 250));
  const conditions: SqlFragment[] = [sql`d.workspace_id = any(${sql.array(workspaceIds)})`];
  const trimmedQuery = args.q?.trim() ?? "";

  if (!args.includeSuperseded) {
    conditions.push(sql`d.superseded_at is null`);
  }

  if (args.orgId) {
    conditions.push(sql`d.org_id = ${args.orgId}`);
  }

  if (args.workspaceId) {
    conditions.push(sql`d.workspace_id = ${args.workspaceId}`);
  }

  if (args.tags && args.tags.length > 0) {
    conditions.push(sql`exists (
      select 1
      from document_tags tagged
      where tagged.document_id = d.id
        and tagged.tag = any(${sql.array(args.tags)})
    )`);
  }

  let searchOrderClause: SqlFragment = sql`d.updated_at desc`;
  if (trimmedQuery) {
    const fuzzyQuery = `%${trimmedQuery}%`;
    const prefixQuery = `${trimmedQuery}%`;

    conditions.push(sql`(
      d.filename ilike ${fuzzyQuery}
      or coalesce(ds.summary, '') ilike ${fuzzyQuery}
      or w.name ilike ${fuzzyQuery}
      or coalesce(orgs.name, '') ilike ${fuzzyQuery}
      or exists (
        select 1
        from document_tags tagged
        where tagged.document_id = d.id
          and tagged.tag ilike ${fuzzyQuery}
      )
    )`);

    searchOrderClause = sql`
      case
        when d.filename ilike ${prefixQuery} then 0
        when d.filename ilike ${fuzzyQuery} then 1
        when w.name ilike ${fuzzyQuery} then 2
        when coalesce(ds.summary, '') ilike ${fuzzyQuery} then 3
        when coalesce(orgs.name, '') ilike ${fuzzyQuery} then 4
        else 5
      end,
      d.updated_at desc
    `;
  }

  const joinClause = sql`
    from documents d
    join workspaces w on w.id = d.workspace_id
    left join organizations orgs on orgs.id = d.org_id
    left join lateral (
      select summary
      from document_summaries
      where document_id = d.id
      order by created_at desc
      limit 1
    ) ds on true
  `;
  const whereClause = andSqlFragments(conditions);

  const [summaryRow] = await sql<{ total_count: number }[]>`
     select count(*)::int as total_count
     ${joinClause}
     where ${whereClause}
  `;

  const rows = await sql<DocumentIndexRow[]>`
     select
       d.*,
       coalesce(array_agg(distinct dt.tag) filter (where dt.tag is not null), '{}') as tags,
       w.name as workspace_name,
       orgs.name as org_name,
       ds.summary
     ${joinClause}
     left join document_tags dt on dt.document_id = d.id
     where ${whereClause}
     group by d.id, w.name, orgs.name, ds.summary
     order by ${searchOrderClause}
     limit ${limit}
  `;

  const totalCount = summaryRow?.total_count ?? 0;
  return {
    documents: rows.map(mapDocumentIndexEntry),
    totalCount,
    limit,
    truncated: totalCount > limit
  };
}

/** One version in a document's chain; purged versions are tombstones (listed, not openable). */
export interface DocumentVersionEntry {
  documentId: string;
  versionNumber: number;
  createdAt: string;
  status: string;
  isCurrent: boolean;
  archived: boolean;
  purged: boolean;
  pageCount: number;
  sourcePath: string;
  filename: string;
  sizeBytes: number;
}

type DocumentVersionRow = Pick<
  DocumentRow,
  "id" | "version_number" | "created_at" | "status" | "page_count" | "filename" | "superseded_at"
> & {
  /** The version a config change re-indexed to produce this row. */
  reindex_of?: string | null;
  superseded_by_document_id?: string | null;
  archived_at: string | Date | null;
  purged_at: string | Date | null;
  source_path: string | null;
  file_size: string | number | null;
};

/**
 * Newest first. The current version is the newest completed live (not superseded, archived or
 * purged) one, which is what search serves; only when none completed does the newest live row stand in.
 * A newer processing or failed upload keeps its own status and is never current.
 */
export function buildDocumentVersionEntries(rows: DocumentVersionRow[]): DocumentVersionEntry[] {
  const time = (value: DocumentVersionRow["created_at"]) => new Date(value).getTime() || 0;
  const sorted = [...rows].sort((a, b) => (b.version_number ?? 1) - (a.version_number ?? 1) || time(b.created_at) - time(a.created_at));
  const live = sorted.filter((row) => !row.superseded_at && !row.archived_at && !row.purged_at);
  const currentId = (live.find((row) => row.status === "completed") ?? live[0])?.id ?? null;
  // A config re-index is not a new document version to a reader: hide the source it replaced and cancelled re-index attempts.
  const byId = new Map(rows.map((row) => [row.id, row]));
  const hidden = (row: DocumentVersionRow) =>
    (row.reindex_of != null && row.status === "cancelled")
    || (row.superseded_by_document_id != null && byId.get(row.superseded_by_document_id)?.reindex_of === row.id);
  return sorted.filter((row) => !hidden(row)).map((row) => ({
    documentId: row.id,
    versionNumber: row.version_number ?? 1,
    createdAt: serializeTimestamp(row.created_at),
    status: row.status,
    isCurrent: row.id === currentId,
    archived: row.archived_at != null,
    purged: row.purged_at != null,
    pageCount: row.page_count,
    sourcePath: row.source_path ?? "",
    filename: row.filename,
    sizeBytes: Number(row.file_size ?? 0)
  }));
}

/**
 * The whole version chain of a document, newest first, in both directions from `docId`.
 * Access is checked on the requested document; the chain is a single query on the
 * `(workspace_id, canonical_id)` index, so it never leaves the document's workspace.
 */
export async function getDocumentVersionsWithTags(docId: string, userId: string): Promise<DocumentVersionEntry[]> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) return [];

  const [target] = await sql<(DocumentVersionRow & { workspace_id: string; canonical_id: string | null })[]>`
    select id, workspace_id, canonical_id, version_number, created_at, status, page_count, filename,
           superseded_at, archived_at, purged_at, source_path, file_size, reindex_of, superseded_by_document_id
    from documents
    where id = ${docId} and workspace_id = any(${sql.array(workspaceIds)})
    limit 1
  `;
  if (!target) return [];
  // Rows without a canonical id predate version chains: they are their own single-entry chain.
  if (target.canonical_id === null) return buildDocumentVersionEntries([target]);

  const rows = await sql<DocumentVersionRow[]>`
    select id, version_number, created_at, status, page_count, filename, superseded_at,
           archived_at, purged_at, source_path, file_size, reindex_of, superseded_by_document_id
    from documents
    where workspace_id = ${target.workspace_id} and canonical_id = ${target.canonical_id}
  `;
  return buildDocumentVersionEntries(rows);
}

async function loadDocumentTextSnapshot(docId: string, userId: string): Promise<DocumentTextSnapshot | null> {
  const row = await getDocumentRow(docId, userId);
  if (!row) {
    return null;
  }

  const document = mapDocument(row);
  const [run] = row.run_id
    ? await sql<{ artifacts: Record<string, string> | null }[]>`
        select artifacts
        from workspace_runs
        where id = ${row.run_id}
        limit 1
      `
    : [];

  const markdownUri = run?.artifacts?.[`${docId}:markdown`] ?? null;
  if (markdownUri && !withheldArtifactUrisFromMetadata(row.metadata).has(markdownUri)) {
    const markdownText = await getArtifactText(markdownUri).catch(() => "");
    if (markdownText.trim()) {
      return {
        document,
        text: markdownText,
        source: "markdown"
      };
    }
  }

  const pages = await sql<{ page_number: number; text: string }[]>`
    select page_number, text
    from document_pages
    where document_id = ${docId}
    order by page_number
  `;

  if (pages.length > 0) {
    return {
      document,
      text: pages.map((page) => page.text).join("\n\n"),
      source: "page-text"
    };
  }

  return {
    document,
    text: "",
    source: "missing"
  };
}

/**
 * Diff of `docId` against its previous version, or against `baselineOverrideId` when given
 * ("compare with current": docId is the current version, the override is the older one).
 * The override must belong to the same version chain.
 */
export async function getDocumentVersionChangelog(docId: string, userId: string, baselineOverrideId?: string | null): Promise<DocumentVersionChangelog | null> {
  const current = await loadDocumentTextSnapshot(docId, userId);
  if (!current) {
    return null;
  }

  let baselineId = current.document.previousVersionId;
  if (baselineOverrideId) {
    const chain = await getDocumentVersionsWithTags(docId, userId);
    const match = chain.find((entry) => entry.documentId === baselineOverrideId && !entry.purged);
    if (!match) return null;
    baselineId = match.documentId;
  }
  const baseline = baselineId ? await loadDocumentTextSnapshot(baselineId, userId) : null;
  return buildSemanticDocumentChangelog({ current, baseline });
}

/**
 * Media stats written by the worker at ingest. The cost shown is what the ledger attributed to the document
 * when it has events (transcription, diarization, vision and embeddings); otherwise the provider cost from ingest.
 */
export async function readMediaSummary(args: {
  summaryUri: string | null;
  withheld: Set<string>;
  billedCostCents: number | null;
}): Promise<MediaSummary | null> {
  if (!args.summaryUri || args.withheld.has(args.summaryUri)) return null;
  try {
    const parsed = mediaSummarySchema.safeParse(JSON.parse(await getArtifactText(args.summaryUri, 1024 * 1024)));
    if (!parsed.success) return null;
    return args.billedCostCents === null ? parsed.data : { ...parsed.data, ingestCostCents: args.billedCostCents };
  } catch {
    return null;
  }
}

export async function getDocumentViewerPayload(docId: string, userId: string): Promise<DocumentViewerPayload | null> {
  const row = await getDocumentRow(docId, userId);
  if (!row) {
    return null;
  }

  const document = mapDocument(row);
  const versions = await getDocumentVersionsWithTags(docId, userId);
  const changelog = await getDocumentVersionChangelog(docId, userId);

  const stages = row.run_id
    ? await sql<DocumentStageRow[]>`
        select stage_name, status, attempts, artifact_uri, stats, error, updated_at::text
        from document_run_stage_states
        where run_id = ${row.run_id} and document_id = ${docId}
        order by updated_at desc
      `
    : [];

  const [run] = row.run_id
    ? await sql<RunRow[]>`
        select
          id,
          org_id,
          workspace_id,
          user_id,
          status,
          stage,
          total_documents,
          pipeline,
          artifacts,
          updated_at::text
        from workspace_runs
        where id = ${row.run_id}
        limit 1
      `
    : [];

  const withheld = withheldArtifactUrisFromMetadata(row.metadata);
  const artifactUris = new Map<string, string>();
  if (document.status === "completed") {
    for (const stage of stages) {
      if (stage.artifact_uri) {
        artifactUris.set(stage.stage_name, stage.artifact_uri);
      }
    }

    if (run?.artifacts) {
      for (const [slot, uri] of Object.entries(run.artifacts)) {
        if (slot === `${docId}:heatmap` || slot.startsWith(`${docId}:`)) {
          artifactUris.set(slot, uri);
        }
      }
    }
  }

  const artifacts = await Promise.all(
    Array.from(artifactUris.entries())
      .filter(([, uri]) => !withheld.has(uri))
      .map(async ([slot, uri]) => ({
        slot,
        uri,
        url: fileUrl(uri)
      }))
  );
  const source = await buildDocumentSource(row, withheld);

  const [pageStats] = document.status === "completed"
    ? await sql<{ page_count: number; chunk_count: number; page_text_count: number }[]>`
        select
          coalesce((select count(*)::int from document_pages where document_id = ${docId}), 0) as page_count,
          coalesce((select count(*)::int from document_chunks where document_id = ${docId}), 0) as chunk_count,
          coalesce((select count(*)::int from document_pages where document_id = ${docId}), 0) as page_text_count
      `
    : [{ page_count: 0, chunk_count: 0, page_text_count: 0 }];

  const toUsageRow = (usage: UsageAggregate): UsageAggregateRow => ({
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_cents: usage.costCents,
    events: usage.events,
  });
  const documentUsageRow = toUsageRow(await documentUsageTotals(docId));
  const runUsageRow = row.run_id ? toUsageRow(await runUsageTotals(row.run_id)) : undefined;
  const runCost = row.run_id ? summarizeRunUsageCost((await runUsageCostTotals(row.run_id))[0]) : undefined;
  const documentUsage = {
    inputTokens: parseAggregateInt(documentUsageRow?.input_tokens),
    outputTokens: parseAggregateInt(documentUsageRow?.output_tokens),
    costCents: parseAggregateInt(documentUsageRow?.cost_cents),
    events: parseAggregateInt(documentUsageRow?.events)
  };
  const runUsage = run
    ? {
        inputTokens: parseAggregateInt(runUsageRow?.input_tokens),
        outputTokens: parseAggregateInt(runUsageRow?.output_tokens),
        costCents: runCost?.costCents ?? 0,
        computeEstimated: runCost?.computeEstimated ?? false,
        totalDocuments: Math.max(1, run.total_documents),
        events: parseAggregateInt(runUsageRow?.events)
      }
    : null;
  const usageBasis: DocumentViewerPayload["usage"]["estimatedDocument"]["basis"] = documentUsage.events > 0
    ? "document-events"
    : runUsage
      ? "run-average"
      : "none";
  const estimatedDocumentUsage: DocumentViewerPayload["usage"]["estimatedDocument"] = usageBasis === "document-events"
    ? {
        inputTokens: documentUsage.inputTokens,
        outputTokens: documentUsage.outputTokens,
        costCents: documentUsage.costCents,
        basis: usageBasis
      }
    : usageBasis === "run-average" && runUsage
      ? {
          inputTokens: Math.ceil(runUsage.inputTokens / runUsage.totalDocuments),
          outputTokens: Math.ceil(runUsage.outputTokens / runUsage.totalDocuments),
          costCents: runUsage.costCents / runUsage.totalDocuments,
          basis: usageBasis
        }
      : {
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          basis: usageBasis
        };

  const media = await readMediaSummary({
    summaryUri: run?.artifacts?.[`${docId}:media-summary`] ?? null,
    withheld,
    billedCostCents: documentUsage.events > 0 ? documentUsage.costCents : null,
  });

  return {
    document,
    tags: document.tags ?? [],
    versions,
    changelog: changelog ?? buildSemanticDocumentChangelog({
      current: {
        document,
        text: "",
        source: "missing"
      },
      baseline: null
    }),
    stages: stages.map(stage => ({ ...stage, error: publicDocumentError(stage.error), stats: publicDiagnostics(stage.stats) as Record<string, unknown> | null })),
    artifacts,
    source,
    pageStats: {
      pageCount: Math.max(pageStats?.page_count ?? 0, document.pageCount ?? 0),
      chunkCount: pageStats?.chunk_count ?? 0,
      pageTextCount: pageStats?.page_text_count ?? 0
    },
    ...(media ? { media } : {}),
    run: run
      ? {
          id: run.id,
          workspaceId: run.workspace_id,
          stage: run.stage,
          status: run.status,
          updatedAt: serializeTimestamp(run.updated_at)
        }
      : null,
    usage: {
      document: documentUsage,
      run: runUsage,
      estimatedDocument: estimatedDocumentUsage
    }
  };
}

export async function setDocumentTags(docId: string, userId: string, tags: string[]): Promise<string[] | null> {
  const document = await getDocumentRow(docId, userId);
  if (!document || !(await listEditableWorkspaceIds(userId)).includes(document.workspace_id)) {
    return null;
  }

  const normalized = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
  await sql.begin(async (tx) => {
    // Serialize replacements, including when the document currently has no tags.
    await tx`select id from documents where id = ${docId} for update`;
    await tx`delete from document_tags where document_id = ${docId}`;
    for (const tag of normalized) {
      await tx`insert into document_tags (document_id, user_id, tag) values (${docId}, ${userId}, ${tag})`;
    }
    // Native search caches each document's tags with its eligibility.
    await notifySearchEligibilityChanged(tx as unknown as typeof sql, [document.workspace_id]);
  });

  return normalized;
}

export async function addDocumentTags(documentIds: string[], userId: string, tags: string[]): Promise<number> {
  const normalized = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
  if (documentIds.length === 0 || normalized.length === 0) {
    return 0;
  }

  const accessibleWorkspaceIds = await listEditableWorkspaceIds(userId);
  if (accessibleWorkspaceIds.length === 0) {
    return 0;
  }

  const scopedIds = await sql<{ id: string; workspace_id: string }[]>`
    select d.id, d.workspace_id
    from documents d
    where d.id = any(${sql.array(documentIds)})
      and d.workspace_id = any(${sql.array(accessibleWorkspaceIds)})
  `;

  const rows = scopedIds.flatMap((document) =>
    normalized.map((tag) => ({
      document_id: document.id,
      user_id: userId,
      tag
    }))
  );

  if (rows.length === 0) {
    return 0;
  }

  await sql.begin(async (tx) => {
    await tx`
      insert into document_tags ${tx(rows)}
      on conflict (document_id, tag) do nothing
    `;
    await notifySearchEligibilityChanged(tx as unknown as typeof sql, scopedIds.map((row) => row.workspace_id));
  });

  return scopedIds.length;
}

export async function removeDocumentTags(documentIds: string[], userId: string, tags: string[]): Promise<number> {
  const normalized = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
  if (documentIds.length === 0 || normalized.length === 0) {
    return 0;
  }

  const accessibleWorkspaceIds = await listEditableWorkspaceIds(userId);
  if (accessibleWorkspaceIds.length === 0) {
    return 0;
  }

  const scopedIds = await sql<{ id: string; workspace_id: string }[]>`
    select d.id, d.workspace_id
    from documents d
    where d.id = any(${sql.array(documentIds)})
      and d.workspace_id = any(${sql.array(accessibleWorkspaceIds)})
  `;

  if (scopedIds.length === 0) {
    return 0;
  }

  await sql.begin(async (tx) => {
    await tx`
      delete from document_tags
      where document_id = any(${tx.array(scopedIds.map((row) => row.id))})
        and tag = any(${tx.array(normalized)})
    `;
    await notifySearchEligibilityChanged(tx as unknown as typeof sql, scopedIds.map((row) => row.workspace_id));
  });

  return scopedIds.length;
}

export interface DeletedDocumentResult {
  documentId: string;
  workspaceId: string;
  filename: string;
  runId: string | null;
  sourceKey: string;
}

async function deleteDocumentRows(documentIds: string[], userId: string): Promise<DeletedDocumentResult[]> {
  const normalizedIds = Array.from(new Set(documentIds.map((id) => id.trim()).filter(Boolean)));
  if (normalizedIds.length === 0) {
    return [];
  }

  const editableWorkspaceIds = await listEditableWorkspaceIds(userId);
  if (editableWorkspaceIds.length === 0) {
    return [];
  }

  return await sql.begin(async (tx) => {
    const transaction = tx as unknown as typeof sql;

    const docs = await transaction<Pick<DocumentRow, "id" | "workspace_id" | "filename" | "run_id" | "source_key" | "previous_version_id">[]>`
      select id, workspace_id, filename, run_id, source_key, previous_version_id
      from documents
      where id = any(${transaction.array(normalizedIds)})
        and workspace_id = any(${transaction.array(editableWorkspaceIds)})
    `;

    if (docs.length === 0) {
      return [];
    }

    // Rows go now. The documents BEFORE DELETE trigger (migration 0035)
    // records each document's LanceDB targets, artifacts, raw source and graph
    // nodes in document_cleanup_queue; the worker sweep then deletes them.
    // Raw sources still used by another document are kept.
    const docById = new Map(docs.map((doc) => [doc.id, doc]));
    const resolveRetainedPreviousVersionId = (doc: Pick<DocumentRow, "previous_version_id">): string | null => {
      let currentId = doc.previous_version_id;
      while (currentId && docById.has(currentId)) {
        currentId = docById.get(currentId)?.previous_version_id ?? null;
      }
      return currentId;
    };

    for (const doc of docs) {
      const replacementPreviousVersionId = resolveRetainedPreviousVersionId(doc);
      await transaction`
        update documents
        set previous_version_id = ${replacementPreviousVersionId}
        where previous_version_id = ${doc.id}
      `;
    }

    const deleted = await transaction<Pick<DocumentRow, "id" | "workspace_id" | "filename" | "run_id" | "source_key">[]>`
      delete from documents
      where id = any(${transaction.array(docs.map((doc) => doc.id))})
      returning id, workspace_id, filename, run_id, source_key
    `;

    // Deleting a current version leaves its archived predecessors to the retention sweep.
    const workspaceIds = [...new Set(deleted.map((row) => row.workspace_id))];
    if (workspaceIds.length > 0) {
      await transaction`update workspaces set retention_changed_at = clock_timestamp() where id = any(${transaction.array(workspaceIds)})`;
      // Native search caches each workspace's eligible documents; deletes emit no run_events hint.
      await notifySearchEligibilityChanged(transaction, workspaceIds);
    }

    return deleted.map((row) => ({
      documentId: row.id,
      workspaceId: row.workspace_id,
      filename: row.filename,
      runId: row.run_id,
      sourceKey: row.source_key
    }));
  });
}

/** The workspace and organization of each listed document the user can read, so API key routes can check key scope. */
export async function listDocumentOwners(documentIds: string[], userId: string): Promise<Array<{ id: string; workspaceId: string; orgId: string }>> {
  if (documentIds.length === 0) return [];
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) return [];
  const rows = await sql<{ id: string; workspace_id: string; org_id: string }[]>`
    select d.id, d.workspace_id, w.org_id
    from documents d join workspaces w on w.id = d.workspace_id
    where d.workspace_id = any(${sql.array(workspaceIds)}) and d.id = any(${sql.array(documentIds)})
  `;
  return rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, orgId: row.org_id }));
}

export async function deleteDocument(docId: string, userId: string): Promise<DeletedDocumentResult | null> {
  const [deleted] = await deleteDocumentRows([docId], userId);
  return deleted ?? null;
}

export async function deleteDocuments(documentIds: string[], userId: string): Promise<number> {
  return (await deleteDocumentRows(documentIds, userId)).length;
}

export async function exportDocumentArtifacts(documentIds: string[], userId: string): Promise<Record<string, DocumentArtifactEntry[]>> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) {
    return {};
  }

  const docs = await sql<DocumentRow[]>`
    select id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, extraction_mode, page_count,
      version_number, previous_version_id, metadata, created_at::text, updated_at::text
    from documents
    where workspace_id = any(${sql.array(workspaceIds)}) and id = any(${sql.array(documentIds)})
  `;

  const runIds = Array.from(new Set(docs.map((doc) => doc.run_id).filter((value): value is string => Boolean(value))));
  const runs: RunRow[] = runIds.length > 0
    ? await sql<RunRow[]>`
        select id, org_id, workspace_id, user_id, status, stage, pipeline, artifacts, updated_at::text
        from workspace_runs
        where workspace_id = any(${sql.array(workspaceIds)}) and id = any(${sql.array(runIds)})
      `
    : [];

  const runLookup = new Map<string, RunRow>(runs.map((run) => [run.id, run]));
  const result: Record<string, DocumentArtifactEntry[]> = {};

  for (const doc of docs) {
    const run = doc.run_id ? runLookup.get(doc.run_id) : null;
    const withheld = withheldArtifactUrisFromMetadata(doc.metadata);
    const entries = Object.entries(run?.artifacts ?? {})
      .filter(([slot]) => slot === `${doc.id}:heatmap` || slot.startsWith(`${doc.id}:`))
      .filter(([, uri]) => !withheld.has(uri));
    result[doc.id] = await Promise.all(
      entries.map(async ([slot, uri]) => ({
        slot,
        uri,
        url: fileUrl(uri)
      }))
    );
  }

  return result;
}

/**
 * Reprocesses documents into new versions. By default each document re-runs
 * with its original run's pipeline; `useWorkspacePipeline` uses the
 * workspace's current settings instead (ingest report "reprocess affected
 * files" after a settings change).
 *
 * Each (workspace, pipeline) group is independent: a group that cannot be
 * created is reported in `failed` and the rest still run. Only when every
 * group fails does this throw (the first error, so spend blocks keep their
 * status code). Run creation starts each Run; a start that cannot happen
 * leaves the Run queued for run-start recovery and adds a warning.
 */
export async function bulkReprocessDocuments(
  documentIds: string[],
  userId: string,
  options: { useWorkspacePipeline?: boolean } = {},
): Promise<BulkReprocessResult> {
  const result: BulkReprocessResult = { runs: [], failed: [], warnings: [] };
  if (documentIds.length === 0) {
    return result;
  }

  const workspaceIds = await listEditableWorkspaceIds(userId);
  if (workspaceIds.length === 0) {
    return result;
  }

  const selected = await sql<(DocumentRow & { pipeline: PipelineFeatures | null; is_extract: boolean })[]>`
    select
      d.*,
      exists (select 1 from workspace_runs xr where xr.id = d.run_id and xr.extract_id is not null) as is_extract,
      case when ${options.useWorkspacePipeline === true}
        then (select w.pipeline from workspaces w where w.id = d.workspace_id)
        else coalesce(
          (select wr.pipeline from workspace_runs wr where wr.id = d.run_id),
          '{}'::jsonb
        )
      end as pipeline
    from documents d
    where d.workspace_id = any(${sql.array(workspaceIds)}) and d.id = any(${sql.array(documentIds)})
    order by d.workspace_id, d.created_at
  `;
  // Extract documents are deleted with their extract and are never reprocessed (409 when nothing else is left).
  const rows = selected.filter((row) => !row.is_extract);
  const extractRows = selected.filter((row) => row.is_extract);
  if (extractRows.length > 0) {
    const rejected = extractNotReprocessable();
    for (const workspaceId of new Set(extractRows.map((row) => row.workspace_id))) {
      const ids = extractRows.filter((row) => row.workspace_id === workspaceId).map((row) => row.id);
      result.failed.push({ workspaceId, documentIds: ids, message: rejected.message, code: rejected.code });
      result.warnings.push(`${ids.length} extract ${ids.length === 1 ? "document was" : "documents were"} not reprocessed: ${rejected.message}`);
    }
    if (rows.length === 0) throw rejected;
  }

  const groups = new Map<string, Array<DocumentRow & { pipeline: PipelineFeatures | null }>>();
  for (const row of rows) {
    // Stored snapshots may hold extractor settings the strict schemas now reject; drop them before grouping.
    row.pipeline = sanitizeStoredPipeline(row.pipeline, options.useWorkspacePipeline === true ? `workspace ${row.workspace_id}` : `run ${row.run_id}`);
    // A document's own indexing_mode wins over its run's pipeline (a backfill keeps the source's old run).
    if (row.indexing_mode && row.pipeline && row.pipeline.indexingMode !== row.indexing_mode) {
      row.pipeline = { ...row.pipeline, indexingMode: effectiveIndexingMode(row.indexing_mode as PipelineFeatures["indexingMode"]) };
    }
    const key = `${row.workspace_id}:${JSON.stringify(row.pipeline ?? {})}`;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  let firstError: unknown;

  for (const group of groups.values()) {
    const first = group[0];
    if (!first) {
      continue;
    }

    try {
      const created = await runCreation.create({
        userId,
        workspaceId: first.workspace_id,
        kind: "bulk-reprocess",
        // A partial source run's stage selection must not carry into a full re-run.
        pipeline: withoutStageSelection(first.pipeline ?? defaultPipelineFeatures),
        sources: { kind: "versionsOf", documentIds: group.map((doc) => doc.id) },
      });
      result.runs.push(created.run);
      if (created.deferredReason) result.warnings.push(created.deferredReason);
    } catch (error) {
      firstError ??= error;
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: unknown } | null)?.code;
      result.failed.push({
        workspaceId: first.workspace_id,
        documentIds: group.map((doc) => doc.id),
        message,
        ...(typeof code === "string" ? { code } : {}),
      });
      result.warnings.push(
        `${group.length} ${group.length === 1 ? "document" : "documents"} in ${first.workspace_id} ${group.length === 1 ? "was" : "were"} not reprocessed: ${message}`,
      );
    }
  }

  if (result.runs.length === 0 && firstError !== undefined) throw firstError;
  return result;
}

export type BulkReprocessResult = {
  runs: WorkspaceRun[];
  failed: Array<{ workspaceId: string; documentIds: string[]; message: string; code?: string }>;
  warnings: string[];
};

export function inferMimeType(url: string, headerValue: string | null): string {
  if (headerValue && headerValue.trim()) {
    return headerValue.split(";")[0]!.trim();
  }

  const ext = path.extname(new URL(url).pathname).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".jsonl":
      return "application/x-ndjson";
    case ".html":
    case ".htm":
      return "text/html";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}
