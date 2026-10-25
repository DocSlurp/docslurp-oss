import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  DOCUMENT_EXPORT_MAX_BYTES,
  DOCUMENT_EXPORT_MAX_DOCUMENTS,
  DOCUMENT_EXPORT_TTL_DAYS,
  documentExportFolderNames,
  safeExportName,
  type DocumentExportContent,
} from "@docslurp/shared";
import type { Sql } from "postgres";

import { keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";
import { zipStream, type ZipStreamBody, type ZipStreamEntry } from "./zip-stream.js";

/**
 * Builds one queued document export: streams each document's files from
 * storage through a zip encoder into a multipart upload, so the worker holds
 * one chunk and one upload part at a time however large the export is.
 *
 * Layout: one folder per document (a document export is just that folder) with
 * `<name>.md`, `pages/page-0001.md`, `structured.json` and `metadata.json`;
 * "all" adds `original/`, `images/` and `outputs/`. `README.md` comes last and
 * lists anything left out.
 */

/** Pipeline outputs worth handing to a person, by artifact slot name. Indexes and vectors stay out. */
const READABLE_OUTPUTS = new Set([
  "html",
  "canonical-document",
  "heatmap",
  "document-summary",
  "document-map",
  "classification",
  "format-detect",
  "markdown-manifest",
  "html-manifest",
  "images",
  "media-summary",
]);

const PAGE_IMAGE_SLOT = /^page-(\d+)$/;

interface ExportRow {
  id: string;
  org_id: string;
  workspace_id: string;
  document_id: string | null;
  content: DocumentExportContent;
  filename: string;
  object_key: string;
  expires_at: Date;
}

export interface ExportDocumentRow {
  id: string;
  workspace_id: string;
  run_id: string | null;
  filename: string;
  mime_type: string;
  source_key: string;
  status: string;
  extraction_mode: string;
  page_count: number;
  version_number: number | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
  tags: string[];
  artifacts: Record<string, string> | null;
}

export interface ExportSource {
  /** Pages in order for one document. */
  pages(documentId: string): Promise<Array<{ page_number: number; text: string }>>;
  /** An object by key, streamed. */
  open(key: string): Promise<{ stream: AsyncIterable<Uint8Array>; size: number | null }>;
  bucket: string;
}

function pageLabel(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(4, "0")}`;
}

function extensionOf(key: string, fallback: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(key.split("?")[0] ?? "");
  return match ? `.${match[1]!.toLowerCase()}` : fallback;
}

/** Where a document's run artifact lands in its folder, or null to leave it out. */
export function artifactExportPath(slotName: string, uri: string): { path: string; compress: boolean } | null {
  const page = PAGE_IMAGE_SLOT.exec(slotName);
  if (page) return { path: `images/${pageLabel(Number(page[1]))}${extensionOf(uri, ".png")}`, compress: false };
  if (!READABLE_OUTPUTS.has(slotName)) return null;
  return { path: `outputs/${slotName}${extensionOf(uri, ".json")}`, compress: true };
}

/** Media and already-compressed formats are stored, everything else deflated. */
function compressible(mimeType: string): boolean {
  return !/^(image|audio|video)\//.test(mimeType) && !/zip|compressed|pdf|epub|officedocument|msword|ms-excel/.test(mimeType);
}

async function readText(source: ExportSource, key: string): Promise<string> {
  const { stream } = await source.open(key);
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

export async function* documentExportEntries(
  args: { root: string; scope: "document" | "workspace"; content: DocumentExportContent; documents: ExportDocumentRow[]; truncated: boolean },
  source: ExportSource,
  skipped: Array<{ path: string; reason: string }>,
): AsyncGenerator<ZipStreamEntry> {
  const folders = args.scope === "document"
    ? [args.root]
    : documentExportFolderNames(args.documents.map((row) => row.filename)).map((name) => `${args.root}/${name}`);
  const keyOf = (uri: string) => keyFromStorageUri(uri, source.bucket);
  const streamed = (key: string) => async (): Promise<ZipStreamBody> => await source.open(key);

  for (const [index, row] of args.documents.entries()) {
    const folder = folders[index]!;
    const stem = folder.slice(folder.lastIndexOf("/") + 1);
    const modifiedAt = new Date(row.updated_at);
    const withheld = withheldUris(row.metadata);
    const completed = row.status === "completed";
    const prefix = `${row.id}:`;
    const artifacts = completed
      ? Object.entries(row.artifacts ?? {})
          .filter(([slot, uri]) => slot.startsWith(prefix) && !withheld.has(uri) && keyOf(uri))
          .map(([slot, uri]) => ({ name: slot.slice(prefix.length), uri, key: keyOf(uri)! }))
          .sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true }))
      : [];
    const artifactKey = (name: string) => artifacts.find((entry) => entry.name === name)?.key ?? null;
    const pages = completed ? await source.pages(row.id) : [];

    const markdownKey = artifactKey("markdown");
    yield {
      path: `${folder}/${stem}.md`,
      compress: true,
      modifiedAt,
      body: async () => {
        const markdown = markdownKey ? await readText(source, markdownKey).catch(() => "") : "";
        if (markdown.trim()) return markdown;
        const joined = pages.map((page) => page.text).filter((text) => text.trim()).join("\n\n");
        return joined || null;
      },
    };

    if (pages.length > 1) {
      for (const page of pages) {
        yield { path: `${folder}/pages/${pageLabel(page.page_number)}.md`, compress: true, modifiedAt, body: async () => page.text };
      }
    }

    const structuredKey = artifactKey("structured");
    if (structuredKey) {
      yield {
        path: `${folder}/structured.json`,
        compress: true,
        modifiedAt,
        body: async () => {
          const text = await readText(source, structuredKey);
          try {
            return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
          } catch {
            return text;
          }
        },
      };
    }

    if (args.content === "all") {
      if (!withheld.has(`s3://${source.bucket}/${row.source_key}`)) {
        yield {
          path: `${folder}/original/${safeExportName(row.filename, "original")}`,
          compress: compressible(row.mime_type),
          modifiedAt,
          body: streamed(row.source_key),
        };
      }
      for (const entry of artifacts) {
        const target = artifactExportPath(entry.name, entry.key);
        if (target) yield { path: `${folder}/${target.path}`, compress: target.compress, modifiedAt, body: streamed(entry.key) };
      }
    }

    yield {
      path: `${folder}/metadata.json`,
      compress: true,
      modifiedAt,
      body: async () => `${JSON.stringify({
        id: row.id,
        filename: row.filename,
        mimeType: row.mime_type,
        status: row.status,
        pageCount: Math.max(row.page_count, pages.length),
        version: row.version_number ?? 1,
        extractionMode: row.extraction_mode,
        tags: row.tags,
        workspaceId: row.workspace_id,
        runId: row.run_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }, null, 2)}\n`,
    };
  }

  yield {
    path: `${args.root}/README.md`,
    compress: true,
    required: true,
    body: async () => exportReadme(args, folders.map((folder) => folder.slice(args.root.length + 1) || "."), skipped),
  };
}

