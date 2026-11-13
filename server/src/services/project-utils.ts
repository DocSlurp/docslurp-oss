import { upgradeStoredPipelineChartExport } from "@docslurp/shared";
import { projectSchema, type SearchResult, type ProjectRecord } from "@docslurp/shared";

export interface ProjectVersionSnapshot {
  name: string;
  templateKey: ProjectRecord["templateKey"];
  systemPrompt: ProjectRecord["systemPrompt"];
  pipeline: ProjectRecord["pipeline"];
}

export interface ProjectChatAuditCitation {
  documentId: string;
  chunkIndex: number;
  filename: string;
  pageNumber: number | null;
  score: number;
  regionBox: { pageNumber: number; x: number; y: number; width: number; height: number } | null;
  regionCoordinateSpace: string | null;
  sourceTrace: Record<string, unknown> | null;
}

export function createProjectVersionSnapshot(
  project: Pick<ProjectRecord, "name" | "templateKey" | "systemPrompt" | "pipeline">
): ProjectVersionSnapshot {
  return {
    name: project.name,
    templateKey: project.templateKey ?? null,
    systemPrompt: project.systemPrompt ?? null,
    pipeline: JSON.parse(JSON.stringify(project.pipeline)),
  };
}

export function readProjectVersionSnapshot(
  metadata: Record<string, unknown> | null | undefined
): ProjectVersionSnapshot | null {
  const snapshot = metadata?.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const candidate = snapshot as Partial<ProjectVersionSnapshot>;
  if (typeof candidate.name !== "string" || !("templateKey" in candidate) || !("systemPrompt" in candidate) || !("pipeline" in candidate)) {
    return null;
  }

  // Snapshots saved before migration 0145 carry chartExport.enabled/generatorModel; the audit log is never rewritten,
  // so they are mapped on read (`enabled: true` -> tier `models`).
  const parsed = projectSchema.pick({
    name: true,
    templateKey: true,
    systemPrompt: true,
    pipeline: true,
  }).safeParse({ ...candidate, pipeline: upgradeStoredPipelineChartExport(candidate.pipeline) });

  if (!parsed.success) {
    return null;
  }

  return {
    name: parsed.data.name,
    templateKey: parsed.data.templateKey ?? null,
    systemPrompt: parsed.data.systemPrompt ?? null,
    pipeline: parsed.data.pipeline,
  };
}

export function buildClonedProjectName(name: string): string {
  const trimmed = name.trim();
  return trimmed.toLowerCase().endsWith(" copy") ? `${trimmed} 2` : `${trimmed} copy`;
}

export function buildProjectChatAuditMetadata(args: {
  query: string;
  searchSessionId: string | null;
  model: string | null;
  fallback: boolean;
  citations: SearchResult[];
}): Record<string, unknown> {
  return {
    query: args.query,
    searchSessionId: args.searchSessionId,
    model: args.model,
    fallback: args.fallback,
    citations: args.citations.length,
    topCitations: args.citations.slice(0, 4).map((citation): ProjectChatAuditCitation => ({
      documentId: citation.citation.documentId,
      chunkIndex: citation.citation.chunkIndex,
      filename: citation.citation.filename,
      pageNumber: citation.citation.pageNumber ?? null,
      score: citation.score,
      regionBox: citation.citation.regionBoxes[0] ?? null,
      regionCoordinateSpace: citation.citation.regionCoordinateSpace ?? null,
      sourceTrace: citation.citation.sourceTrace ?? null
    })),
  };
}
