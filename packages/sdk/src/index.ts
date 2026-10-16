import { readSse } from "./sse.js";
import { assertBrowserSafeApiKey } from "./keys.js";
export { apiKeyKind, assertBrowserSafeApiKey, PRIVATE_API_KEY_PREFIX, PUBLIC_API_KEY_PREFIX, UnsafeApiKeyError, type ApiKeyKind } from "./keys.js";
import type { RunProgressSnapshot, WorkspaceState, OrganizationRecord, OrganizationDetails, OrganizationAccess, OrganizationMembership, OrganizationMember, OrganizationRole, OrganizationApiKey, CreateOrganizationInput, UpdateOrganizationInput, OrganizationInvite, CreateOrganizationInviteInput } from "./state.js";
export type * from "./state.js";
import type { IngestReport } from "./ingest-report.js";
export type * from "./ingest-report.js";
import type { DocumentViewerPayload } from "./document.js";
export type * from "./document.js";

export type DocSlurpFetch = typeof fetch;

/** Mirrors workspaceTemplateKeySchema on the server. */
export type WorkspaceTemplateKey =
  | "legal-contracts"
  | "medical-records"
  | "financial-reports"
  | "engineering-docs"
  | "meeting-notes";

export type JsonObject = Record<string, unknown>;

export type WorkspaceRecord = JsonObject & {
  id: string;
  name: string;
};

export type WorkspaceRun = JsonObject & {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  controlState?: string | null;
  error?: string | null;
};

export type DocumentRecord = JsonObject & {
  filename: string;
  id: string;
  status: string;
};

/** How much of the scope search covered; present on every search and chat response. */
export type SearchAvailabilityCoverage = {
  totalDocuments: number;
  /** Fully indexed: keyword and vector search. */
  indexedDocuments: number;
  pageIndexedDocuments: number;
  /** Fully indexed, keyword-only or page-only. */
  searchableDocuments: number;
  pageOnlyDocuments: number;
  /** Chunks served by keyword search while vector indexing is still running. */
  keywordOnlyDocuments?: number;
  inProgressDocuments: number;
  totalPages: number;
  searchablePages: number;
  indexedChunkCount: number;
  queuedRuns: number;
  processingRuns: number;
};

export type SearchAvailability = {
  status: "empty" | "pending" | "partial" | "complete";
  /** True while some documents in scope are still processing: results may be incomplete. */
  isPartial: boolean;
  /** Some searchable documents have keyword results only (vectors not indexed yet). */
  keywordOnly?: boolean;
  scope?: { workspaceId: string; runId: string | null };
  coverage?: SearchAvailabilityCoverage;
  resultBreakdown?: { indexedResultCount: number; pageResultCount: number };
  message: string | null;
};

/** A box on a page, slide, frame or image, as fractions (0 to 1) of its width and height from the top-left. */
export type NormalizedBox = { x: number; y: number; width: number; height: number };

/**
 * Where inside the source a citation points, keyed by `kind`. Recordings, decks and sheets have no meaningful page,
 * so branch on `kind` instead of reading `pageNumber`.
 */
export type CitationLocator =
  | { kind: "page"; pageNumber: number; charStart: number | null; charEnd: number | null; boxes: NormalizedBox[] }
  | { kind: "slide"; slideNumber: number; slideCount: number | null; notes: boolean; title: string | null; boxes: NormalizedBox[] }
  | { kind: "sheet"; sheetName: string | null; /** A1 range such as "B7:D8"; the whole table when exact rows are unknown. */ range: string; headerRow: number | null }
  | { kind: "media"; media: "audio" | "video"; startSeconds: number; endSeconds: number; durationSeconds: number | null;
      /** "said" = transcript speech; "shown" = on-screen evidence from sampled frames. */ mode: "said" | "shown";
      speaker: string | null; /** "word" and "segment" are provider timestamps; "chunk" only bounds the span. */ timing: "word" | "segment" | "chunk";
      frameSeconds: number[]; boxes: NormalizedBox[] }
  | { kind: "image"; boxes: NormalizedBox[] };

export type SearchCitation = {
  /** Precise position of the cited evidence. Absent or null for content indexed before locators existed. */
  locator?: CitationLocator | null;
  source: "document" | "community_summary" | "web";
  documentId: string;
  filename: string;
  pageNumber?: number | null;
  pageNumbers: number[];
  headingPath: string[];
  chunkIndex: number;
  blockIds: string[];
};

export type SearchResult = JsonObject & {
  score: number;
  /** Raw match strength, 0..1, independent of the other hits (unlike `score`, which is rank-based). */
  relevance?: number;
  text: string;
  citation: SearchCitation;
  parentText?: string;
};

/** Reserved workspace ID for the organization's default workspace. */
export const DEFAULT_WORKSPACE_ID = "default";

export type DocSlurpClientOptions = {
  /** Defaults to DOCSLURP_API_KEY in server environments. Use an empty string for cookie sessions. */
  apiKey?: string;
  /** Service origin. Defaults to DOCSLURP_URL, then https://docslurp.io. */
  apiUrl?: string;
  /**
   * Workspace for ingestion, search and chat. Defaults to DOCSLURP_WORKSPACE_ID
   * on the server, then "default": the organization's default workspace.
   */
  workspaceId?: string;
  fetch?: DocSlurpFetch;
  /** Total time allowed for one request, including retries. Default: 30 seconds. */
  timeoutMs?: number;
};

export type UploadFileInput = {
  data: Blob | ReadableStream<Uint8Array>;
  filename?: string;
  /**
   * Logical identity of this source, e.g. a URL or site path like "/products".
   * When a newer upload with the same canonicalId finishes processing in the
   * workspace, older versions drop out of search.
   */
  canonicalId?: string;
};

/** Structural Node ReadStream/async iterable support, without Node runtime imports. */
export type UploadByteStream = AsyncIterable<Uint8Array | string> & {
  path?: string | Uint8Array | URL;
  destroy?: (error?: Error) => unknown;
};

