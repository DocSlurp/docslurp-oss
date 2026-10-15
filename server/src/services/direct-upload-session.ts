import { randomUUID } from "node:crypto";

import type { PipelineFeatureOverrides, WorkspaceTemplateKey } from "@docslurp/shared";

import { sql } from "../db.js";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteUploadedObject,
  getUploadedObjectMetadata,
  signMultipartUploadPart,
  signSingleUploadPut,
} from "../lib/storage.js";
import {
  admitIntakeFile,
  rawSourceKey,
  WorkspaceIntakeError,
  type WorkspaceIntakeItem,
} from "./workspace-intake.js";

const MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;
const MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;

export interface DirectUploadSessionFileInput {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  canonicalId?: string | null;
}

export interface CreateDirectUploadSessionInput {
  userId: string;
  orgId?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  templateKey?: WorkspaceTemplateKey | null;
  /** Upload overrides, merged onto the target workspace pipeline at confirm. */
  pipeline: PipelineFeatureOverrides;
  files: DirectUploadSessionFileInput[];
}

export interface CompleteDirectUploadFileInput {
  sessionId: string;
  userId: string;
  fileId: string;
  etag?: string;
  parts?: Array<{ partNumber: number; etag: string }>;
}

export type UploadSessionRow = {
  id: string;
  user_id: string;
  org_id: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  template_key: string | null;
  pipeline: PipelineFeatureOverrides | null;
  status: string;
};

export type UploadSessionFileRow = {
  id: string;
  session_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  source_key: string;
  upload_mode: string;
  upload_id: string | null;
  part_size: number | null;
  status: string;
  completed_parts: Array<{ partNumber: number; etag: string }> | null;
  canonical_id?: string | null;
};

export interface LoadedDirectUploadSession {
  session: UploadSessionRow;
  files: UploadSessionFileRow[];
}

export interface PreparedDirectUploadWorkspaceIntake {
  session: UploadSessionRow;
  items: WorkspaceIntakeItem[];
}

export function toDirectUploadPartCount(
  sizeBytes: number,
  partSize: number,
): number {
  return Math.max(1, Math.ceil(sizeBytes / partSize));
}

export async function loadDirectUploadSession(
  sessionId: string,
  userId: string,
): Promise<LoadedDirectUploadSession | null> {
  const [session] = await sql<UploadSessionRow[]>`
    select id, user_id, org_id, workspace_id, workspace_name, template_key, pipeline, status
    from upload_sessions
    where id = ${sessionId} and user_id = ${userId}
    limit 1
  `;

  if (!session) {
    return null;
  }

  const rows = await sql<Array<Omit<UploadSessionFileRow, "size_bytes" | "part_size"> & {
    size_bytes: number | string;
    part_size: number | string | null;
  }>>`
    select
      id,
      session_id,
      filename,
      mime_type,
      size_bytes,
      source_key,
      upload_mode,
      upload_id,
      part_size,
      status,
      completed_parts,
      canonical_id
    from upload_session_files
    where session_id = ${sessionId}
    order by created_at asc
  `;

  // PostgreSQL bigint columns arrive as strings; browser file matching and
  // storage size verification require numbers on both sides of the comparison.
  const files = rows.map((file) => ({
    ...file,
    size_bytes: Number(file.size_bytes),
    part_size: file.part_size === null ? null : Number(file.part_size),
  }));
  return { session, files };
}

