import type { PipelineFeatures } from "@docslurp/shared";

import { completeRunCreation } from "./run-creation.js";
import { createDocumentBatch, createRun } from "./runs.js";
import { AllSourcesUnreadableError, type UnreadableSourceError } from "./source-metadata.js";

export { discardUnstartedRun } from "./run-creation.js";

export interface RunManifestFile {
  filename: string;
  mimeType: string;
  sourceKey: string;
  fileSize?: number;
  metadata?: Record<string, unknown>;
  canonicalId?: string | null;
}

export interface CreateRunManifestInput {
  userId: string;
  workspaceId: string;
  kind: string;
  pipeline: PipelineFeatures;
  apiKeyId?: string | null;
  /** Files that cannot be read (corrupt PDFs) are left out and reported in `unreadable`. */
  files: RunManifestFile[];
}

export interface UnreadableManifestFile {
  filename: string;
  sourceKey: string;
  error: UnreadableSourceError;
}

export async function createRunManifest(input: CreateRunManifestInput) {
  const run = await createRun({
    userId: input.userId,
    workspaceId: input.workspaceId,
    kind: input.kind,
    totalDocuments: input.files.length,
    pipeline: input.pipeline,
    apiKeyId: input.apiKeyId ?? null,
  }, { sourceKeys: input.files.map((file) => file.sourceKey) });

  return await completeRunCreation(run.id, async () => {
    const unreadable: UnreadableManifestFile[] = [];
    const documents = await createDocumentBatch({
      userId: input.userId,
      workspaceId: input.workspaceId,
      runId: run.id,
      files: input.files,
      onUnreadable: (file, error) => { unreadable.push({ ...file, error }); },
    });
    if (unreadable.length > 0 && documents.length === 0) {
      throw new AllSourcesUnreadableError(unreadable.map((file) => file.error));
    }

    const pagesTotal = documents.reduce(
      (total, document) => total + Math.max(0, document.pageCount ?? 0),
      0,
    );

    return {
      totalDocuments: documents.length,
      value: { run: { ...run, pagesTotal, totalDocuments: documents.length }, documents, unreadable },
    };
  });
}
