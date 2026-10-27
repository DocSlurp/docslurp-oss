import { z } from "zod";

/**
 * Zip exports of a document or a workspace. The server records and queues an
 * export; the worker builds it into object storage; the download link lives
 * seven days and the maintenance sweep deletes the object after that.
 */
export const DOCUMENT_EXPORT_WORKFLOW = "buildDocumentExport";
/** Exports the requester waits for (under the email threshold). */
export const DEFAULT_DOCUMENT_EXPORT_TASK_QUEUE = "docslurp-document-export";
/** Large, emailed exports, on their own queue so they never hold up small ones. */
export const DEFAULT_LARGE_DOCUMENT_EXPORT_TASK_QUEUE = "docslurp-document-export-large";

/** How long a finished export's link works, counted from when it is ready. Said in the UI and the email. */
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
  /** The link stops working at this time (7 days after it became ready; an upper bound until then). */
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
 * exports/<org>/<workspace>/<export>/: everything an export writes lives under
 * this prefix (one zip per worker attempt, `a<attempt>.zip`), so cleanup can
 * remove a prefix and a bucket lifecycle rule can target `exports/`. The
 * readable name is applied as Content-Disposition when the link is signed.
 */
export function documentExportObjectPrefix(args: { orgId: string; workspaceId: string; exportId: string }): string {
  return `exports/${args.orgId}/${args.workspaceId}/${args.exportId}/`;
}

/** Longest file or folder name an export writes, so paths stay well under Windows' 260 characters. */
const EXPORT_NAME_MAX_CHARS = 60;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * A file or folder name that unzips cleanly on Windows, macOS and Linux:
 * no separators or control characters, no leading dots, no trailing dots or
 * spaces, no reserved device names, at most 60 characters (whole code points),
 * keeping `keepExtension`'s extension when the name is shortened.
 */
export function safeExportName(value: string, fallback = "document", options: { keepExtension?: boolean } = {}): string {
  const cleaned = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+/, "");
  const dot = options.keepExtension ? cleaned.lastIndexOf(".") : -1;
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  const stem = Array.from(extension ? cleaned.slice(0, dot) : cleaned)
    .slice(0, EXPORT_NAME_MAX_CHARS - extension.length)
    .join("")
    .replace(/[\s.]+$/, "");
  if (!stem) return fallback;
  return `${WINDOWS_RESERVED.test(stem) ? `${stem}_` : stem}${extension}`;
}

/** A filename without its last extension: "Q3 plan.pdf" → "Q3 plan". */
export function exportFileStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Folder names for documents, unique within one archive, ignoring case
 * ("Report", "report (2)"), and never "README", which names the archive index.
 */
export function documentExportFolderNames(filenames: string[]): string[] {
  const used = new Set(["readme", "readme.md"]);
  return filenames.map((filename) => {
    const stem = safeExportName(exportFileStem(filename));
    let candidate = stem;
    for (let count = 2; used.has(candidate.toLowerCase()); count += 1) candidate = `${stem} (${count})`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/** RFC 5987 `filename*` value: percent-encodes everything outside attr-char. */
export function rfc5987Encode(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
