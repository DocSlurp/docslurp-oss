import type { PipelineFeatures } from "@docslurp/shared";

import { sql as defaultSql, type SqlClient } from "../db.js";
import { createDocumentBatch, createRun } from "./runs.js";

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
  files: RunManifestFile[];
}

export async function createRunManifest(input: CreateRunManifestInput) {
  const run = await createRun({
    userId: input.userId,
    workspaceId: input.workspaceId,
    kind: input.kind,
    totalDocuments: input.files.length,
    pipeline: input.pipeline,
    apiKeyId: input.apiKeyId ?? null,
  });

  let documents: Awaited<ReturnType<typeof createDocumentBatch>>;
  try {
    documents = await createDocumentBatch({
      userId: input.userId,
      workspaceId: input.workspaceId,
      runId: run.id,
      files: input.files,
    });
  } catch (error) {
    // The Run row is already committed. Without this, a failed document insert
    // leaves a queued Run the client never sees, which a sweep would start later.
    await discardUnstartedRun(run.id).catch((cleanupError: unknown) => {
      console.error(
        `[intake] could not discard run=${run.id} after document creation failed:`,
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      );
    });
    throw error;
  }

  const pagesTotal = documents.reduce(
    (total, document) => total + Math.max(0, document.pageCount ?? 0),
    0,
  );

  return { run: { ...run, pagesTotal }, documents };
}

/**
 * Remove a Run whose intake failed before its workflow was started, with any
 * Documents already inserted for it (child rows cascade with the Run). Only a
 * still-queued Run is removed, so a Run that something else picked up is kept.
 */
export async function discardUnstartedRun(runId: string, sql: SqlClient = defaultSql): Promise<boolean> {
  return await sql.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    const [locked] = await client<{ id: string }[]>`
      select id from workspace_runs where id = ${runId} and status = 'queued' for update
    `;
    if (!locked) return false;
    await client`delete from documents where run_id = ${runId}`;
    await client`delete from workspace_runs where id = ${runId}`;
    return true;
  });
}