export type UploadOptions = RequestOptions & {
  /** Canonical ID for a single-file or streamed upload. Use UploadFileInput.canonicalId for several files. */
  canonicalId?: string;
  /**
   * How files reach storage. "auto" (default) sends uploads larger than
   * DIRECT_UPLOAD_THRESHOLD_BYTES through a direct upload session (presigned
   * PUTs straight to object storage); smaller ones use one multipart request
   * to /v1/ingest/bulk, which the server caps at MAX_MULTIPART_UPLOAD_BYTES
   * (25 MB by default). Streams always use multipart. Direct sessions ignore
   * idempotencyKey.
   */
  directUpload?: "auto" | boolean;
  filename?: string;
  idempotencyKey?: string;
  /** Create a fresh self-titled workspace instead of using the default one. */
  newWorkspace?: boolean;
  orgId?: string;
  /** Without workspaceId, creates a new workspace from this template (implies newWorkspace). */
  templateKey?: WorkspaceTemplateKey;
  workspaceId?: string;
  /** Without workspaceId, creates a new workspace with this name (implies newWorkspace). */
  workspaceName?: string;
};

export type UploadInput = {
  files: Array<Blob | File | UploadFileInput>;
  idempotencyKey?: string;
  newWorkspace?: boolean;
  orgId?: string;
  templateKey?: WorkspaceTemplateKey;
  workspaceId?: string;
  workspaceName?: string;
};

export type RejectedUpload = {
  filename: string;
  /** HTTP status the file would have produced on its own. */
  statusCode: 400 | 409 | 413 | 415 | 422;
  code: "unsupported_type" | "file_too_large" | "unreadable_source" | "rejected";
  message: string;
};

export type UploadResponse = {
  documents: DocumentRecord[];
  /** Files an upload left out while accepting the rest (one bad file never fails the request). Absent when every file was taken. */
  rejected?: RejectedUpload[];
  run: WorkspaceRun;
  warnings?: string[];
  workspace: WorkspaceRecord;
};

export type IngestUrlInput = {
  newWorkspace?: boolean;
  orgId?: string;
  templateKey?: WorkspaceTemplateKey;
  /** Each URL's canonical ID defaults to the URL; pass an object to map it elsewhere (e.g. "/products"). */
  urls: Array<string | { url: string; canonicalId?: string }>;
  workspaceId?: string;
  workspaceName?: string;
};

export type SearchInput = {
  documentId?: string;
  filenameContains?: string;
  limit?: number;
  /** Relevance floor, 0..1: drop results with a lower raw match strength. 0 disables it; omitted uses the workspace/server default. */
  minScore?: number;
  q: string;
  tags?: string;
  workspaceId?: string;
};

/** Await the response metadata or iterate its hits; both share one request. */
export type SearchRequest = Promise<SearchResponse> & AsyncIterable<SearchResult>;

export type SearchUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Recorded AI cost in US cents, not an invoice or total ingestion cost. */
  costCents: number;
  currency: "USD";
  costSource: "provider" | "estimate" | "mixed" | "unknown" | "none";
  scope: "retrieval";
};

export type SearchResponse = {
  usage: SearchUsage;
  availability: SearchAvailability | null;
  /** True when the workspace is searchable but search returned nothing: either nothing cleared the relevance floor or nothing was retrieved at all (e.g. a filter that matches nothing); `results` is then empty. */
  noMatch?: boolean;
  /** The floor applied and how many retrieved candidates it removed. */
  relevanceFloor?: { minScore: number; dropped: number };
  results: SearchResult[];
  sessionId: string;
};

export type SearchBatchOptions = {
  /** Maximum simultaneous searches. Defaults to 4; allowed range: 1–4. */
  concurrency?: number;
};

export type SearchBatchResponse = {
  /** One outcome per input query, in input order. */
  results: Array<
    | { ok: true; data: SearchResponse }
    | { ok: false; error: { code: string; message: string; status: number } }
  >;
};

/** Plain cited excerpts for retrieval-augmented prompts with any LLM. Treat excerpt text as untrusted source material. */
export function formatSearchContext(response: SearchResponse): string {
  return response.results.map((hit, index) => {
    const pages = hit.citation.pageNumbers?.length ? hit.citation.pageNumbers.join(", ") : hit.citation.pageNumber;
    const source = [hit.citation.filename, pages == null ? undefined : `pages ${pages}`, `document ${hit.citation.documentId}`].filter(Boolean).join(" · ");
    return `[${index + 1}] ${source}\n${hit.text}`;
  }).join("\n\n");
}

export type ChatInput = {
  q: string;
  sessionId?: string;
  workspaceId?: string;
};

export type ChatResponse = {
  id: string;
  sessionId: string;
  searchSessionId: string | null;
  answer: string;
  finishReason?: "stop" | "length" | "content-filter";
  citations: SearchResult[];
  availability: SearchAvailability | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; costCents?: number; costSource?: string };
  runtime: { startedAt: string; completedAt: string; totalMs: number };
};

export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type RunStreamEvent = {
  /** snapshot or a run/stage/document event type. */
  event: string;
  id?: string;
  data: JsonObject & { run?: WorkspaceRun };
};

/** Account-wide run events. `document.replaced` fires when a re-indexed source takes over search. */
export type ActivityEvent = {
  /** e.g. run.completed, document.completed, document.replaced, document.purged. */
  type: string;
  id?: string;
  runId: string;
  workspaceId: string | null;
  documentId: string | null;
  /** For document.replaced: { canonicalId, replacedDocumentIds }. */
  progress: JsonObject;
  createdAt?: string;
  event: JsonObject;
};

export type StreamActivityOptions = RequestOptions & {
  /** Only yield these event types. */
  types?: string[];
  /** Only yield events from this workspace. */
  workspaceId?: string;
};

