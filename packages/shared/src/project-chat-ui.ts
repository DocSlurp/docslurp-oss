import { projectSettingsProposalSchema } from "./project-settings-proposal.js";
import { chatAgentModesSchema } from "./project.js";
import type { UIMessage } from "ai";
import { z } from "zod";
import { citationLocatorSchema } from "./citation-locator.js";
import { ingestReportSchema, type IngestReport } from "./ingest-report.js";

export const projectChatStatusStageSchema = z.enum([
  "retrieval",
  "generation",
  "complete",
  "error",
]);

/**
 * What a chat web tool call shows while it runs and after: the model's query or
 * the URLs it reads, then the results (domain, title) and credits charged.
 * Provider-neutral by construction: no provider, cost or raw payload fields.
 */
export const webToolActivitySchema = z.object({
  kind: z.enum(["search", "fetch"]),
  query: z.string().max(400).optional(),
  urls: z.array(z.string().max(2048)).max(10).optional(),
  /** How many URLs the call asked for (urls lists at most five). */
  requestedCount: z.number().int().nonnegative().optional(),
  results: z.array(z.object({
    url: z.string().max(2048),
    domain: z.string().max(253),
    title: z.string().max(300).optional(),
    publishedAt: z.string().max(40).optional(),
  })).max(10).optional(),
  resultCount: z.number().int().nonnegative().optional(),
  /** URLs fetch could not read. */
  failedCount: z.number().int().nonnegative().optional(),
  cached: z.boolean().optional(),
  credits: z.number().nonnegative().optional(),
});
export type WebToolActivity = z.infer<typeof webToolActivitySchema>;

export const projectChatStatusSchema = z.object({
  stage: projectChatStatusStageSchema,
  status: z.enum(["loading", "success", "error"]),
  message: z.string(),
  detail: z.string().optional(),
  subject: z.string().optional(),
  tools: z.array(z.object({
    id: z.string(), name: z.string(), status: z.enum(["loading", "success", "error"]),
    runtimeMs: z.number().nonnegative().optional(),
    settingsProposal: projectSettingsProposalSchema.optional(),
    web: webToolActivitySchema.optional(),
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
export type ProjectChatStatus = z.infer<typeof projectChatStatusSchema>;

export const projectChatAvailabilitySchema = z.object({
  status: z.enum(["empty", "pending", "partial", "complete"]),
  isPartial: z.boolean(),
  keywordOnly: z.boolean().default(false),
  scope: z.object({
    projectId: z.string(),
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
export type ProjectChatAvailability = z.infer<
  typeof projectChatAvailabilitySchema
>;

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The answer's partial-coverage note, e.g. "Searched 31 of 48 pages · 2 files
 * still processing · 1 keyword-only so far. Ask again once they finish for a
 * complete answer."
 */
export function partialCoverageNote(availability: ProjectChatAvailability): string {
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

export const projectChatMetaSchema = z.object({
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
  availability: projectChatAvailabilitySchema.nullable().optional(),
  /** Search-agent turns: the web and suggestions modes the turn actually ran with. */
  modes: chatAgentModesSchema.optional(),
});
export type ProjectChatMeta = z.infer<typeof projectChatMetaSchema>;

export const projectChatCitationSchema = z.object({
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
export type ProjectChatCitation = z.infer<typeof projectChatCitationSchema>;

export const projectChatCitationsSchema = z.object({
  citations: z.array(projectChatCitationSchema),
});
export type ProjectChatCitations = z.infer<
  typeof projectChatCitationsSchema
>;

/** The ingest report answering a "/status" or "how did my files process?" turn. */
export const projectChatIngestReportSchema = z.object({
  report: ingestReportSchema,
});
export type ProjectChatIngestReport = { report: IngestReport };

export const projectChatDataPartSchemas = {
  projectStatus: projectChatStatusSchema,
  projectMeta: projectChatMetaSchema,
  projectCitations: projectChatCitationsSchema,
  ingestReport: projectChatIngestReportSchema,
};

export type ProjectChatUIMessage = UIMessage<
  never,
  {
    projectStatus: ProjectChatStatus;
    projectMeta: ProjectChatMeta;
    projectCitations: ProjectChatCitations;
    ingestReport: ProjectChatIngestReport;
  }
>;

const EMPTY_PROJECT_CITATIONS: ProjectChatCitation[] = [];

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

export function getProjectStatus(
  message: ProjectChatUIMessage,
): ProjectChatStatus | null {
  return getDataPart<ProjectChatStatus>(message, "data-projectStatus");
}

export function getProjectMeta(
  message: ProjectChatUIMessage,
): ProjectChatMeta | null {
  return getDataPart<ProjectChatMeta>(message, "data-projectMeta");
}

export function getProjectCitations(
  message: ProjectChatUIMessage,
): ProjectChatCitation[] {
  return (
    getDataPart<ProjectChatCitations>(message, "data-projectCitations")
      ?.citations ?? EMPTY_PROJECT_CITATIONS
  );
}

export function getIngestReport(message: ProjectChatUIMessage): IngestReport | null {
  return getDataPart<ProjectChatIngestReport>(message, "data-ingestReport")?.report ?? null;
}

export { projectSettingsProposalSchema } from "./project-settings-proposal.js";
export type { ProjectSettingsProposal } from "./project-settings-proposal.js";