export async function buildDirectUploadFileDescriptor(file: UploadSessionFileRow) {
  if (file.upload_mode === "single") {
    return {
      id: file.id,
      filename: file.filename,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      mode: "single" as const,
      status: file.status,
      putUrl: await signSingleUploadPut({
        key: file.source_key,
        contentType: file.mime_type,
      }),
    };
  }

  const partSize = file.part_size ?? MULTIPART_PART_SIZE_BYTES;
  const partCount = toDirectUploadPartCount(file.size_bytes, partSize);
  if (!file.upload_id) {
    throw new Error(`Multipart session missing upload id for ${file.id}`);
  }
  const completed = new Set(
    (file.completed_parts ?? []).map((part) => part.partNumber),
  );
  const pendingParts: Array<{
    partNumber: number;
    sizeBytes: number;
    url: string;
  }> = [];

  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    if (completed.has(partNumber)) {
      continue;
    }
    const offset = (partNumber - 1) * partSize;
    const remaining = Math.max(0, file.size_bytes - offset);
    const sizeBytes = Math.min(partSize, remaining);
    pendingParts.push({
      partNumber,
      sizeBytes,
      url: await signMultipartUploadPart({
        key: file.source_key,
        uploadId: file.upload_id,
        partNumber,
      }),
    });
  }

  return {
    id: file.id,
    filename: file.filename,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    mode: "multipart" as const,
    status: file.status,
    uploadId: file.upload_id,
    partSize,
    partCount,
    pendingParts,
    completedParts: file.completed_parts ?? [],
  };
}

export async function createDirectUploadSession(input: CreateDirectUploadSessionInput) {
  // Workspace Intake's policy screens declared files before any upload target exists.
  const files = input.files.map((file) => ({
    ...file,
    ...admitIntakeFile(
      { filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes },
      "direct-upload",
    ),
  }));

  const sessionId = randomUUID();
  await sql`
    insert into upload_sessions (
      id,
      user_id,
      org_id,
      workspace_id,
      workspace_name,
      template_key,
      pipeline,
      status
    )
    values (
      ${sessionId},
      ${input.userId},
      ${input.orgId ?? null},
      ${input.workspaceId ?? null},
      ${input.workspaceName ?? null},
      ${input.templateKey ?? null},
      ${sql.json(JSON.parse(JSON.stringify(input.pipeline)))},
      'pending'
    )
  `;

  for (const file of files) {
    const sourceKey = rawSourceKey(input.userId, file.filename);
    const isMultipart = file.sizeBytes >= MULTIPART_THRESHOLD_BYTES;
    const partSize = isMultipart ? MULTIPART_PART_SIZE_BYTES : null;
    const uploadId = isMultipart
      ? await createMultipartUpload(sourceKey, file.mimeType)
      : null;
    const fileId = randomUUID();

    await sql`
      insert into upload_session_files (
        id,
        session_id,
        filename,
        mime_type,
        size_bytes,
        source_key,
        upload_mode,
        upload_id,
        part_size,
        status,
        sha256,
        canonical_id
      )
      values (
        ${fileId},
        ${sessionId},
        ${file.filename},
        ${file.mimeType},
        ${file.sizeBytes},
        ${sourceKey},
        ${isMultipart ? "multipart" : "single"},
        ${uploadId},
        ${partSize},
        'pending',
        ${file.sha256 ?? null},
        ${file.canonicalId ?? null}
      )
    `;
  }

  const loaded = await loadDirectUploadSession(sessionId, input.userId);
  if (!loaded) {
    throw new WorkspaceIntakeError("Upload session not found", 404);
  }
  return await describeDirectUploadSession(loaded);
}

export async function describeDirectUploadSession(
  loaded: LoadedDirectUploadSession,
) {
  const files = await Promise.all(
    loaded.files.map(async (file) => await buildDirectUploadFileDescriptor(file)),
  );
  return {
    sessionId: loaded.session.id,
    status: loaded.session.status,
    files,
  };
}

/** A native key may only operate on sessions created in its organization. */
export async function directUploadSessionBelongsToOrganization(sessionId: string, userId: string, orgId: string): Promise<boolean> {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  return loaded?.session.org_id === orgId;
}

export async function getDirectUploadSessionDescription(
  sessionId: string,
  userId: string,
) {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  return loaded ? await describeDirectUploadSession(loaded) : null;
}

