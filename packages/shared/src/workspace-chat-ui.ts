import type { UIMessage } from "ai";
import { z } from "zod";
import { citationLocatorSchema } from "./citation-locator.js";
import { ingestReportSchema, type IngestReport } from "./ingest-report.js";

export const workspaceChatStatusStageSchema = z.enum([
  "retrieval",
  "generation",
  "complete",
  "error",
]);

export const workspaceChatStatusSchema = z.object({
  stage: workspaceChatStatusStageSchema,
  status: z.enum(["loading", "success", "error"]),
  message: z.string(),
  detail: z.string().optional(),
  subject: z.string().optional(),
  tools: z.array(z.object({
    id: z.string(), name: z.string(), status: z.enum(["loading", "success", "error"]),
    runtimeMs: z.number().nonnegative().optional(),
  })).optional(),
  searches: z.array(z.object({
    id: z.string(), groupId: z.string(), query: z.string(), aggregate: z.boolean().optional(),
    status: z.enum(["loading", "success", "error"]),
    runtimeMs: z.number().nonnegative().optional(),
    resultCount: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  })).optional(),
  resultCount: z.number().int().nonnegative().optional(),
});
export type WorkspaceChatStatus = z.infer<typeof workspaceChatStatusSchema>;

export const workspaceChatAvailabilitySchema = z.object({
  status: z.enum(["empty", "pending", "partial", "complete"]),
  isPartial: z.boolean(),
  keywordOnly: z.boolean().default(false),
  scope: z.object({
    workspaceId: z.string(),
    runId: z.string().nullable(),
  }),
  coverage: z.object({
    totalDocuments: z.number().int().nonnegative(),
    indexedDocuments: z.number().int().nonnegative(),
    pageIndexedDocuments: z.number().int().nonnegative(),
    searchableDocuments: z.number().int().nonnegative(),
    pageOnlyDocuments: z.number().int().nonnegative(),
    keywordOnlyDocuments: z.number().int().nonnegative().default(0),
    failedDocuments: z.number().int().nonnegative().default(0),
    inProgressDocuments: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    searchablePages: z.number().int().nonnegative(),
    indexedChunkCount: z.number().int().nonnegative(),
    queuedRuns: z.number().int().nonnegative(),
    processingRuns: z.number().int().nonnegative(),
  }),
  resultBreakdown: z.object({
    indexedResultCount: z.number().int().nonnegative(),
    pageResultCount: z.number().int().nonnegative(),
  }),
  message: z.string().nullable().default(null),
});
export type WorkspaceChatAvailability = z.infer<
  typeof workspaceChatAvailabilitySchema
>;

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The answer's partial-coverage note, e.g. "Searched 31 of 48 pages · 2 files
 * still processing · 1 keyword-only so far. Ask again once they finish for a
 * complete answer."
 */
export function partialCoverageNote(availability: WorkspaceChatAvailability): string {
  const coverage = availability.coverage;
  const searched = coverage.totalPages > 0
    ? `Searched ${coverage.searchablePages} of ${countLabel(coverage.totalPages, "page")}`
    : `Searched ${coverage.searchableDocuments} of ${countLabel(coverage.totalDocuments, "file")}`;
  const parts = [
    searched,
    coverage.inProgressDocuments > 0 ? `${countLabel(coverage.inProgressDocuments, "file")} still processing` : null,
    coverage.keywordOnlyDocuments > 0 ? `${coverage.keywordOnlyDocuments} keyword-only so far` : null,
    coverage.failedDocuments > 0 ? `${countLabel(coverage.failedDocuments, "file")} failed` : null,
  ].filter(Boolean);
  const waiting = coverage.inProgressDocuments > 0 || coverage.keywordOnlyDocuments > 0;
  const advice = waiting
    ? "Ask again once they finish for a complete answer."
    : "Retry the failed files to include them in answers.";
  return `${parts.join(" · ")}. ${advice}`;
}

