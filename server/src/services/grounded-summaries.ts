import { hostedApiKeyForWorkspace, loadWorkspacePrivacyMode, openRouterCall, privacyModeOf } from "../lib/privacy.js";
import { createHash, randomUUID } from "node:crypto";

import type {
  GroundedSummary,
  GroundedSummaryClaim,
  SearchResult,
  WorkspaceChatEvidenceSpan,
} from "@docslurp/shared";
import { groundedSummarySchema } from "@docslurp/shared";

import { sql } from "../db.js";
import {
  SEARCH_OPENROUTER_MODEL,
  generateOpenRouterDocumentText,
} from "../lib/ai.js";
import { recordUsageEvent } from "../lib/ai-usage.js";
import { hybridSearch } from "./search.js";
import {
  buildFallbackAnswer,
  buildNativeDocumentInputs,
  buildSystemInstructions,
  buildWorkspaceChatEvidenceSpans,
} from "./workspace-chat.js";
import { getWorkspace } from "./workspaces.js";

type GroundedSummaryRow = {
  id: string;
  document_id: string | null;
  run_id: string | null;
  scope: "document" | "workspace" | "section";
  section_key: string | null;
  summary: string;
  claims: GroundedSummaryClaim[];
  citations: SearchResult[];
  evidence_spans: WorkspaceChatEvidenceSpan[];
  source_fingerprint: string;
  created_at: string;
};

function buildSourceFingerprint(results: SearchResult[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        results.map((result) => ({
          documentId: result.citation.documentId,
          chunkIndex: result.citation.chunkIndex,
          pageNumber: result.citation.pageNumber,
          text: result.text,
        })),
      ),
    )
    .digest("hex");
}

function deriveClaimsFromEvidence(
  answer: string,
  evidenceSpans: WorkspaceChatEvidenceSpan[],
): GroundedSummaryClaim[] {
  const bySentence = new Map<string, GroundedSummaryClaim>();

  for (const span of evidenceSpans) {
    const existing = bySentence.get(span.answerText);
    if (existing) {
      if (!existing.citationIndices.includes(span.citationIndex)) {
        existing.citationIndices.push(span.citationIndex);
      }
      existing.citations.push(span.citation);
      existing.sourceSpans.push(span);
      continue;
    }

    bySentence.set(span.answerText, {
      claim: span.answerText,
      citationIndices: [span.citationIndex],
      citations: [span.citation],
      sourceSpans: [span],
    });
  }

  if (bySentence.size === 0 && answer.trim()) {
    return [];
  }

  return Array.from(bySentence.values()).map((claim) => ({
    ...claim,
    citationIndices: claim.citationIndices.sort((left, right) => left - right),
  }));
}

function mapGroundedSummary(row: GroundedSummaryRow): GroundedSummary {
  return groundedSummarySchema.parse({
    id: row.id,
    documentId: row.document_id,
    runId: row.run_id,
    scope: row.scope,
    sectionKey: row.section_key,
    summary: row.summary,
    claims: row.claims ?? [],
    citations: row.citations ?? [],
    evidenceSpans: row.evidence_spans ?? [],
    sourceFingerprint: row.source_fingerprint,
    createdAt: row.created_at,
  });
}

async function persistGroundedSummary(args: {
  userId: string;
  workspaceId: string;
  documentId?: string;
  runId?: string | null;
  scope: "document" | "workspace" | "section";
  sectionKey?: string;
  summary: string;
  claims: GroundedSummaryClaim[];
  citations: SearchResult[];
  evidenceSpans: WorkspaceChatEvidenceSpan[];
  sourceFingerprint: string;
}): Promise<GroundedSummary> {
  const [row] = await sql<GroundedSummaryRow[]>`
    insert into grounded_summaries (
      id,
      user_id,
      document_id,
      run_id,
      workspace_id,
      scope,
      section_key,
      summary,
      claims,
      citations,
      evidence_spans,
      source_fingerprint
    )
    values (
      ${randomUUID()},
      ${args.userId},
      ${args.documentId ?? null},
      ${args.runId ?? null},
      ${args.workspaceId},
      ${args.scope},
      ${args.sectionKey ?? null},
      ${args.summary},
      ${JSON.stringify(args.claims)}::text::jsonb,
      ${JSON.stringify(args.citations)}::text::jsonb,
      ${JSON.stringify(args.evidenceSpans)}::text::jsonb,
      ${args.sourceFingerprint}
    )
    returning
      id,
      document_id,
      run_id,
      scope,
      section_key,
      summary,
      claims,
      citations,
      evidence_spans,
      source_fingerprint,
      created_at::text
  `;

  return mapGroundedSummary(row);
}