export type StreamProgressOptions = RequestOptions & {
  /** Auto falls back to polling if SSE is unavailable or disconnects. Default: auto. */
  transport?: "auto" | "sse" | "poll";
  /** Stop when no snapshot has changed for this many ms (heartbeats don't count). Default: unlimited. */
  idleTimeoutMs?: number;
  /** How often to poll when polling. Default: 1_000. */
  pollIntervalMs?: number;
  /** Longest gap between yields: re-yield the latest snapshot when nothing changed for this long. Default: off. */
  heartbeatMs?: number;
};
export type WorkspaceStateOptions = RequestOptions & { recentWindowHours?: number };
/** Narrow the ingest report to one run or up to 100 documents. */
export type IngestReportOptions = RequestOptions & { runId?: string; documentIds?: string[] };

export type WaitForRunOptions = RequestOptions & {
  /** Polling interval. Default: one second. */
  pollIntervalMs?: number;
};

export class DocSlurpRunError extends Error {
  constructor(message: string, readonly run: WorkspaceRun) {
    super(message);
    this.name = "DocSlurpRunError";
  }
}

export class DocSlurpTimeoutError extends Error {
  constructor(message: string, readonly run?: WorkspaceRun) {
    super(message);
    this.name = "DocSlurpTimeoutError";
  }
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
  return value;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Aborts when any input aborts, with that input's reason. */
function linkedSignal(...signals: AbortSignal[]) {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", onAbort));
  }
  return { signal: controller.signal, dispose: () => cleanups.forEach(cleanup => cleanup()) };
}

function deadline(timeoutMs: number, external?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) onAbort();
  else external?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DocSlurpTimeoutError("DocSlurp request timed out")), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

export class DocSlurpApiError extends Error {
  readonly body: unknown;
  readonly status: number;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "DocSlurpApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Uploads above this total size go through a direct upload session instead of
 * multipart /v1/ingest/bulk (server cap: MAX_MULTIPART_UPLOAD_BYTES, 25 MB).
 */
export const DIRECT_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;

type DirectUploadDescriptor = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  mode: "single" | "multipart";
  putUrl?: string;
  partSize?: number;
  pendingParts?: Array<{ partNumber: number; sizeBytes: number; url: string }>;
};

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "");
}

function fileNameFor(input: Blob | File | UploadFileInput, index: number): string {
  if ("filename" in input && input.filename) {
    return input.filename;
  }
  if ("name" in input && typeof input.name === "string" && input.name) {
    return input.name;
  }
  return `document-${index + 1}`;
}

async function fileDataFor(input: Blob | File | UploadFileInput): Promise<Blob> {
  const data = "data" in input ? input.data : input;
  return typeof ReadableStream !== "undefined" && data instanceof ReadableStream
    ? new Response(data).blob() : data as Blob;
}

function streamFilename(source: UploadByteStream): string {
  const path = source.path instanceof URL ? decodeURIComponent(source.path.pathname)
    : source.path instanceof Uint8Array ? new TextDecoder().decode(source.path) : source.path;
  return path?.split(/[\\/]/).at(-1) || "document-1";
}