export const workspaceChatMetaSchema = z.object({
  sessionId: z.string(),
  searchSessionId: z.string().nullable(),
  model: z.string().nullable(),
  mode: z.enum(["retrieval", "whole-corpus", "ingest-report"]),
  fallback: z.boolean(),
  citations: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costCents: z.number().nonnegative().optional(),
  costSource: z.string().optional(),
  runtimeMs: z.number().int().nonnegative(),
  startedAt: z.string(),
  completedAt: z.string(),
  availability: workspaceChatAvailabilitySchema.nullable().optional(),
});
export type WorkspaceChatMeta = z.infer<typeof workspaceChatMetaSchema>;

export const workspaceChatCitationSchema = z.object({
  id: z.string(),
  documentId: z.string().optional(),
  chunkIndex: z.number().int().nullable().optional(),
  filename: z.string(),
  pageNumber: z.number().int().nullable(),
  score: z.number(),
  text: z.string(),
  headingPath: z.array(z.string()).default([]),
  // One malformed locator must not reject the whole citation list.
  locator: citationLocatorSchema.nullable().optional().catch(null),
});
export type WorkspaceChatCitation = z.infer<typeof workspaceChatCitationSchema>;

export const workspaceChatCitationsSchema = z.object({
  citations: z.array(workspaceChatCitationSchema),
});
export type WorkspaceChatCitations = z.infer<
  typeof workspaceChatCitationsSchema
>;

/** The ingest report answering a "/status" or "how did my files process?" turn. */
export const workspaceChatIngestReportSchema = z.object({
  report: ingestReportSchema,
});
export type WorkspaceChatIngestReport = { report: IngestReport };

export const workspaceChatDataPartSchemas = {
  workspaceStatus: workspaceChatStatusSchema,
  workspaceMeta: workspaceChatMetaSchema,
  workspaceCitations: workspaceChatCitationsSchema,
  ingestReport: workspaceChatIngestReportSchema,
};

export type WorkspaceChatUIMessage = UIMessage<
  never,
  {
    workspaceStatus: WorkspaceChatStatus;
    workspaceMeta: WorkspaceChatMeta;
    workspaceCitations: WorkspaceChatCitations;
    ingestReport: WorkspaceChatIngestReport;
  }
>;

const EMPTY_WORKSPACE_CITATIONS: WorkspaceChatCitation[] = [];

export function getMessageText(message: { parts?: Array<unknown> }): string {
  if (!Array.isArray(message.parts)) {
    return "";
  }

  return message.parts
    .flatMap((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { type?: string }).type === "text" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return [(part as { text: string }).text];
      }

      return [];
    })
    .join("");
}

function getDataPart<T>(
  message: { parts?: Array<unknown> },
  type: string,
): T | null {
  if (!Array.isArray(message.parts)) {
    return null;
  }

  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      (part as { type?: string }).type === type &&
      "data" in part
    ) {
      return ((part as { data?: T }).data ?? null) as T | null;
    }
  }

  return null;
}

export function getWorkspaceStatus(
  message: WorkspaceChatUIMessage,
): WorkspaceChatStatus | null {
  return getDataPart<WorkspaceChatStatus>(message, "data-workspaceStatus");
}

export function getWorkspaceMeta(
  message: WorkspaceChatUIMessage,
): WorkspaceChatMeta | null {
  return getDataPart<WorkspaceChatMeta>(message, "data-workspaceMeta");
}

export function getWorkspaceCitations(
  message: WorkspaceChatUIMessage,
): WorkspaceChatCitation[] {
  return (
    getDataPart<WorkspaceChatCitations>(message, "data-workspaceCitations")
      ?.citations ?? EMPTY_WORKSPACE_CITATIONS
  );
}

export function getIngestReport(message: WorkspaceChatUIMessage): IngestReport | null {
  return getDataPart<WorkspaceChatIngestReport>(message, "data-ingestReport")?.report ?? null;
}