function withheldUris(metadata: unknown): Set<string> {
  const pii = metadata && typeof metadata === "object" ? (metadata as { pii?: unknown }).pii : null;
  const list = pii && typeof pii === "object" ? (pii as { withheldArtifactUris?: unknown }).withheldArtifactUris : null;
  return new Set(Array.isArray(list) ? list.filter((uri): uri is string => typeof uri === "string") : []);
}

function exportReadme(
  args: { root: string; content: DocumentExportContent; documents: ExportDocumentRow[]; truncated: boolean },
  folders: string[],
  skipped: Array<{ path: string; reason: string }>,
): string {
  const count = args.documents.length;
  const lines = [
    `# ${args.root}`,
    "",
    `Exported from DocSlurp on ${new Date().toISOString().slice(0, 10)}: ${count} ${count === 1 ? "document" : "documents"}, ${args.content === "all" ? "Markdown and all assets" : "Markdown and data"}.`,
    "",
    "Each document folder holds:",
    "",
    "- `<name>.md`: the extracted Markdown for the whole document",
    "- `pages/page-0001.md`: the same text page by page (documents with more than one page)",
    "- `structured.json`: fields extracted against the workspace schema, when it has one",
    "- `metadata.json`: filename, type, status, page count, version and tags",
  ];
  if (args.content === "all") {
    lines.push(
      "- `original/`: the uploaded file",
      "- `images/`: rendered page images, for pages that were rendered",
      "- `outputs/`: other readable pipeline outputs, such as HTML and the canonical document",
    );
  }
  if (count > 1) {
    lines.push("", "## Documents", "", "| Folder | File | Pages | Status |", "| --- | --- | ---: | --- |");
    args.documents.forEach((row, index) => {
      lines.push(`| ${cell(folders[index]!)} | ${cell(row.filename)} | ${row.page_count} | ${row.status} |`);
    });
  }
  if (args.truncated) {
    lines.push("", `Only the first ${DOCUMENT_EXPORT_MAX_DOCUMENTS.toLocaleString("en-US")} documents are included. Export the rest one document at a time.`);
  }
  if (skipped.length > 0) {
    lines.push("", "## Not included", "");
    for (const entry of skipped) lines.push(`- \`${entry.path.slice(args.root.length + 1)}\`: ${entry.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

const documentColumns = (sql: Sql) => sql`
  d.id, d.workspace_id, d.run_id, d.filename, d.mime_type, d.source_key, d.status, d.extraction_mode,
  d.page_count, d.version_number, d.metadata, d.created_at::text, d.updated_at::text,
  coalesce((select array_agg(dt.tag order by dt.tag) from document_tags dt where dt.document_id = d.id), '{}') as tags,
  r.artifacts
`;

/** The export's documents: the one document, or the workspace's current, live versions. */
export async function loadExportDocuments(sql: Sql, row: Pick<ExportRow, "workspace_id" | "document_id">): Promise<{ documents: ExportDocumentRow[]; truncated: boolean }> {
  if (row.document_id) {
    const documents = await sql<ExportDocumentRow[]>`
      select ${documentColumns(sql)}
      from documents d left join workspace_runs r on r.id = d.run_id
      where d.id = ${row.document_id} and d.workspace_id = ${row.workspace_id} and d.purged_at is null
    `;
    return { documents, truncated: false };
  }
  const documents = await sql<ExportDocumentRow[]>`
    select ${documentColumns(sql)}
    from documents d left join workspace_runs r on r.id = d.run_id
    where d.workspace_id = ${row.workspace_id}
      and d.superseded_at is null and d.archived_at is null and d.purged_at is null
      and not exists (select 1 from documents newer where newer.previous_version_id = d.id)
    order by lower(d.filename), d.created_at
    limit ${DOCUMENT_EXPORT_MAX_DOCUMENTS + 1}
  `;
  return { documents: documents.slice(0, DOCUMENT_EXPORT_MAX_DOCUMENTS), truncated: documents.length > DOCUMENT_EXPORT_MAX_DOCUMENTS };
}

/**
 * Runs one export to completion. `final` marks the last attempt: only then is a
 * failure recorded, so a retried storage hiccup does not show the user an error.
 */
export async function buildDocumentExport(
  deps: { sql: Sql; storage: ArtifactStore },
  exportId: string,
  options: { signal?: AbortSignal; heartbeat?: () => void; final?: boolean; maxBytes?: number } = {},
): Promise<{ status: "ready" | "skipped"; sizeBytes?: number }> {
  const { sql, storage } = deps;
  const [row] = await sql<ExportRow[]>`
    update document_exports set status = 'running', started_at = coalesce(started_at, now())
    where id = ${exportId} and status in ('queued', 'running') and expires_at > now()
    returning id, org_id, workspace_id, document_id, content, filename, object_key, expires_at
  `;
  if (!row) return { status: "skipped" };

  try {
    const { documents, truncated } = await loadExportDocuments(sql, row);
    if (documents.length === 0) throw new Error("Nothing to export: the document or workspace has no documents left.");
    const root = row.filename.replace(/\.zip$/i, "");
    const skipped: Array<{ path: string; reason: string }> = [];
    let files = 0;
    let sizeBytes = 0;
    const source: ExportSource = {
      bucket: storage.bucket,
      open: (key) => storage.openStream(key, options.signal),
      pages: async (documentId) => await sql<Array<{ page_number: number; text: string }>>`
        select page_number, text from document_pages where document_id = ${documentId} order by page_number
      `,
    };
    const entries = documentExportEntries({ root, scope: row.document_id ? "document" : "workspace", content: row.content, documents, truncated }, source, skipped);
    const counted = async function* (): AsyncGenerator<ZipStreamEntry> {
      for await (const entry of entries) {
        options.heartbeat?.();
        yield entry;
      }
    };
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of zipStream(counted(), {
        maxBytes: options.maxBytes ?? DOCUMENT_EXPORT_MAX_BYTES,
        onSkip: (path, reason) => skipped.push({ path, reason }),
        onAdd: () => { files += 1; },
      })) {
        sizeBytes += chunk.byteLength;
        yield chunk;
      }
    };
    const upload = storage.createMultipartUploadStream(row.object_key, "application/zip", {
      object: {
        expires: row.expires_at,
        metadata: { "docslurp-expires-at": row.expires_at.toISOString(), "docslurp-export-id": row.id, "docslurp-ttl-days": String(DOCUMENT_EXPORT_TTL_DAYS) },
      },
    });
    await Promise.all([pipeline(Readable.from(chunks()), upload.writable, { signal: options.signal }), upload.done]);

    await sql`
      update document_exports
      set status = 'ready', completed_at = now(), size_bytes = ${sizeBytes}, file_count = ${files},
        skipped_count = ${skipped.length}, document_count = ${documents.length}, error = null
      where id = ${row.id}
    `;
    console.log(`[document-export] ready export=${row.id} documents=${documents.length} files=${files} skipped=${skipped.length} bytes=${sizeBytes}`);
    return { status: "ready", sizeBytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[document-export] failed export=${row.id} final=${options.final ?? true}: ${message}`);
    if (options.final ?? true) {
      await sql`
        update document_exports set status = 'failed', completed_at = now(), error = ${publicExportError(message)}
        where id = ${row.id}
      `;
    }
    throw error;
  }
}

function publicExportError(message: string): string {
  return message.startsWith("Nothing to export") ? message : "The export could not be built. Try again; if it keeps failing, contact support.";
}
