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
import { discard, ZIP_MAX_ENTRIES, zipStream, type ZipStreamBody, type ZipStreamEntry } from "./zip-stream.js";

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

/** Activity attempts (temporal/workflows.ts); only the last records a failure. */
export const DOCUMENT_EXPORT_MAX_ATTEMPTS = 4;

interface ExportRow {
  id: string;
  org_id: string;
  workspace_id: string;
  document_id: string | null;
  /** Extract downloads: only this run's documents. */
  run_id?: string | null;
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
  /** This document's run artifacts by slot, loaded once per export (loadExportArtifacts). */
  artifacts: Record<string, string> | null;
}

/** Structured outputs up to this size are pretty-printed; larger ones stream as stored. */
const PRETTY_JSON_MAX_BYTES = 8 * 1024 * 1024;

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

async function readText(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

export async function* documentExportEntries(
  args: {
    root: string;
    scope: "document" | "workspace";
    content: DocumentExportContent;
    documents: ExportDocumentRow[];
    truncated: boolean;
    /** Leave out pages/*.md so the archive stays under the zip file-count limit. */
    omitPageFiles?: boolean;
  },
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
    if (completed && args.content === "all") {
      for (const [slot, uri] of Object.entries(row.artifacts ?? {})) {
        const target = slot.startsWith(prefix) && withheld.has(uri) ? artifactExportPath(slot.slice(prefix.length), uri) : null;
        if (target) skipped.push({ path: `${folder}/${target.path}`, reason: "withheld by the workspace's privacy (PII) policy" });
      }
    }
    const pages = completed ? await source.pages(row.id) : [];
    if (!completed) {
      skipped.push({ path: `${folder}/`, reason: row.status === "failed" ? "processing failed, so only metadata.json is included" : "still processing, so only metadata.json is included; export again when it finishes" });
    }

    const markdownKey = artifactKey("markdown");
    yield {
      path: `${folder}/${stem}.md`,
      compress: true,
      modifiedAt,
      // Streamed as stored; the indexed page text stands in when there is no Markdown artifact.
      body: async () => {
        const markdown = markdownKey ? await source.open(markdownKey).catch(() => null) : null;
        if (markdown && markdown.size !== 0) return markdown;
        if (markdown) await discard(markdown.stream);
        const joined = pages.map((page) => page.text).filter((text) => text.trim()).join("\n\n");
        return joined || null;
      },
    };

    if (pages.length > 1 && !args.omitPageFiles) {
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
          const opened = await source.open(structuredKey);
          if (opened.size === null || opened.size > PRETTY_JSON_MAX_BYTES) return opened;
          const text = await readText(opened.stream);
          try {
            return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
          } catch {
            return text;
          }
        },
      };
    }

    if (args.content === "all") {
      const originalPath = `${folder}/original/${safeExportName(row.filename, "original", { keepExtension: true })}`;
      if (withheld.has(`s3://${source.bucket}/${row.source_key}`)) {
        skipped.push({ path: originalPath, reason: "withheld by the workspace's privacy (PII) policy" });
      } else {
        yield {
          path: originalPath,
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
  args: { root: string; content: DocumentExportContent; documents: ExportDocumentRow[]; truncated: boolean; omitPageFiles?: boolean },
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
    args.omitPageFiles
      ? "- page-by-page Markdown is left out: this export has more pages than one zip can hold as separate files. Export fewer documents to get it."
      : "- `pages/page-0001.md`: the same text page by page (documents with more than one page)",
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
  null::jsonb as artifacts
`;

/**
 * Attaches each document's own run artifacts. A run's artifact map holds every
 * document of the run, so it is read once per run and only these documents'
 * slots come back, instead of the whole map once per document.
 */
export async function loadExportArtifacts(sql: Sql, documents: ExportDocumentRow[]): Promise<void> {
  const runIds = [...new Set(documents.map((row) => row.run_id).filter((id): id is string => Boolean(id)))];
  if (runIds.length === 0) return;
  const slots = await sql<Array<{ document_id: string; slot: string; uri: string }>>`
    select split_part(artifact.key, ':', 1) as document_id, artifact.key as slot, artifact.value as uri
    from workspace_runs r
    cross join lateral jsonb_each_text(coalesce(r.artifacts, '{}'::jsonb)) as artifact
    where r.id = any(${sql.array(runIds)})
      and split_part(artifact.key, ':', 1) = any(${sql.array(documents.map((row) => row.id))})
  `;
  const byDocument = new Map<string, Record<string, string>>();
  for (const { document_id, slot, uri } of slots) {
    const map = byDocument.get(document_id) ?? {};
    map[slot] = uri;
    byDocument.set(document_id, map);
  }
  for (const row of documents) row.artifacts = byDocument.get(row.id) ?? null;
}

/**
 * The export's documents: the one document, or the workspace's live versions.
 * `superseded_at` is set only once a newer version completes, so a pending or
 * failed re-upload never hides the version that is still searchable.
 */
export async function loadExportDocuments(sql: Sql, row: Pick<ExportRow, "workspace_id" | "document_id" | "run_id">): Promise<{ documents: ExportDocumentRow[]; truncated: boolean }> {
  if (row.run_id) {
    // An extract's download: its run's completed documents, still in the export's workspace.
    const documents = await sql<ExportDocumentRow[]>`
      select ${documentColumns(sql)}
      from documents d
      where d.run_id = ${row.run_id} and d.workspace_id = ${row.workspace_id}
        and d.status = 'completed' and d.purged_at is null
      order by lower(d.filename), d.created_at, d.id
      limit ${DOCUMENT_EXPORT_MAX_DOCUMENTS + 1}
    `;
    return { documents: documents.slice(0, DOCUMENT_EXPORT_MAX_DOCUMENTS), truncated: documents.length > DOCUMENT_EXPORT_MAX_DOCUMENTS };
  }
  if (row.document_id) {
    const documents = await sql<ExportDocumentRow[]>`
      select ${documentColumns(sql)}
      from documents d
      where d.id = ${row.document_id} and d.workspace_id = ${row.workspace_id} and d.purged_at is null
    `;
    return { documents, truncated: false };
  }
  const documents = await sql<ExportDocumentRow[]>`
    select ${documentColumns(sql)}
    from documents d
    where d.workspace_id = ${row.workspace_id}
      and d.superseded_at is null and d.archived_at is null and d.purged_at is null
    order by lower(d.filename), d.created_at, d.id
    limit ${DOCUMENT_EXPORT_MAX_DOCUMENTS + 1}
  `;
  return { documents: documents.slice(0, DOCUMENT_EXPORT_MAX_DOCUMENTS), truncated: documents.length > DOCUMENT_EXPORT_MAX_DOCUMENTS };
}

/** Log progress at most once per this many bytes written. */
const PROGRESS_LOG_BYTES = 256 * 1024 * 1024;

/** Wakes the (auto-suspending) app so its sweep sends the export email promptly. */
async function wakeApp(): Promise<void> {
  const url = process.env.WORKER_APP_KEEPALIVE_URL?.trim();
  if (!url) return;
  await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "docslurp-worker-keepalive" } }).catch(() => undefined);
}

/**
 * Runs one export attempt to completion. Each attempt writes its own key
 * (`<prefix>a<attempt>.zip`), so a stale attempt can never overwrite or delete
 * the zip another attempt finished. Only a running export becomes ready or
 * failed, and `final` marks the last attempt: only then is a failure recorded,
 * so a retried storage hiccup does not show the user an error.
 */
export async function buildDocumentExport(
  deps: { sql: Sql; storage: ArtifactStore },
  exportId: string,
  options: { signal?: AbortSignal; heartbeat?: () => void; final?: boolean; attempt?: number; maxBytes?: number } = {},
): Promise<{ status: "ready" | "skipped"; sizeBytes?: number }> {
  const { sql, storage } = deps;
  const [row] = await sql<Array<ExportRow & { attempts: number; notify_email: boolean }>>`
    update document_exports set status = 'running', started_at = coalesce(started_at, now()), attempts = attempts + 1
    where id = ${exportId} and status in ('queued', 'running') and expires_at > now()
    returning id, org_id, workspace_id, document_id, run_id, content, filename, object_key, expires_at, attempts, notify_email
  `;
  if (!row) return { status: "skipped" };
  const prefix = row.object_key.endsWith("/") ? row.object_key : `${row.object_key.slice(0, row.object_key.lastIndexOf("/") + 1)}`;
  const key = `${prefix}a${options.attempt ?? row.attempts}.zip`;
  const started = Date.now();
  console.log(`[document-export] start export=${row.id} attempt=${options.attempt ?? row.attempts} content=${row.content} scope=${row.document_id ? "document" : "workspace"} workspace=${row.workspace_id}`);

  try {
    const { documents, truncated } = await loadExportDocuments(sql, row);
    if (documents.length === 0) throw new Error("Nothing to export: the document or workspace has no documents left.");
    await loadExportArtifacts(sql, documents);
    // Zip without ZIP64 holds 65,535 files: drop page-by-page files rather than the documents.
    const [pageCount] = await sql<Array<{ pages: number }>>`
      select count(*)::int as pages from document_pages where document_id = any(${sql.array(documents.map((document) => document.id))})
    `;
    // "all" also adds one images/ entry per rendered page.
    const imageEntries = row.content === "all"
      ? documents.reduce((sum, document) => sum + Object.keys(document.artifacts ?? {}).filter((slot) => /:page-\d+$/.test(slot)).length, 0)
      : 0;
    const omitPageFiles = documents.length * 12 + imageEntries + (pageCount?.pages ?? 0) > ZIP_MAX_ENTRIES;
    const root = row.filename.replace(/\.zip$/i, "");
    const skipped: Array<{ path: string; reason: string }> = [];
    let files = 0;
    let sizeBytes = 0;
    let nextProgressLog = PROGRESS_LOG_BYTES;
    const source: ExportSource = {
      bucket: storage.bucket,
      open: (objectKey) => storage.openStream(objectKey, options.signal),
      pages: async (documentId) => await sql<Array<{ page_number: number; text: string }>>`
        select page_number, text from document_pages where document_id = ${documentId} order by page_number
      `,
    };
    const entries = documentExportEntries({ root, scope: row.document_id ? "document" : "workspace", content: row.content, documents, truncated, omitPageFiles }, source, skipped);
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of zipStream(entries, {
        maxBytes: options.maxBytes ?? DOCUMENT_EXPORT_MAX_BYTES,
        onSkip: (path, reason) => skipped.push({ path, reason }),
        onAdd: () => { files += 1; },
        onProgress: options.heartbeat,
      })) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes >= nextProgressLog) {
          nextProgressLog += PROGRESS_LOG_BYTES;
          console.log(`[document-export] progress export=${row.id} files=${files} bytes=${sizeBytes} elapsed_ms=${Date.now() - started}`);
        }
        yield chunk;
      }
    };
    // No HTTP Expires header: storage would echo it on downloads and let caches keep the zip.
    const upload = storage.createMultipartUploadStream(key, "application/zip", {
      object: {
        metadata: {
          "docslurp-export-id": row.id,
          "docslurp-expires-at": new Date(Date.now() + DOCUMENT_EXPORT_TTL_DAYS * 86_400_000).toISOString(),
          "docslurp-ttl-days": String(DOCUMENT_EXPORT_TTL_DAYS),
        },
      },
    });
    await Promise.all([pipeline(Readable.from(chunks()), upload.writable, { signal: options.signal }), upload.done]);

    // Only a running export becomes ready: one the sweep already failed or
    // removed, or another attempt already finished, stays as it is.
    const finished = await sql`
      update document_exports
      set status = 'ready', completed_at = now(), object_key = ${key},
        -- An extract's download never outlives the extract (max_expires_at).
        expires_at = least(now() + make_interval(days => ${DOCUMENT_EXPORT_TTL_DAYS}), coalesce(max_expires_at, 'infinity'::timestamptz)),
        document_ids = ${sql.array(documents.map((document) => document.id))},
        size_bytes = ${sizeBytes}, file_count = ${files}, skipped_count = ${skipped.length},
        document_count = ${documents.length}, error = null
      where id = ${row.id} and status = 'running'
      returning id
    `;
    if (finished.length === 0) {
      console.warn(`[document-export] finished after it was failed, removed or completed by another attempt export=${row.id}; deleting this attempt's zip`);
      await storage.deleteKeys([key]).catch(() => undefined);
      return { status: "skipped" };
    }
    // Drop other attempts' leftovers: finished zips, and parts of uploads that were cut off.
    const leftovers = await storage.listKeys({ prefix }).catch(() => ({ keys: [] as string[] }));
    await storage.deleteKeys(leftovers.keys.filter((other) => other !== key)).catch(() => undefined);
    await storage.abortMultipartUploads(prefix).catch(() => undefined);

    console.log(`[document-export] ready export=${row.id} documents=${documents.length} files=${files} skipped=${skipped.length} bytes=${sizeBytes} elapsed_ms=${Date.now() - started}`);
    if (row.notify_email) await wakeApp();
    return { status: "ready", sizeBytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[document-export] failed export=${row.id} attempt=${options.attempt ?? row.attempts} final=${options.final ?? true} elapsed_ms=${Date.now() - started}: ${message}`);
    await storage.deleteKeys([key]).catch(() => undefined);
    if (options.final ?? true) {
      await sql`
        update document_exports set status = 'failed', completed_at = now(), error = ${publicExportError(message)}
        where id = ${row.id} and status = 'running'
      `;
      if (row.notify_email) await wakeApp();
    }
    throw error;
  }
}

function publicExportError(message: string): string {
  return message.startsWith("Nothing to export") ? message : "The export could not be built. Try again; if it keeps failing, contact support.";
}
