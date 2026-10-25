import { z } from "zod";

/**
 * Zip exports of a document or a workspace. The server records and queues an
 * export; the worker builds it into object storage; the download link lives
 * seven days and the maintenance sweep deletes the object after that.
 */
export const DOCUMENT_EXPORT_WORKFLOW = "buildDocumentExport";
export const DEFAULT_DOCUMENT_EXPORT_TASK_QUEUE = "docslurp-document-export";

/** How long a finished export's link works. Said in the UI and the email. */
export const DOCUMENT_EXPORT_TTL_DAYS = 7;
/** Exports estimated above this size are emailed when ready instead of waited on. */
export const DOCUMENT_EXPORT_EMAIL_THRESHOLD_BYTES = 250 * 1024 * 1024;
/** The largest export accepted. Zip without ZIP64 tops out at 4 GiB. */
export const DOCUMENT_EXPORT_MAX_BYTES = 3 * 1024 * 1024 * 1024;
/** Most documents in one workspace export. */
export const DOCUMENT_EXPORT_MAX_DOCUMENTS = 5_000;

export const documentExportContentSchema = z.enum(["markdown", "all"]);
export type DocumentExportContent = z.infer<typeof documentExportContentSchema>;

export const documentExportRequestSchema = z.object({
  /** One document. Omit to export a workspace. */
  documentId: z.string().min(1).optional(),
  /** A workspace UUID, slug or `default`; omitted means the organization's default workspace. */
  workspaceId: z.string().min(1).optional(),
  /** "markdown": Markdown, per-page Markdown, structured data, metadata. "all": plus originals, page images and readable outputs. */
  content: documentExportContentSchema.default("markdown"),
}).refine((value) => !(value.documentId && value.workspaceId), {
  message: "Pass documentId or workspaceId, not both",
});
export type DocumentExportRequest = z.infer<typeof documentExportRequestSchema>;

export const documentExportStatusSchema = z.enum(["queued", "running", "ready", "failed", "expired"]);
export type DocumentExportStatus = z.infer<typeof documentExportStatusSchema>;

export const documentExportSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  documentId: z.string().nullable(),
  content: documentExportContentSchema,
  status: documentExportStatusSchema,
  filename: z.string(),
  documentCount: z.number().int(),
  estimatedBytes: z.number(),
  sizeBytes: z.number().nullable(),
  /** Files left out (unreadable, or past the size limit); the zip's README lists them. */
  skippedCount: z.number().int().nullable(),
  /** True when the requester is emailed a link once the export is ready. */
  notifyEmail: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  /** The link stops working at this time. */
  expiresAt: z.string(),
  /** Present once ready and until expiresAt: an authenticated link that redirects to the file. */
  downloadUrl: z.string().nullable(),
});
export type DocumentExport = z.infer<typeof documentExportSchema>;

export interface BuildDocumentExportInput {
  exportId: string;
}

export function documentExportWorkflowId(exportId: string): string {
  return `document-export:${exportId}`;
}

/**
 * exports/<org>/<workspace>/<export>.zip, so a bucket lifecycle rule can also target `exports/`.
 * The readable name is applied as Content-Disposition when the link is signed.
 */
export function documentExportObjectKey(args: { orgId: string; workspaceId: string; exportId: string }): string {
  return `exports/${args.orgId}/${args.workspaceId}/${args.exportId}.zip`;
}

/** A file or folder name that unzips cleanly on Windows, macOS and Linux. */
export function safeExportName(value: string, fallback = "document"): string {
  const cleaned = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+|[\s.]+$/g, "")
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/** A filename without its last extension: "Q3 plan.pdf" → "Q3 plan". */
export function exportFileStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Folder names for documents, unique within one archive ("Report", "report (2)"). */
export function documentExportFolderNames(filenames: string[]): string[] {
  const used = new Map<string, number>();
  return filenames.map((filename) => {
    const stem = safeExportName(exportFileStem(filename));
    const key = stem.toLowerCase();
    const count = (used.get(key) ?? 0) + 1;
    used.set(key, count);
    return count === 1 ? stem : `${stem} (${count})`;
  });
}