export async function generateGroundedSummary(args: {
  userId: string;
  workspaceId: string;
  query: string;
  documentId?: string;
  sectionKey?: string;
  limit?: number;
}): Promise<GroundedSummary> {
  const workspace = await getWorkspace(args.workspaceId, args.userId);
  const retrieved = await hybridSearch(args.query, args.userId, {
    limit: args.limit ?? 8,
    // Internal retrieval from a generic prompt, not a user-typed query: never floored.
    minScore: 0,
    useRerank: true,
    useMmr: true,
    parentRetrieval: true,
    queryRewrite: true,
    stepback: true,
    selfQuery: true,
    filters: {
      workspaceId: args.workspaceId,
      ...(args.documentId ? { documentId: args.documentId } : {}),
    },
  });

  const citations = retrieved.results.slice(0, args.limit ?? 8);
  const fallback = buildFallbackAnswer(args.query, citations);
  const privacyMode = workspace
    ? privacyModeOf(workspace.pipeline)
    : await loadWorkspacePrivacyMode(args.workspaceId);
  const openRouterApiKey = citations.length > 0
    ? await hostedApiKeyForWorkspace({
        apiKey: process.env.OPENROUTER_API_KEY,
        privacyMode,
        workspaceId: args.workspaceId,
        call: openRouterCall("api.grounded-summary", SEARCH_OPENROUTER_MODEL),
      })
    : undefined;

  let summaryText = fallback;
  if (openRouterApiKey && citations.length > 0) {
    try {
      const generated = await generateOpenRouterDocumentText({
        apiKey: openRouterApiKey,
        privacyMode,
        model: SEARCH_OPENROUTER_MODEL,
        system: buildSystemInstructions({
          ingestInstructions: workspace?.systemPrompt ?? null,
          contextLabel: "retrieved source excerpts",
        }),
        prompt: [
          `Create a grounded summary for: ${args.query}`,
          "Every material claim must end with citation markers like [1] or [2].",
          "Keep the summary concise and operational.",
        ].join("\n"),
        documents: buildNativeDocumentInputs(citations),
        maxOutputTokens: 500,
      });
      await recordUsageEvent({
        userId: args.userId,
        scope: { workspaceId: args.workspaceId, orgId: workspace?.orgId },
        usage: {
          provider: "openrouter",
          model: SEARCH_OPENROUTER_MODEL,
          metric: "grounded-summary",
          ...generated.usage,
          metadata: {
            ...generated.usage.metadata,
            documentId: args.documentId ?? null,
            sectionKey: args.sectionKey ?? null,
          },
        },
      });
      summaryText = generated.text.trim() || fallback;
    } catch {
      summaryText = fallback;
    }
  }

  const evidenceSpans = buildWorkspaceChatEvidenceSpans(summaryText, citations);
  const claims = deriveClaimsFromEvidence(summaryText, evidenceSpans);
  const sourceFingerprint = buildSourceFingerprint(citations);

  return await persistGroundedSummary({
    userId: args.userId,
    workspaceId: args.workspaceId,
    documentId: args.documentId,
    runId: citations[0]?.citation.documentId ? null : null,
    scope: args.documentId
      ? "document"
      : args.sectionKey
        ? "section"
        : "workspace",
    sectionKey: args.sectionKey,
    summary: summaryText,
    claims,
    citations,
    evidenceSpans,
    sourceFingerprint,
  });
}