export async function completeDirectUploadFile(input: CompleteDirectUploadFileInput) {
  const loaded = await loadDirectUploadSession(input.sessionId, input.userId);
  if (!loaded) {
    throw new WorkspaceIntakeError("Upload session not found", 404);
  }

  const file = loaded.files.find((item) => item.id === input.fileId);
  if (!file) {
    throw new WorkspaceIntakeError("Upload file not found", 404);
  }

  if (file.upload_mode === "multipart") {
    if (!file.upload_id || !input.parts || input.parts.length === 0) {
      throw new WorkspaceIntakeError(
        "Multipart completion requires parts and uploadId",
        400,
      );
    }
    await completeMultipartUpload({
      key: file.source_key,
      uploadId: file.upload_id,
      parts: input.parts,
    });
    await verifyCompletedDirectUpload(file);
    await sql`
      update upload_session_files
      set status = 'completed',
          completed_parts = ${sql.json(input.parts)}::jsonb,
          updated_at = now()
      where id = ${file.id}
    `;
  } else {
    const verified = await verifyCompletedDirectUpload(file);
    await sql`
      update upload_session_files
      set status = 'completed',
          etag = ${verified.etag ?? input.etag ?? null},
          updated_at = now()
      where id = ${file.id}
    `;
  }

  await sql`
    update upload_sessions
    set status = 'uploading',
        updated_at = now()
    where id = ${input.sessionId}
  `;
}

export async function abortDirectUploadSession(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  if (!loaded) {
    return false;
  }

  for (const file of loaded.files) {
    if (file.upload_mode === "multipart" && file.upload_id) {
      await abortMultipartUpload({
        key: file.source_key,
        uploadId: file.upload_id,
      }).catch(() => undefined);
    }
  }

  await sql`
    update upload_session_files
    set status = 'aborted',
        updated_at = now()
    where session_id = ${sessionId}
  `;
  await sql`
    update upload_sessions
    set status = 'aborted',
        updated_at = now()
    where id = ${sessionId}
  `;

  return true;
}

export function assertDirectUploadSessionReadyForIntake(
  loaded: LoadedDirectUploadSession,
): void {
  if (loaded.session.status === "confirmed") {
    throw new WorkspaceIntakeError(
      "Upload session is already confirmed",
      409,
    );
  }

  if (loaded.session.status === "aborted") {
    throw new WorkspaceIntakeError("Upload session has been aborted", 409);
  }

  if (loaded.files.length === 0) {
    throw new WorkspaceIntakeError("Upload session has no files", 400);
  }

  const incomplete = loaded.files.find((file) => file.status !== "completed");
  if (incomplete) {
    throw new WorkspaceIntakeError(
      `File ${incomplete.filename} is not completed yet`,
      409,
    );
  }
}

export async function prepareDirectUploadWorkspaceIntake(
  sessionId: string,
  userId: string,
): Promise<PreparedDirectUploadWorkspaceIntake> {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  if (!loaded) {
    throw new WorkspaceIntakeError("Upload session not found", 404);
  }

  assertDirectUploadSessionReadyForIntake(loaded);

  return {
    session: loaded.session,
    items: directUploadIntakeItems(loaded),
  };
}

export async function markDirectUploadSessionConfirmed(args: {
  sessionId: string;
  workspaceId: string;
  orgId: string;
}): Promise<void> {
  await sql`
    update upload_sessions
    set status = 'confirmed',
        workspace_id = ${args.workspaceId},
        org_id = ${args.orgId},
        updated_at = now()
    where id = ${args.sessionId}
  `;
}

/** Completed session files are already in object storage; intake reuses their keys. */
export function directUploadIntakeItems(
  loaded: LoadedDirectUploadSession,
): WorkspaceIntakeItem[] {
  return loaded.files.map((file) => ({
    filename: file.filename,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    canonicalId: file.canonical_id ?? null,
    content: { storedKey: file.source_key },
  }));
}

async function verifyCompletedDirectUpload(
  file: UploadSessionFileRow,
): Promise<{ etag: string | null }> {
  const metadata = await getUploadedObjectMetadata(file.source_key);
  const actualSize = metadata.contentLength;
  if (actualSize === null) {
    throw new Error(`Unable to verify upload size for ${file.filename}`);
  }
  admitIntakeFile(
    { filename: file.filename, mimeType: file.mime_type, sizeBytes: actualSize },
    "direct-upload",
  );
  if (actualSize !== file.size_bytes) {
    await deleteUploadedObject(file.source_key).catch(() => undefined);
    throw new Error(
      `Uploaded size for ${file.filename} did not match the declared size`,
    );
  }
  return { etag: metadata.etag };
}
