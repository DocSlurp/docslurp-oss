import { workspaceSchema, type SearchResult, type WorkspaceRecord } from "@docslurp/shared";

export interface WorkspaceVersionSnapshot {
  name: string;
  templateKey: WorkspaceRecord["templateKey"];
  systemPrompt: WorkspaceRecord["systemPrompt"];
  pipeline: WorkspaceRecord["pipeline"];
}

export interface WorkspaceChatAuditCitation {
  documentId: string;
  chunkIndex: number;
  filename: string;
  pageNumber: number | null;
  score: number;
  regionBox: { pageNumber: number; x: number; y: number; width: number; height: number } | null;
  regionCoordinateSpace: string | null;
  sourceTrace: Record<string, unknown> | null;
}

export function createWorkspaceVersionSnapshot(
  workspace: Pick<WorkspaceRecord, "name" | "templateKey" | "systemPrompt" | "pipeline">
): WorkspaceVersionSnapshot {
  return {
    name: workspace.name,
    templateKey: workspace.templateKey ?? null,
    systemPrompt: workspace.systemPrompt ?? null,
    pipeline: JSON.parse(JSON.stringify(workspace.pipeline)),
  };
}

export function readWorkspaceVersionSnapshot(
  metadata: Record<string, unknown> | null | undefined
): WorkspaceVersionSnapshot | null {
  const snapshot = metadata?.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const candidate = snapshot as Partial<WorkspaceVersionSnapshot>;
  if (typeof candidate.name !== "string" || !("templateKey" in candidate) || !("systemPrompt" in candidate) || !("pipeline" in candidate)) {
    return null;
  }

  const parsed = workspaceSchema.pick({
    name: true,
    templateKey: true,
    systemPrompt: true,
    pipeline: true,
  }).safeParse(snapshot);

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

export function buildClonedWorkspaceName(name: string): string {
  const trimmed = name.trim();
  return trimmed.toLowerCase().endsWith(" copy") ? `${trimmed} 2` : `${trimmed} copy`;
}

export function buildWorkspaceChatAuditMetadata(args: {
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
    topCitations: args.citations.slice(0, 4).map((citation): WorkspaceChatAuditCitation => ({
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