function multipartStream(source: UploadByteStream, filename: string, fields: Record<string, string>) {
  const boundary = `docslurp-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const quote = (value: string) => value.replace(/[\r\n"]/g, (character) => ({ "\r": "%0D", "\n": "%0A", '"': "%22" })[character]!);
  let sourceIterator: AsyncIterator<Uint8Array | string> | undefined;
  let stopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (const [name, value] of Object.entries(fields)) {
      yield encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    }
    yield encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${quote(filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    sourceIterator = source[Symbol.asyncIterator]();
    while (!stopped) {
      const next = await sourceIterator.next();
      if (next.done) break;
      if (typeof next.value !== "string" && !(next.value instanceof Uint8Array)) throw new TypeError("Upload stream must yield strings or Uint8Array chunks.");
      const bytes = typeof next.value === "string" ? encoder.encode(next.value) : next.value;
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        if (stopped) return;
        yield bytes.subarray(offset, offset + 64 * 1024);
      }
    }
    if (!stopped) yield encoder.encode(`\r\n--${boundary}--\r\n`);
  }
  const iterator = chunks();
  const dispose = (reason?: unknown) => {
    if (stopped) return;
    stopped = true;
    source.destroy?.();
    void sourceIterator?.return?.().catch(() => {});
    void iterator.return(undefined).catch(() => {});
    // End pending fetch reads even when a custom iterator cannot interrupt next().
    try { controller?.error(reason ?? new Error("Upload stream closed")); } catch {}
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    async pull(value) {
      try {
        const next = await iterator.next();
        if (stopped) return;
        if (next.done) value.close();
        else value.enqueue(next.value);
      } catch (error) { dispose(error); }
    },
    cancel() { dispose(); },
  }, { highWaterMark: 0 });
  // Node sources may fail while fetch is sending multipart headers, before iteration starts.
  const observable = source as UploadByteStream & {
    once?: (event: string, listener: (error?: Error) => void) => unknown;
    off?: (event: string, listener: (error?: Error) => void) => unknown;
  };
  const onSourceError = (error?: Error) => dispose(error ?? new Error("Upload source failed"));
  observable.once?.("error", onSourceError);
  observable.once?.("close", () => { observable.off?.("error", onSourceError); });
  return { body, boundary, dispose };
}

export function createDocSlurpClient(options: DocSlurpClientOptions = {}) {
  // Read server configuration at construction time; never import it into browser bundles.
  const env = typeof window === "undefined" && typeof process !== "undefined" ? process.env : undefined;
  const apiUrl = normalizeApiUrl(options.apiUrl ?? (env?.DOCSLURP_URL?.trim() || "https://docslurp.io"));
  const apiKey = options.apiKey ?? env?.DOCSLURP_API_KEY;
  assertBrowserSafeApiKey(apiKey);
  const workspaceId = options.workspaceId?.trim() || env?.DOCSLURP_WORKSPACE_ID?.trim() || DEFAULT_WORKSPACE_ID;
  const fetchImpl = options.fetch ?? fetch;

  const defaultTimeoutMs = positiveDuration(options.timeoutMs ?? 30_000, "timeoutMs");

  async function request<T>(
    path: string,
    init: RequestInit = {},
    requestOptions: RequestOptions = {},
    retryable = false,
    onAbort?: () => void,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
    const bound = deadline(positiveDuration(requestOptions.timeoutMs ?? defaultTimeoutMs, "timeoutMs"), requestOptions.signal);
    if (onAbort) {
      if (bound.signal.aborted) onAbort();
      else bound.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      // Mutating or AI-backed calls are never retried unless explicitly idempotent.
      for (let attempt = 0; ; attempt++) {
        bound.signal.throwIfAborted();
        const response = await fetchImpl(`${apiUrl}${path}`, {
          ...init,
          credentials: init.credentials ?? (apiKey ? "omit" : "include"),
          headers,
          signal: bound.signal,
        });
        if (retryable && attempt < 2 && [429, 502, 503, 504].includes(response.status)) {
          const retryAfter = response.headers.get("retry-after");
          const seconds = retryAfter === null ? NaN : Number(retryAfter);
          const delayMs = Number.isFinite(seconds) ? seconds * 1000
            : retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Date.parse(retryAfter) - Date.now()
            : 250 * 2 ** attempt;
          await response.body?.cancel();
          await sleep(Math.max(0, Math.min(delayMs, 5_000)), bound.signal);
          continue;
        }
        const contentType = response.headers.get("content-type") ?? "";
        const body: unknown = !response.ok ? await readErrorBody(response)
          : contentType.includes("application/json") ? await response.json() : await response.text();
        if (!response.ok) {
          const message = publicHttpError(response.status);
          throw new DocSlurpApiError(message, response.status, body);
        }
        return body as T;
      }
    } catch (error) {
      if (bound.signal.aborted) throw bound.signal.reason;
      throw error;
    } finally {
      if (onAbort) bound.signal.removeEventListener("abort", onAbort);
      bound.dispose();
    }
  }

  async function getRun(runId: string, requestOptions?: RequestOptions): Promise<WorkspaceRun> {
    const snapshot = await request<{ run: WorkspaceRun }>(
      `/v1/runs/${encodeURIComponent(runId)}/progress`, {}, requestOptions, true,
    );
    return snapshot.run;
  }

  function streamRunEvents(runId: string, streamOptions: RequestOptions = {}, endpoint = "events/stream"): AsyncGenerator<RunStreamEvent> {
    return streamEventsAt(`/v1/runs/${encodeURIComponent(runId)}/${endpoint}`, streamOptions);
  }

  /**
   * Live account activity over SSE. Runs until the signal aborts or timeoutMs
   * (default one hour) elapses; reconnect to keep listening. For clients that
   * cannot hold a stream open, poll getRunProgress or subscribe to webhooks.
   */
  async function* streamActivity(options: StreamActivityOptions = {}): AsyncGenerator<ActivityEvent> {
    const workspaceByRun = new Map<string, string | null>();
    const types = options.types ? new Set(options.types) : null;
    for await (const frame of streamEventsAt("/v1/runs/activity/stream", { ...options, timeoutMs: options.timeoutMs ?? 3_600_000 })) {
      if (frame.event === "activity-run") {
        const run = frame.data as JsonObject & { id?: string; workspaceId?: string };
        if (typeof run.id === "string") workspaceByRun.set(run.id, typeof run.workspaceId === "string" ? run.workspaceId : null);
        continue;
      }
      if (frame.event !== "activity-event") continue;
      const event = frame.data as JsonObject & { type?: string; runId?: string; documentId?: string | null; progress?: JsonObject; createdAt?: string };
      if (typeof event.type !== "string" || typeof event.runId !== "string") continue;
      if (types && !types.has(event.type)) continue;
      const workspaceId = workspaceByRun.get(event.runId) ?? null;
      if (options.workspaceId && workspaceId !== options.workspaceId) continue;
      yield {
        type: event.type,
        ...(frame.id === undefined ? {} : { id: frame.id }),
        runId: event.runId,
        workspaceId,
        documentId: typeof event.documentId === "string" ? event.documentId : null,
        progress: event.progress ?? {},
        ...(typeof event.createdAt === "string" ? { createdAt: event.createdAt } : {}),
        event,
      };
    }
  }

  async function* streamEventsAt(path: string, streamOptions: RequestOptions = {}): AsyncGenerator<RunStreamEvent> {
    const bound = deadline(positiveDuration(streamOptions.timeoutMs ?? 300_000, "timeoutMs"), streamOptions.signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const onAbort = () => { void reader?.cancel().catch(() => {}); };
    try {
      bound.signal.throwIfAborted();
      const headers = new Headers({ Accept: "text/event-stream" });
      if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
      const response = await fetchImpl(`${apiUrl}${path}`, {
        headers, credentials: apiKey ? "omit" : "include", signal: bound.signal,
      });
      if (!response.ok) {
        const body = await readErrorBody(response);
        const message = publicHttpError(response.status);
        throw new DocSlurpApiError(message, response.status, body);
      }
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
        await response.body?.cancel();
        throw new DocSlurpApiError("Expected a DocSlurp event stream", response.status, null);
      }
      reader = response.body.getReader();
      bound.signal.addEventListener("abort", onAbort, { once: true });
      bound.signal.throwIfAborted();
      for await (const frame of readSse(reader)) {
        bound.signal.throwIfAborted();
        const data: unknown = JSON.parse(frame.data);
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid DocSlurp event payload");
        yield { event: frame.event, ...(frame.id === undefined ? {} : { id: frame.id }), data: data as RunStreamEvent["data"] };
      }
      bound.signal.throwIfAborted();
    } catch (error) {
      if (bound.signal.aborted) throw bound.signal.reason;
      throw error;
    } finally {
      bound.signal.removeEventListener("abort", onAbort);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      bound.dispose();
    }
  }

  function streamRun(runId: string, options: RequestOptions = {}) {
    return streamRunEvents(runId, options);
  }

  async function getRunProgress(runId: string, options?: RequestOptions): Promise<RunProgressSnapshot> {
    return validateRunSnapshot(await request<unknown>(`/v1/runs/${encodeURIComponent(runId)}/progress`, {}, options, true), runId);
  }

  async function* streamProgress(runId: string, options: StreamProgressOptions = {}): AsyncGenerator<RunProgressSnapshot> {
    const transport = options.transport ?? "auto";
    if (!["auto", "sse", "poll"].includes(transport)) throw new RangeError("Invalid progress transport");
    const timeout = positiveDuration(options.timeoutMs ?? 300_000, "timeoutMs");
    const optional = (value: number | undefined, name: string) => value === undefined ? undefined : positiveDuration(value, name);
    const idleTimeout = optional(options.idleTimeoutMs, "idleTimeoutMs");
    const heartbeat = optional(options.heartbeatMs, "heartbeatMs");
    const interval = positiveDuration(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
    const bound = deadline(timeout, options.signal);
    const idle = new AbortController();
    const watch = linkedSignal(bound.signal, idle.signal);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const progressed = () => {
      if (idleTimeout === undefined) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(new DocSlurpTimeoutError(`Run ${runId} made no progress for ${idleTimeout}ms; it may still be queued or processing`, last?.run)), idleTimeout);
    };
    const expiresAt = Date.now() + timeout;
    const remaining = () => ({ signal: watch.signal, timeoutMs: Math.max(1, expiresAt - Date.now()) });
    let last: RunProgressSnapshot | undefined;
    let lastFingerprint: string | undefined;
    let lastYieldAt = Date.now();
    /** True when the snapshot differs from the previous one. */
    const changed = (snapshot: RunProgressSnapshot) => {
      const fingerprint = JSON.stringify(snapshot);
      if (fingerprint === lastFingerprint) return false;
      lastFingerprint = fingerprint; last = snapshot; progressed();
      return true;
    };
    /** Ms until the next heartbeat re-yield is due, or undefined when heartbeats are off or nothing was seen yet. */
    const heartbeatDue = () => heartbeat === undefined || !last ? undefined : Math.max(0, lastYieldAt + heartbeat - Date.now());
    progressed();
    try {
      if (transport !== "poll") {
        // A pending frames.next() can outlive an early return, so the stream gets its own abort.
        const stop = new AbortController();
        const streamSignal = linkedSignal(watch.signal, stop.signal);
        const frames = streamRunEvents(runId, { ...remaining(), signal: streamSignal.signal }, "progress/stream");
        const pull = () => { const pending = frames.next(); pending.catch(() => {}); return pending; };
        try {
          let next = pull();
          while (true) {
            const due = heartbeatDue();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const result = due === undefined ? await next : await Promise.race([
              next, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), due); }),
            ]).finally(() => clearTimeout(timer));
            if (result === null) { lastYieldAt = Date.now(); yield last!; continue; }
            if (result.done) break;
            next = pull();
            const frame = result.value;
            if (frame.event === "heartbeat") continue;
            if (frame.event === "activity-error" || frame.event === "error") throw new DocSlurpApiError("Run progress access ended", 403, frame.data);
            if (frame.event !== "snapshot") continue;
            const snapshot = validateRunSnapshot(frame.data, runId);
            if (changed(snapshot)) { lastYieldAt = Date.now(); yield snapshot; }
            if (runSnapshotTerminal(snapshot)) return;
          }
          if (transport === "sse") throw new Error("Run progress stream ended before a terminal snapshot");
        } catch (error) {
          watch.signal.throwIfAborted();
          const unsupported = error instanceof DocSlurpApiError && [200, 405, 406, 415, 429, 501, 502, 503, 504].includes(error.status);
          const network = error instanceof TypeError;
          if (transport !== "auto" || (!unsupported && !network)) throw error;
        } finally {
          stop.abort();
          await frames.return(undefined).catch(() => {});
          streamSignal.dispose();
        }
      }
      while (true) {
        watch.signal.throwIfAborted();
        const snapshot = await getRunProgress(runId, remaining());
        if (changed(snapshot) || heartbeatDue() === 0) { lastYieldAt = Date.now(); yield snapshot; }
        if (runSnapshotTerminal(snapshot)) return;
        await sleep(interval, watch.signal);
      }
    } catch (error) {
      if (bound.signal.aborted && bound.signal.reason instanceof DocSlurpTimeoutError) {
        throw new DocSlurpTimeoutError(`Stopped watching run ${runId} after ${timeout}ms; it may still be queued or processing`, last?.run);
      }
      throw error;
    } finally {
      clearTimeout(idleTimer);
      watch.dispose();
      bound.dispose();
    }
  }

  async function waitForRun(runId: string, waitOptions: WaitForRunOptions = {}): Promise<WorkspaceRun> {
    const timeoutMs = positiveDuration(waitOptions.timeoutMs ?? 300_000, "timeoutMs");
    const pollIntervalMs = positiveDuration(waitOptions.pollIntervalMs ?? 1_000, "pollIntervalMs");
    const bound = deadline(timeoutMs, waitOptions.signal);
    const expiresAt = Date.now() + timeoutMs;
    let run: WorkspaceRun | undefined;
    try {
      while (true) {
        run = await getRun(runId, { signal: bound.signal, timeoutMs: Math.max(1, expiresAt - Date.now()) });
        if (run.status === "failed" || ["paused", "cancelled", "dead-letter"].includes(run.controlState ?? "")) {
          throw new DocSlurpRunError("We couldn’t finish processing this run. Check its status and try again.", run);
        }
        if (run.status === "completed") return run;
        await sleep(pollIntervalMs, bound.signal);
      }
    } catch (error) {
      if (bound.signal.aborted && bound.signal.reason instanceof DocSlurpTimeoutError) {
        throw new DocSlurpTimeoutError(`Run ${runId} did not complete within ${timeoutMs}ms; it may still be queued or processing`, run);
      }
      throw error;
    } finally {
      bound.dispose();
    }
  }

  /**
   * Where an upload or URL ingest lands. An explicit per-call workspaceId wins.
   * Otherwise newWorkspace, a workspaceName or a templateKey asks the server to
   * create a workspace (the name and template would be ignored by an existing
   * one), and anything else goes to the client default.
   */
  function intakeTarget(input: { newWorkspace?: boolean; templateKey?: string; workspaceId?: string; workspaceName?: string }): { newWorkspace: boolean; workspaceId?: string } {
    const explicit = input.workspaceId?.trim();
    if (explicit) return { newWorkspace: Boolean(input.newWorkspace), workspaceId: explicit };
    if (input.newWorkspace || input.workspaceName?.trim() || input.templateKey) return { newWorkspace: true };
    return { newWorkspace: false, workspaceId };
  }

  /** Per-call workspaceId, else the client default ("default" unless configured). */
  function inWorkspace<T extends { workspaceId?: string }>(input: T): T {
    return { ...input, workspaceId: input.workspaceId?.trim() || workspaceId };
  }

  function upload(input: Array<Blob | File | UploadFileInput>, options?: UploadOptions): Promise<UploadResponse>;
  function upload(input: UploadInput, options?: UploadOptions): Promise<UploadResponse>;
  function upload(input: Blob | UploadFileInput | UploadByteStream, options?: UploadOptions): Promise<UploadResponse>;
  async function upload(input: UploadInput | Blob | UploadFileInput | UploadByteStream | Array<Blob | File | UploadFileInput>, options: UploadOptions = {}): Promise<UploadResponse> {
    if (Array.isArray(input)) input = { files: input };
    const metadata = "files" in input ? { ...input, ...options } : options;
    const fields: Record<string, string> = {};
    if (metadata.orgId) fields.orgId = metadata.orgId;
    const target = intakeTarget(metadata);
    if (target.workspaceId) fields.workspaceId = target.workspaceId;
    if (target.newWorkspace) fields.newWorkspace = "true";
    if (options.canonicalId) fields.canonicalId = options.canonicalId;
    if (metadata.workspaceName) fields.workspaceName = metadata.workspaceName;
    if (metadata.templateKey) fields.templateKey = metadata.templateKey;
    const headers = new Headers();
    if (metadata.idempotencyKey) headers.set("Idempotency-Key", metadata.idempotencyKey);
    if (Symbol.asyncIterator in input) {
      const stream = multipartStream(input, options.filename ?? streamFilename(input), fields);
      try {
        headers.set("Content-Type", `multipart/form-data; boundary=${stream.boundary}`);
        const init: RequestInit & { duplex: "half" } = { body: stream.body, headers, method: "POST", duplex: "half" };
        // A consumed source cannot be replayed, even with an idempotency key.
        return await request<UploadResponse>("/v1/ingest/bulk", init, options, false, stream.dispose);
      } finally { stream.dispose(); }
    }
    const files = "files" in input ? input.files : [input];
    const blobs = await Promise.all(files.map((file) => fileDataFor(file)));
    const names = files.map((file, index) => options.filename ?? fileNameFor(file, index));
    const canonicalIds = files.map((file) => ("data" in file && file.canonicalId) || null);
    const totalBytes = blobs.reduce((sum, blob) => sum + blob.size, 0);
    const mode = options.directUpload ?? "auto";
    if (mode === true || (mode === "auto" && totalBytes > DIRECT_UPLOAD_THRESHOLD_BYTES)) {
      return uploadDirect({ blobs, names, canonicalIds: canonicalIds.map((id, index) => id || (index === 0 && files.length === 1 ? options.canonicalId ?? null : null)), metadata, target }, options);
    }
    const form = new FormData();
    for (const [index, blob] of blobs.entries()) form.append("files", blob, names[index]);
    if (!fields.canonicalId && canonicalIds.some(Boolean)) fields.canonicalIds = JSON.stringify(canonicalIds);
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return request<UploadResponse>("/v1/ingest/bulk", { body: form, headers, method: "POST" }, options, Boolean(metadata.idempotencyKey));
  }

  /** PUT to a presigned storage URL: no API credentials, its own long deadline. */
  async function putToStorage(url: string, body: Blob, contentType: string | undefined, options: UploadOptions): Promise<string | null> {
    const bound = deadline(positiveDuration(options.timeoutMs ?? 30 * 60_000, "timeoutMs"), options.signal);
    try {
      const response = await fetchImpl(url, {
        method: "PUT",
        body,
        credentials: "omit",
        headers: contentType ? { "Content-Type": contentType } : undefined,
        signal: bound.signal,
      });
      if (!response.ok) throw new DocSlurpApiError(publicHttpError(response.status), response.status, await response.text().catch(() => ""));
      await response.body?.cancel().catch(() => {});
      return response.headers.get("etag");
    } catch (error) {
      if (bound.signal.aborted) throw bound.signal.reason;
      throw error;
    } finally {
      bound.dispose();
    }
  }

  /** Large uploads: create a session, PUT each file (or its parts) to storage, then confirm. */
  async function uploadDirect(args: {
    blobs: Blob[];
    names: string[];
    canonicalIds: Array<string | null>;
    metadata: UploadOptions | (UploadInput & UploadOptions);
    target: { newWorkspace: boolean; workspaceId?: string };
  }, options: UploadOptions): Promise<UploadResponse> {
    const { metadata } = args;
    const session = await request<{ sessionId: string; files: DirectUploadDescriptor[] }>("/v1/ingest/direct/sessions", jsonRequest("POST", {
      ...(metadata.orgId ? { orgId: metadata.orgId } : {}),
      ...(args.target.workspaceId ? { workspaceId: args.target.workspaceId } : {}),
      ...(args.target.newWorkspace ? { newWorkspace: true } : {}),
      ...(metadata.workspaceName ? { workspaceName: metadata.workspaceName } : {}),
      ...(metadata.templateKey ? { templateKey: metadata.templateKey } : {}),
      files: args.blobs.map((blob, index) => ({
        filename: args.names[index],
        mimeType: blob.type || "application/octet-stream",
        sizeBytes: blob.size,
        ...(args.canonicalIds[index] ? { canonicalId: args.canonicalIds[index] } : {}),
      })),
    }), options);
    const sessionPath = `/v1/ingest/direct/sessions/${encodeURIComponent(session.sessionId)}`;
    const remaining = args.blobs.map((blob, index) => ({ blob, name: args.names[index] }));
    try {
      for (const descriptor of session.files) {
        const at = remaining.findIndex((source) => source.name === descriptor.filename && source.blob.size === descriptor.sizeBytes);
        const source = at < 0 ? undefined : remaining.splice(at, 1)[0];
        if (!source) throw new Error(`Direct upload session returned an unknown file: ${descriptor.filename}`);
        if (descriptor.mode === "single") {
          const etag = await putToStorage(descriptor.putUrl ?? "", source.blob, descriptor.mimeType, options);
          await request(`${sessionPath}/files/complete`, jsonRequest("POST", { fileId: descriptor.id, ...(etag ? { etag } : {}) }), options);
          continue;
        }
        const parts: Array<{ partNumber: number; etag: string }> = [];
        for (const part of descriptor.pendingParts ?? []) {
          const start = (part.partNumber - 1) * (descriptor.partSize ?? part.sizeBytes);
          const etag = await putToStorage(part.url, source.blob.slice(start, start + part.sizeBytes), undefined, options);
          if (!etag) throw new Error(`Storage returned no ETag for ${descriptor.filename} part ${part.partNumber}`);
          parts.push({ partNumber: part.partNumber, etag });
        }
        await request(`${sessionPath}/files/complete`, jsonRequest("POST", { fileId: descriptor.id, parts }), options);
      }
      return await request<UploadResponse>(`${sessionPath}/confirm`, { method: "POST" }, options);
    } catch (error) {
      await request(`${sessionPath}/abort`, { method: "POST" }, { timeoutMs: 10_000 }).catch(() => {});
      throw error;
    }
  }

  return {
    getRun,
    getRunProgress,
    streamProgress,
    streamRun,
    streamActivity,
    waitForRun,

    getWorkspaceState(id: string | undefined = workspaceId, options: WorkspaceStateOptions = {}): Promise<WorkspaceState> {
      if (!id?.trim()) throw new Error("Set DOCSLURP_WORKSPACE_ID or pass workspaceId for workspace state.");
      const hours = options.recentWindowHours ?? 24;
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new RangeError("recentWindowHours must be an integer from 1 to 720");
      return request<WorkspaceState>(`/v1/workspaces/${encodeURIComponent(id)}/state?recentWindowHours=${hours}`, {}, options, true);
    },

    /**
     * Ingest report: pages, bytes, text layer, images, vision, searchability and
     * cost for the workspace (default workspace when none is configured), plus
     * the settings that shaped it and recommendations. No model call.
     */
    getIngestReport(id: string | undefined = workspaceId, options: IngestReportOptions = {}): Promise<IngestReport> {
      const params = new URLSearchParams();
      if (options.runId) params.set("runId", options.runId);
      if (options.documentIds?.length) {
        if (options.documentIds.length > 100) throw new RangeError("documentIds accepts at most 100 IDs");
        params.set("documentIds", options.documentIds.join(","));
      }
      const query = params.toString();
      return request<IngestReport>(`/v1/workspaces/${encodeURIComponent(id?.trim() || "default")}/ingest-report${query ? `?${query}` : ""}`, {}, options, true);
    },

    async listOrganizations(options?: RequestOptions): Promise<OrganizationRecord[]> {
      return (await request<{ organizations: OrganizationRecord[] }>("/v1/organizations", {}, options, true)).organizations;
    },
    getOrganization(orgId: string, options?: RequestOptions): Promise<OrganizationRecord> {
      return request<OrganizationRecord>(`/v1/organizations/${encodeURIComponent(orgId)}`, {}, options, true);
    },
    getOrganizationDetails(orgId: string, options?: RequestOptions): Promise<OrganizationDetails> {
      return request<OrganizationDetails>(`/v1/organizations/${encodeURIComponent(orgId)}/details`, {}, options, true);
    },
    getOrganizationAccess(orgId: string, options?: RequestOptions): Promise<OrganizationAccess> {
      return request<OrganizationAccess>(`/v1/organizations/${encodeURIComponent(orgId)}/access`, {}, options, true);
    },
    createOrganization(input: CreateOrganizationInput, options?: RequestOptions): Promise<OrganizationRecord> {
      return request<OrganizationRecord>("/v1/organizations", jsonRequest("POST", input), options);
    },
    updateOrganization(orgId: string, input: UpdateOrganizationInput, options?: RequestOptions): Promise<OrganizationDetails> {
      return request<OrganizationDetails>(`/v1/organizations/${encodeURIComponent(orgId)}`, jsonRequest("PATCH", input), options);
    },
    async listOrganizationMembers(orgId: string, options?: RequestOptions): Promise<OrganizationMember[]> {
      return (await request<{ memberships: OrganizationMember[] }>(`/v1/organizations/${encodeURIComponent(orgId)}/members`, {}, options, true)).memberships;
    },
    /** Emails an invite; the person joins by accepting it while signed in with that address. */
    inviteOrganizationMember(orgId: string, input: CreateOrganizationInviteInput, options?: RequestOptions): Promise<{ invite: OrganizationInvite; inviteUrl: string }> {
      return request<{ invite: OrganizationInvite; inviteUrl: string }>(`/v1/organizations/${encodeURIComponent(orgId)}/invites`, jsonRequest("POST", input), options);
    },
    async listOrganizationInvites(orgId: string, options?: RequestOptions): Promise<OrganizationInvite[]> {
      return (await request<{ invites: OrganizationInvite[] }>(`/v1/organizations/${encodeURIComponent(orgId)}/invites`, {}, options, true)).invites;
    },
    revokeOrganizationInvite(orgId: string, inviteId: string, options?: RequestOptions): Promise<OrganizationInvite> {
      return request<OrganizationInvite>(`/v1/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" }, options);
    },
    updateOrganizationMemberRole(orgId: string, memberUserId: string, role: OrganizationRole, options?: RequestOptions): Promise<OrganizationMembership> {
      return request<OrganizationMembership>(`/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberUserId)}`, jsonRequest("PATCH", { role }), options);
    },
    async removeOrganizationMember(orgId: string, memberUserId: string, options?: RequestOptions): Promise<void> {
      await request(`/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberUserId)}`, { method: "DELETE" }, options);
    },
    async leaveOrganization(orgId: string, options?: RequestOptions): Promise<void> {
      await request(`/v1/organizations/${encodeURIComponent(orgId)}/leave`, { method: "POST" }, options);
    },
    async listOrganizationApiKeys(orgId: string, options?: RequestOptions): Promise<OrganizationApiKey[]> {
      return (await request<{ keys: OrganizationApiKey[] }>(`/v1/organizations/${encodeURIComponent(orgId)}/api-keys`, {}, options, true)).keys;
    },
    revokeOrganizationApiKeys(orgId: string, options?: RequestOptions): Promise<{ keys: OrganizationApiKey[]; revokedCount: number }> {
      return request(`/v1/organizations/${encodeURIComponent(orgId)}/api-keys`, { method: "DELETE" }, options);
    },

    chat(input: ChatInput, requestOptions?: RequestOptions): Promise<ChatResponse> {
      return request<ChatResponse>("/v1/chat", {
        body: JSON.stringify(inWorkspace(input)),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, requestOptions);
    },

    getDocument(documentId: string, requestOptions?: RequestOptions): Promise<DocumentViewerPayload> {
      return request<DocumentViewerPayload>(`/v1/documents/${encodeURIComponent(documentId)}`, {}, requestOptions, true);
    },

    ingestUrls(input: IngestUrlInput, requestOptions?: RequestOptions): Promise<UploadResponse> {
      return request<UploadResponse>("/v1/ingest/url", {
        body: JSON.stringify({ ...input, ...intakeTarget(input) }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, requestOptions);
    },

    search(input: SearchInput, requestOptions?: RequestOptions): SearchRequest {
      const response = request<SearchResponse>("/v1/search", {
        body: JSON.stringify(inWorkspace(input)),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, requestOptions);
      return Object.assign(response, {
        async *[Symbol.asyncIterator]() {
          yield* (await response).results;
        },
      });
    },

    searchMany(inputs: SearchInput[], batchOptions: SearchBatchOptions = {}, requestOptions?: RequestOptions): Promise<SearchBatchResponse> {
      if (inputs.length < 1 || inputs.length > 20) throw new RangeError("searchMany accepts 1–20 queries.");
      const concurrency = batchOptions.concurrency ?? 4;
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new RangeError("Search concurrency must be an integer from 1 to 4.");
      return request<SearchBatchResponse>("/v1/search/batch", {
        body: JSON.stringify({ queries: inputs.map(inWorkspace), concurrency }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }, requestOptions);
    },

    upload,
  };
}

export type DocSlurpClient = ReturnType<typeof createDocSlurpClient>;

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function validateRunSnapshot(value: unknown, runId: string): RunProgressSnapshot {
  const object = (input: unknown): input is Record<string, unknown> => Boolean(input && typeof input === "object" && !Array.isArray(input));
  if (!object(value) || !object(value.run) || value.run.id !== runId || !["queued", "processing", "completed", "failed"].includes(String(value.run.status))
    || !Array.isArray(value.stages) || !Array.isArray(value.recentEvents) || !object(value.stats) || !object(value.artifacts)
    || !(value.temporal === null || object(value.temporal))) throw new Error("Invalid DocSlurp run progress snapshot");
  const numeric = (input: Record<string, unknown>, keys: string[]) => keys.every(key => typeof input[key] === "number" && Number.isFinite(input[key]));
  if (!numeric(value.run, ["pagesTotal", "pagesProcessed", "totalDocuments", "processedDocuments"])) throw new Error("Invalid DocSlurp run progress snapshot");
  if (value.progress !== undefined) {
    const progress = value.progress;
    if (!object(progress) || !["queued", "processing", "paused", "completed", "failed"].includes(String(progress.lifecycleStatus))
      || !object(progress.pageRollup) || !object(progress.usageTotals) || !object(progress.resourceTotals)
      || !Array.isArray(progress.stageRollups) || !Array.isArray(progress.phases)
      || !Number.isFinite(progress.pageRollup.completed) || !Number.isFinite(progress.pageRollup.total)
      || !Number.isFinite(progress.percentComplete)
      || !numeric(progress.usageTotals, ["inputTokens", "outputTokens", "costCents"])
      || !numeric(progress.resourceTotals, ["elapsedMs", "cpuUserMs", "cpuSystemMs", "cpuTotalMs", "rssDeltaBytes", "peakRssBytes"])) throw new Error("Invalid DocSlurp run progress snapshot");
  }
  return value as RunProgressSnapshot;
}

function runSnapshotTerminal(snapshot: RunProgressSnapshot): boolean {
  if (snapshot.run.controlState === "paused" || snapshot.progress?.lifecycleStatus === "paused") return false;
  return ["completed", "failed"].includes(snapshot.run.status) || ["cancelled", "dead-letter"].includes(snapshot.run.controlState ?? "");
}

export { buildDocumentPreviewPages } from "./document-pages.js";
export type { DocumentPreviewPage, ImageManifestRecord } from "./document-pages.js";

/** HTTP bodies may come from a proxy; never display their diagnostic text. */
function publicHttpError(status: number): string {
  if (status === 401) return "Please sign in again or check your API key.";
  if (status === 403) return "You don’t have access to this action. Ask your workspace administrator for help.";
  if (status === 402 || status === 503) return "This feature is temporarily unavailable. Please try again later.";
  if (status === 404) return "We couldn’t find what you’re looking for. It may have been moved or removed.";
  if (status === 413) return "This file is too large. Please choose a smaller file and try again.";
  if (status === 429) return "Please wait a moment before trying again.";
  if (status >= 400 && status < 500) return "Please check your request and try again.";
  return "We couldn’t complete that request. Please try again in a moment.";
}

async function readErrorBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}
