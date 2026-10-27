import { readSse } from "./sse.js";
import { assertBrowserSafeApiKey, assertSecureApiOrigin } from "./keys.js";
export { apiKeyKind, assertBrowserSafeApiKey, assertSecureApiOrigin, PRIVATE_API_KEY_PREFIX, PUBLIC_API_KEY_PREFIX, UnsafeApiKeyError, type ApiKeyKind } from "./keys.js";
import type { RunProgressSnapshot, WorkspaceState, OrganizationRecord, OrganizationDetails, OrganizationAccess, OrganizationMembership, OrganizationMember, OrganizationRole, OrganizationApiKey, CreateOrganizationInput, UpdateOrganizationInput, OrganizationInvite, CreateOrganizationInviteInput } from "./state.js";
export type * from "./state.js";
import type { IngestReport } from "./ingest-report.js";
export type * from "./ingest-report.js";
import type { DocumentVersionEntry, DocumentViewerPayload } from "./document.js";
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

export type IndexingMode = "full" | "map" | "visual";

export type WorkspaceRecord = JsonObject & {
  id: string;
  name: string;
  /** Mode new uploads use; always "full" while deferred indexing is unavailable. */
  indexingMode?: IndexingMode;
  /** Searchable pages (indexed pages of deferred documents plus all pages of full-mode documents). */
  indexedPageCount?: number;
  /** False when the service has deferred indexing profiles off; hide indexing controls. */
  deferredIndexingAvailable?: boolean;
};

export type RetrievalStage = "chunk" | "page-text" | "map-node" | "page-image";

/** Per-search stats for deferred workspaces: pages parsed on demand for this query. */
export type DeferredSearchStats = {
  temperature: "cold" | "warm" | "hot";
  candidatePages: number;
  indexedCandidatePages: number;
  materializedPages: number;
  pendingPages: number;
  materializeMs: number;
  creditsSpent: number;
  routerUsed: boolean;
  fallbackUsed: boolean;
  stoppedBy: "policy" | "credits" | "deadline" | null;
};

export type MaterializationPolicy = {
  maxPagesPerQuery: number;
  maxCreditsPerQuery: number;
  maxPagesPerDay?: number;
  deadlineMs: number;
  allowFullIndexRequest: boolean;
  allowAgentDiscovery: boolean;
  mapRouter: "off" | "auto" | "always";
};

export type CreateCapabilityInput = {
  workspaceIds?: string[];
  policy?: Partial<MaterializationPolicy>;
  ttlSeconds?: number;
  boundClientKeyId?: string;
  allowedOrigins?: string[];
};

export type FullIndexResponse = { runId: string; pages: number; estimatedCredits: number | null; billing?: "enforced" | "disabled"; job?: JobStatus };

export type JobKind = "reindex" | "full-index" | "backfill" | "graph-rebuild" | "reprocess";
export type JobState = "queued" | "blocked" | "processing" | "completed" | "failed" | "cancelled";

/** Work estimate. With billing disabled (self-hosted) `credits` is null; pages and time still apply. */
export type CostEstimate = {
  pages: number;
  documents: number;
  billing: "enforced" | "disabled";
  credits: { low: number; high: number } | null;
  seconds: { low: number; high: number } | null;
  basis: string;
};

/** A background job queued by a mutation. `estimate` is null when it took over 150 ms; fetch `estimateUrl`. */
export type JobStatus = {
  id: string;
  kind: JobKind;
  status: JobState;
  reason?: "credits" | "budget" | "policy";
  queue: { position: number | null; ahead: number | null };
  runIds: string[];
  estimate: CostEstimate | null;
  estimateUrl?: string;
  statusUrl: string;
};

export type ConfigChangeKind = "none" | "search-only" | "new-uploads" | "reindex-recommended" | "reindex-required";
export type ConfigChangeImpact = {
  kind: ConfigChangeKind;
  stages: string[];
  reasons: Array<{ field: string; effect: string }>;
  documents: number;
  pages: number;
};

/** Audio and video among the files of an upload estimate, priced by duration (`POST /v1/uploads/estimate`). */
export type UploadMediaEstimate = {
  audioFiles: number;
  videoFiles: number;
  audioMinutes: number;
  videoMinutes: number;
  /** True when a duration was not supplied and was guessed from the file size. */
  durationsAssumed: boolean;
  /** Whether the workspace reads sampled video frames, which triples a video minute's price. */
  videoFrames: boolean;
  /** `low` reads video from its audio track only; `high` also reads frames. */
  credits: { low: number; high: number };
  /** The cheaper processing option, or null when the price is already the lowest. `pipeline` is the upload's pipeline override. */
  lighter: { kind: "video-audio-track-only"; credits: number; savedCredits: number; pipeline: { mediaVideo: { enabled: false } } } | null;
};

/** Response of every `…/estimate` route. `impact` is present for configuration changes; `media` for upload estimates with audio or video. */
export type EstimateResponse = { estimate: CostEstimate; billing: "enforced" | "disabled"; impact?: ConfigChangeImpact; media?: UploadMediaEstimate | null; orgId?: string; billingExempt?: boolean };

/** Settings accepted by workspace PATCH; `apply` and `autoConfirmReindex` control re-index queuing. */
export type UpdateWorkspaceInput = JsonObject & {
  /** "reindex" queues a re-index of existing documents; "new-uploads" only changes future ingestion. */
  apply?: "new-uploads" | "reindex";
  autoConfirmReindex?: boolean;
  retainDocumentVersions?: number | null;
};
export type WorkspaceUpdateResponse = { workspace: WorkspaceRecord; impact?: ConfigChangeImpact; job?: JobStatus } & JsonObject;

/** `workspace`: ID, slug or name (see {@link DocSlurpClientOptions.workspace}); omitted: the client workspace. */
export type UploadEstimateInput = { files: Array<{ name: string; size: number; pages?: number; type?: string; durationSeconds?: number }>; workspace?: string };

/** Counts across a job's runs. */
export type JobProgress = { documents: number; documentsTotal: number; pages: number; pagesTotal: number };
/**
 * One streamed update. `job` is always a full {@link JobStatus}: a `progress` frame is merged into the last
 * known status as `job.progress`, and `data` is the raw frame payload.
 */
export type JobEvent = { event: "status" | "progress" | "done"; job: JobStatus & { progress?: JobProgress }; data: JsonObject };
export type StreamJobOptions = RequestOptions & { pollIntervalMs?: number };


export type WorkspaceRun = JsonObject & {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  controlState?: string | null;
  error?: string | null;
};

export type DocumentRecord = JsonObject & {
  filename: string;
  /**
   * Friendly title derived from the document's content; null when none was found
   * (fall back to the filename). Untrusted: derived from document content. Display
   * only; never place in prompts or treat as instructions.
   */
  title?: string | null;
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
  /** Documents that failed during processing; search still covers the rest. */
  failedDocuments?: number;
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
  /** How this result was retrieved (deferred workspaces). */
  retrieval?: { stage: RetrievalStage; pageNumbers?: number[]; materialized?: boolean };
};

/** Reserved workspace ID for the organization's default workspace. */
export const DEFAULT_WORKSPACE = "default";

/**
 * Supplies a bearer access token per request, for credentials that expire and
 * refresh (an OAuth access token from `docslurp login`). Called before every
 * request; `forceRefresh` is true once after a 401, so a provider can refresh
 * a token the server already refused. Return a cached token otherwise.
 */
export type DocSlurpTokenProvider = (context: { forceRefresh: boolean }) => string | Promise<string>;

export type DocSlurpClientOptions = {
  /**
   * Defaults to DOCSLURP_API_KEY in server environments. Use an empty string for cookie sessions.
   * Takes precedence over `accessToken` and DOCSLURP_TOKEN.
   */
  apiKey?: string;
  /**
   * A short-lived OAuth bearer token, or a provider that returns a fresh one.
   * Used when no API key is set; defaults to DOCSLURP_TOKEN in server
   * environments (for example `export DOCSLURP_TOKEN=$(docslurp auth token)`).
   */
  accessToken?: string | DocSlurpTokenProvider;
  /** Service origin. Defaults to DOCSLURP_URL, then https://docslurp.io. */
  apiUrl?: string;
  /**
   * Workspace for ingestion, search and chat: an ID, slug or name. Names match
   * by slug, so "Legal Contracts" and "legal-contracts" are the same workspace;
   * an upload into a name that matches nothing creates that workspace. Defaults
   * to DOCSLURP_WORKSPACE on the server, then "default": the organization's
   * default workspace.
   */
  workspace?: string;
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
  /**
   * Folder the file lives in, e.g. "contracts/2025" (no filename, "/"-separated, no ".." segments, max 1024).
   * With the filename it identifies the document across re-uploads: uploading the same path and name again
   * creates a new version that supersedes the old one, while the same name in another folder stays separate.
   */
  path?: string;
};

/** Structural Node ReadStream/async iterable support, without Node runtime imports. */
export type UploadByteStream = AsyncIterable<Uint8Array | string> & {
  path?: string | Uint8Array | URL;
  destroy?: (error?: Error) => unknown;
};

export type UploadOptions = RequestOptions & {
  /** Labels applied to every accepted document in this upload. */
  tags?: string[];
  /** Canonical ID for a single-file or streamed upload. Use UploadFileInput.canonicalId for several files. */
  canonicalId?: string;
  /** Folder path for a single-file or streamed upload. Use UploadFileInput.path for several files. */
  path?: string;
  indexingMode?: IndexingMode;
  /**
   * "auto" (default) uses presigned storage PUTs: single PUT for small files,
   * multipart for large files and unknown-size streams. The server starts
   * ingestion automatically. false uses the size-limited /v1/uploads/bulk
   * compatibility transport. Direct sessions ignore idempotencyKey.
   */
  directUpload?: "auto" | boolean;
  filename?: string;
  idempotencyKey?: string;
  /** Without `workspace`: create a fresh self-titled workspace instead of using the client workspace. */
  newWorkspace?: boolean;
  orgId?: string;
  /** Template for a workspace this upload creates; without `workspace`, creates a new self-titled one from it. */
  templateKey?: WorkspaceTemplateKey;
  /** Workspace ID, slug or name. A name that matches no workspace creates one with that name. */
  workspace?: string;
};

export type UploadInput = {
  /** Labels applied to every accepted document in this upload. */
  tags?: string[];
  files: Array<Blob | File | UploadFileInput>;
  idempotencyKey?: string;
  /** Stamp these documents with an indexing mode instead of the workspace's. */
  indexingMode?: IndexingMode;
  newWorkspace?: boolean;
  orgId?: string;
  templateKey?: WorkspaceTemplateKey;
  /** Workspace ID, slug or name. A name that matches no workspace creates one with that name. */
  workspace?: string;
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
  /** Set when the upload queued background work (for example a config-change re-index). */
  job?: JobStatus;
};

export type UploadUrlsInput = {
  /** Labels applied to every accepted document in this upload. */
  tags?: string[];
  idempotencyKey?: string;
  indexingMode?: IndexingMode;
  newWorkspace?: boolean;
  orgId?: string;
  templateKey?: WorkspaceTemplateKey;
  /** Each URL's canonical ID defaults to the URL; pass an object to map it elsewhere (e.g. "/products"). */
  urls: Array<string | { url: string; canonicalId?: string }>;
  /** Workspace ID, slug or name. A name that matches no workspace creates one with that name. */
  workspace?: string;
};

/** @deprecated Use UploadUrlsInput. */
export type IngestUrlInput = UploadUrlsInput;

export type SearchInput = {
  /** Independent per-adapter and fused candidate cap, 1..200. Omitted preserves server defaults. */
  candidateDepth?: number;
  /** Keep ranked search order, or pack the same selected passages for a prompt. */
  resultOrder?: "relevance" | "prompt";
  documentId?: string;
  filenameContains?: string;
  limit?: number;
  /** Relevance floor, 0..1: drop results with a lower raw match strength. 0 disables it; omitted uses the workspace/server default. */
  minScore?: number;
  q: string;
  tags?: string;
  /** Workspace ID, slug or name; omitted: the client workspace. */
  workspace?: string;
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
  /** Present for deferred (map/visual) workspaces. */
  deferred?: DeferredSearchStats;
};

export type SearchBatchOptions = {
  /** Maximum simultaneous searches. Defaults to 4; allowed range: 1–4. */
  concurrency?: number;
};

export type SearchBatchInput = SearchBatchOptions & { queries: SearchInput[] };

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
  /** Workspace ID, slug or name; omitted: the client workspace. */
  workspace?: string;
  /**
   * Chat model for this request. Omitted: the default. An unavailable model is
   * refused with HTTP 400 `model_not_allowed`, never replaced by the default.
   */
  model?: string;
  /** Search-agent budgets and modes for this turn (`chat()` only; `chatStream` ignores them); non-admin callers can only lower the budgets. */
  agent?: {
    /** Model steps, 1-12 (default 8). The last step always answers. */
    maxSteps?: number;
    /** Tool calls across the turn, 1-24 (default 16). */
    maxToolCalls?: number;
    /** Cap on parallel search queries, 1-8 (default 6). */
    searchConcurrency?: number;
    /** false: a direct answer from one retrieval and one model call, without the agent's tools. */
    tools?: boolean;
    /** false: no web tools this turn. Omitted or true: offered only when the deployment, workspace and key allow them. */
    web?: boolean;
    /** Suggestions mode (default false): flag ingest and search problems and propose settings changes for a person to apply. */
    suggestions?: boolean;
  };
  /** Retrieval overrides for this request only; workspace defaults stay as they are. */
  retrieval?: {
    /** Passages retrieved for the answer, 1-12. */
    resultCount?: number;
    useHyDE?: boolean;
    useRerank?: boolean;
    useMmr?: boolean;
    mmrLambda?: number;
    /** false: cite matched chunks without attaching whole parent page text (smaller, faster prompts). */
    parentRetrieval?: boolean;
  };
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
  /** Diagnostics. Search-agent turns report the modes they ran with; other fields may change between releases. */
  debug?: {
    modes?: { web: "on" | "off" | "unavailable"; suggestions: boolean };
    [key: string]: unknown;
  };
};

/** SSE events from {@link DocSlurpClient.chatStream}: retrieval status, the answer, then the done envelope. */
export type ChatStreamEvent =
  | { event: "status"; data: { stage: string; message: string } }
  | { event: "message"; data: ChatResponse }
  | { event: "done"; data: { id: string; sessionId: string; searchSessionId: string | null } };

export type ListDocumentsInput = {
  /** Workspace ID, slug or name; omitted: the client workspace. */
  workspace?: string;
  runId?: string;
  /** Comma-separated tags. */
  tags?: string;
};

/** Result of {@link DocSlurpClient.deleteDocument}: the identities of the removed document. */
export type DeletedDocument = JsonObject & {
  documentId: string;
  filename: string;
  workspaceId?: string | null;
  runId?: string | null;
  sourceKey?: string;
};

/** Input of {@link DocSlurpClient.reprocessRun}: all stages, from one stage on, or only the listed stages. */
export type ReprocessRunInput = { stageFrom?: string; stages?: string[] };
/** The run created by {@link DocSlurpClient.reprocessRun}, its job, and warnings when its start was deferred. */
export type ReprocessRunResult = { run: WorkspaceRun; job?: JobStatus; warnings: string[] };
export type BulkDocumentsInput = {
  action: "reprocess" | "apply-tags" | "remove-tags" | "delete" | "export-artifacts";
  documentIds: string[];
  tags?: string[];
};
/** Per action: `{ runs, failed, warnings, job? }` (reprocess), `{ updated, documentIds }` (tags), `{ deleted, documentIds }` or `{ artifacts }`. */
export type BulkDocumentsResult = JsonObject;
/** Names an ingest report recommendation, optionally scoped like the report it came from. */
export type IngestRecommendationInput = { recommendationId: string; runId?: string; documentIds?: string[] };
export type IngestRecommendationReprocessResult = JsonObject & { runs: Array<{ id: string }>; documentIds: string[]; skippedDocuments: number; estimatedCents: number | null };
export type IngestRecommendationApplyResult = JsonObject & { recommendationId: string; patch: JsonObject | null; pipeline: JsonObject };

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

/**
 * Where to lift a limit, from `error.details.links` on 402 and 429 responses of
 * hosted DocSlurp (self-hosted servers send none): `billing` (credits,
 * forecast, budgets), `buyCredits`, `autoTopUp` (only while the org's auto
 * top-up is off), `apiKeys` (a key's own limits) and `docs` for the limit.
 */
export type DocSlurpErrorLinks = Partial<Record<"billing" | "buyCredits" | "autoTopUp" | "apiKeys" | "docs", string>>;

export class DocSlurpApiError extends Error {
  readonly body: unknown;
  readonly status: number;
  /** Machine-readable `error.code` from the native error envelope; branch on this, never on `message`. */
  readonly code?: string;
  /** Server correlation id (`error.requestId`) to quote in support requests. */
  readonly requestId?: string;
  /** Buy-credits, auto top-up, billing and docs URLs for credit, budget and rate-limit errors. */
  readonly links?: DocSlurpErrorLinks;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "DocSlurpApiError";
    this.status = status;
    this.body = body;
    const envelope = apiErrorEnvelope(body);
    if (envelope?.code) this.code = envelope.code;
    if (envelope?.requestId) this.requestId = envelope.requestId;
    if (envelope?.links) this.links = envelope.links;
  }
}

const ERROR_LINK_NAMES = ["billing", "buyCredits", "autoTopUp", "apiKeys", "docs"] as const;

function errorLinks(value: unknown): DocSlurpErrorLinks | undefined {
  if (!value || typeof value !== "object") return undefined;
  const links: DocSlurpErrorLinks = {};
  for (const name of ERROR_LINK_NAMES) {
    const url = (value as Record<string, unknown>)[name];
    if (typeof url === "string" && /^https?:\/\//.test(url)) links[name] = url;
  }
  return Object.keys(links).length ? links : undefined;
}

/** Reads `{ error: { code, requestId, details: { links } } }`; legacy bodies, OpenAI errors without a string code and text yield nothing. */
function apiErrorEnvelope(body: unknown): { code?: string; requestId?: string; links?: DocSlurpErrorLinks } | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const { code, requestId, details } = error as { code?: unknown; requestId?: unknown; details?: { links?: unknown } };
  const links = errorLinks(details?.links);
  return {
    ...(typeof code === "string" && code ? { code } : {}),
    ...(typeof requestId === "string" && requestId ? { requestId } : {}),
    ...(links ? { links } : {}),
  };
}

/**
 * Legacy bulk-transport cutoff retained for callers that use this constant.
 * Automatic uploads now use direct sessions for every known-size file.
 */
export const DIRECT_UPLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;

export type DirectUploadDescriptor = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  mode: "single" | "multipart";
  putUrl?: string;
  method?: "PUT";
  headers?: Record<string, string>;
  expiresInSeconds?: number;
  partSize?: number;
  pendingParts?: Array<{ partNumber: number; sizeBytes: number; url: string }>;
};

export type UploadSessionInput = Omit<UploadInput, "files" | "idempotencyKey"> & {
  files: Array<{ filename: string; mimeType: string; sizeBytes?: number; canonicalId?: string; singlePart?: boolean }>;
};
export type UploadSession = { sessionId: string; status: string; files: DirectUploadDescriptor[]; result?: UploadResponse | null };
export type CompleteUploadFileInput = { fileId: string; sizeBytes?: number; etag?: string; parts?: Array<{ partNumber: number; etag: string }> };

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

function isStreamBody(body: unknown): boolean {
  return typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
}

export function createDocSlurpClient(options: DocSlurpClientOptions = {}) {
  // Read server configuration at construction time; never import it into browser bundles.
  const env = typeof window === "undefined" && typeof process !== "undefined" ? process.env : undefined;
  const apiUrl = normalizeApiUrl(options.apiUrl ?? (env?.DOCSLURP_URL?.trim() || "https://docslurp.io"));
  // Precedence: apiKey option > accessToken option > DOCSLURP_API_KEY > DOCSLURP_TOKEN.
  // An explicit empty apiKey means a cookie session and disables every bearer source.
  let apiKey: string | undefined;
  let tokenSource: string | DocSlurpTokenProvider | undefined;
  if (options.apiKey !== undefined) apiKey = options.apiKey;
  else if (options.accessToken !== undefined) tokenSource = options.accessToken;
  else if (env?.DOCSLURP_API_KEY) apiKey = env.DOCSLURP_API_KEY;
  else tokenSource = env?.DOCSLURP_TOKEN?.trim() || undefined;
  assertBrowserSafeApiKey(apiKey);
  if (typeof tokenSource === "string") assertBrowserSafeApiKey(tokenSource);
  const hasBearer = Boolean(apiKey || tokenSource);
  /** The Authorization value for one request; never logged or included in errors. */
  // Concurrent 401s share one forced refresh, so a provider never rotates twice at once.
  let forcedRefresh: Promise<string> | null = null;
  async function bearer(forceRefresh = false): Promise<string | null> {
    if (apiKey) return apiKey;
    if (!tokenSource) return null;
    if (typeof tokenSource === "string") return tokenSource;
    const provider = tokenSource;
    const fetchToken = async (force: boolean) => {
      const value = await provider({ forceRefresh: force });
      if (typeof value !== "string" || !value) throw new Error("DocSlurp access token provider returned no token");
      assertBrowserSafeApiKey(value);
      return value;
    };
    if (!forceRefresh) return await fetchToken(false);
    forcedRefresh ??= fetchToken(true).finally(() => { forcedRefresh = null; });
    return await forcedRefresh;
  }
  assertSecureApiOrigin(apiUrl);
  const clientWorkspace = options.workspace?.trim() || env?.DOCSLURP_WORKSPACE?.trim() || DEFAULT_WORKSPACE;
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
    const credential = await bearer();
    if (credential) headers.set("Authorization", `Bearer ${credential}`);
    // A provider gets one forced refresh after a 401, when the body can be sent again.
    let refreshedAfter401 = typeof tokenSource !== "function" || isStreamBody(init.body);
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
          credentials: init.credentials ?? (hasBearer ? "omit" : "include"),
          headers,
          signal: bound.signal,
        });
        if (response.status === 401 && !refreshedAfter401) {
          refreshedAfter401 = true;
          await response.body?.cancel();
          headers.set("Authorization", `Bearer ${await bearer(true)}`);
          continue;
        }
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
      const credential = await bearer();
      if (credential) headers.set("Authorization", `Bearer ${credential}`);
      let response = await fetchImpl(`${apiUrl}${path}`, {
        headers, credentials: hasBearer ? "omit" : "include", signal: bound.signal,
      });
      // A refused token before the stream opens: refresh once and reconnect (GET, nothing to replay).
      if (response.status === 401 && typeof tokenSource === "function") {
        await response.body?.cancel();
        headers.set("Authorization", `Bearer ${await bearer(true)}`);
        response = await fetchImpl(`${apiUrl}${path}`, { headers, credentials: "omit", signal: bound.signal });
      }
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


  const TERMINAL_JOB_STATES = new Set<JobState>(["completed", "failed", "cancelled"]);

  function getJob(jobId: string, requestOptions?: RequestOptions): Promise<JobStatus> {
    return request<JobStatus>(`/v1/jobs/${encodeURIComponent(jobId)}`, {}, requestOptions, true);
  }

  /**
   * Follows a job until it finishes: SSE from /v1/jobs/:id/events, falling back
   * to polling /v1/jobs/:id (every pollIntervalMs, default 2s) when the stream
   * is unavailable or drops. Yields a `status`, `progress` or `done` event.
   * `timeoutMs` (default five minutes) bounds the wait but never applies while the
   * job is `blocked` (waiting for credits or budget): the clock restarts on every
   * poll that sees `blocked`, so cancel with `signal` instead.
   */
  async function* streamJob(jobId: string, streamOptions: StreamJobOptions = {}): AsyncGenerator<JobEvent> {
    const timeoutMs = positiveDuration(streamOptions.timeoutMs ?? 300_000, "timeoutMs");
    const interval = positiveDuration(streamOptions.pollIntervalMs ?? 2_000, "pollIntervalMs");
    const signal = streamOptions.signal ?? new AbortController().signal;
    const deadlineAt = Date.now() + timeoutMs;
    let last: JobStatus | undefined;
    try {
      for await (const frame of streamEventsAt(`/v1/jobs/${encodeURIComponent(jobId)}/events`, { ...streamOptions, timeoutMs })) {
        const data = frame.data as JsonObject;
        if (frame.event !== "status" && frame.event !== "progress" && frame.event !== "done") continue;
        if (frame.event === "progress") {
          // Progress frames carry counts only; attach them to the last status (the server sends status first).
          if (!last) continue;
          const { id: _id, job: _job, ...counts } = data;
          last = { ...last, progress: counts as unknown as JobProgress } as JobStatus;
          yield { event: "progress", job: last, data };
          continue;
        }
        const reported = (data.job && typeof data.job === "object" ? data.job : data) as JobStatus & { progress?: JobProgress };
        // Status frames carry no counts: keep the last known progress.
        const kept = (last as (JobStatus & { progress?: JobProgress }) | undefined)?.progress;
        const job = reported.progress || !kept ? reported : { ...reported, progress: kept };
        last = job;
        yield { event: frame.event, job, data };
        if (frame.event === "done" || TERMINAL_JOB_STATES.has(job.status)) return;
      }
    } catch (error) {
      signal.throwIfAborted();
      // Unavailable, dropped or timed-out stream: fall through to polling.
    }
    let limit = deadlineAt;
    for (;;) {
      const job = await getJob(jobId, { signal });
      const changed = !last || last.status !== job.status || JSON.stringify(last.queue) !== JSON.stringify(job.queue)
        || last.runIds.join() !== job.runIds.join();
      last = job;
      const done = TERMINAL_JOB_STATES.has(job.status);
      if (changed || done) yield { event: done ? "done" : "status", job, data: { job } };
      if (done) return;
      if (job.status === "blocked") limit = Date.now() + timeoutMs;
      if (Date.now() >= limit) throw new DocSlurpTimeoutError(`Job ${jobId} did not finish within ${timeoutMs} ms; it keeps running.`);
      await sleep(interval, signal);
    }
  }

  function estimateAt(path: string, body: unknown, requestOptions?: RequestOptions): Promise<EstimateResponse> {
    return request<EstimateResponse>(path, jsonRequest("POST", body ?? {}), requestOptions);
  }
  const wsPath = (ref: string | undefined) => `/v1/workspaces/${encodeURIComponent(ref?.trim() || clientWorkspace)}`;

  /** What switching a workspace to `mode` would cost. */
  function estimateIndexingMode(mode: IndexingMode, input: { workspace?: string } = {}, requestOptions?: RequestOptions): Promise<{ pages: number; estimatedCredits: number | null; billing?: "enforced" | "disabled"; job: "none" | "full-index" | "build-maps" | "embed-pages" }> {
    return request(`${wsPath(input.workspace)}/indexing-mode/estimate`, jsonRequest("POST", { mode }), requestOptions);
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
      // The request's remaining-budget timer can fire before the outer deadline.
      if (error instanceof DocSlurpTimeoutError && !error.run) {
        throw new DocSlurpTimeoutError(error.message, last?.run);
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
      // The request's remaining-budget timer can fire before the outer deadline.
      if (error instanceof DocSlurpTimeoutError && !error.run) {
        throw new DocSlurpTimeoutError(error.message, run);
      }
      throw error;
    } finally {
      bound.dispose();
    }
  }

  /**
   * Where an upload or URL ingest lands. An explicit per-call workspace wins
   * (the server finds it by ID, slug or name, or creates it from the name).
   * Otherwise newWorkspace or a templateKey asks the server for a new
   * self-titled workspace, and anything else goes to the client workspace.
   */
  function intakeTarget(input: { newWorkspace?: boolean; templateKey?: string; workspace?: string }): { newWorkspace: boolean; workspace?: string } {
    const explicit = input.workspace?.trim();
    if (explicit) return { newWorkspace: false, workspace: explicit };
    if (input.newWorkspace || input.templateKey) return { newWorkspace: true };
    return { newWorkspace: false, workspace: clientWorkspace };
  }

  /** Per-call workspace, else the client workspace ("default" unless configured). */
  function inWorkspace<T extends { workspace?: string }>(input: T): T {
    return { ...input, workspace: input.workspace?.trim() || clientWorkspace };
  }

  function uploadUrls(input: UploadUrlsInput, options?: RequestOptions): Promise<UploadResponse> {
    const { idempotencyKey, urls, orgId, templateKey } = input;
    const body = { urls, orgId, templateKey, tags: input.tags, ...intakeTarget(input) };
    return request("/v1/uploads/url", {
      ...jsonRequest("POST", body),
      headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    }, options, Boolean(idempotencyKey));
  }

  function search(input: SearchInput, options?: RequestOptions): SearchRequest;
  function search(input: SearchBatchInput, options?: RequestOptions): Promise<SearchBatchResponse>;
  function search(input: SearchInput | SearchBatchInput, options?: RequestOptions): SearchRequest | Promise<SearchBatchResponse> {
    if ("queries" in input) {
      if (input.queries.length < 1 || input.queries.length > 20) throw new RangeError("search accepts 1–20 queries.");
      const concurrency = input.concurrency ?? 4;
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new RangeError("Search concurrency must be an integer from 1 to 4.");
      return request<SearchBatchResponse>("/v1/search", jsonRequest("POST", { queries: input.queries.map(inWorkspace), concurrency }), options);
    }
    const response = request<SearchResponse>("/v1/search", jsonRequest("POST", inWorkspace(input)), options);
    return Object.assign(response, { async *[Symbol.asyncIterator]() { yield* (await response).results; } });
  }

  function upload(input: Array<Blob | File | UploadFileInput>, options?: UploadOptions): Promise<UploadResponse>;
  function upload(input: UploadUrlsInput, options?: UploadOptions): Promise<UploadResponse>;
  function upload(input: UploadInput, options?: UploadOptions): Promise<UploadResponse>;
  function upload(input: Blob | UploadFileInput | UploadByteStream, options?: UploadOptions): Promise<UploadResponse>;
  async function upload(input: UploadUrlsInput | UploadInput | Blob | UploadFileInput | UploadByteStream | Array<Blob | File | UploadFileInput>, options: UploadOptions = {}): Promise<UploadResponse> {
    if ("urls" in input) return uploadUrls({ ...input, ...options }, options);
    if (Array.isArray(input)) input = { files: input };
    const metadata = "files" in input ? { ...input, ...options } : options;
    if ("data" in input && input.data instanceof ReadableStream && options.directUpload !== false) {
      const reader = input.data.getReader();
      const source: UploadByteStream = {
        async *[Symbol.asyncIterator]() {
          try { while (true) { const next = await reader.read(); if (next.done) break; yield next.value; } }
          finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        },
        destroy() { void reader.cancel().catch(() => {}); },
      };
      return uploadStreamDirect(source, metadata, { ...options, filename: options.filename ?? input.filename, canonicalId: options.canonicalId ?? input.canonicalId, path: options.path ?? input.path });
    }
    const fields: Record<string, string> = {};
    if (metadata.orgId) fields.orgId = metadata.orgId;
    if (metadata.tags) fields.tags = JSON.stringify(metadata.tags);
    const target = intakeTarget(metadata);
    if (target.workspace) fields.workspace = target.workspace;
    if (target.newWorkspace) fields.newWorkspace = "true";
    if (options.canonicalId) fields.canonicalId = options.canonicalId;
    if (options.path) fields.path = options.path;
    if (metadata.templateKey) fields.templateKey = metadata.templateKey;
    if (metadata.indexingMode) fields.indexingMode = metadata.indexingMode;
    const headers = new Headers();
    if (metadata.idempotencyKey) headers.set("Idempotency-Key", metadata.idempotencyKey);
    if (Symbol.asyncIterator in input && options.directUpload !== false) {
      return uploadStreamDirect(input, metadata, options);
    }
    if (Symbol.asyncIterator in input) {
      const stream = multipartStream(input, options.filename ?? streamFilename(input), fields);
      try {
        headers.set("Content-Type", `multipart/form-data; boundary=${stream.boundary}`);
        const init: RequestInit & { duplex: "half" } = { body: stream.body, headers, method: "POST", duplex: "half" };
        // A consumed source cannot be replayed, even with an idempotency key.
        return await request<UploadResponse>("/v1/uploads/bulk", init, options, false, stream.dispose);
      } finally { stream.dispose(); }
    }
    const files = "files" in input ? input.files : [input];
    if (files.length === 1 && "data" in files[0] && files[0].data instanceof ReadableStream && options.directUpload !== false) {
      return upload(files[0], { ...metadata, ...options });
    }
    if (options.directUpload !== false && files.some((file) => "data" in file && file.data instanceof ReadableStream)) {
      throw new TypeError("Upload ReadableStream files individually to keep transfers bounded in memory.");
    }
    const blobs = await Promise.all(files.map((file) => fileDataFor(file)));
    const names = files.map((file, index) => options.filename ?? fileNameFor(file, index));
    const canonicalIds = files.map((file) => ("data" in file && file.canonicalId) || null);
    const paths = files.map((file, index) => ("data" in file && file.path) || (index === 0 && files.length === 1 ? options.path ?? "" : ""));
    const mode = options.directUpload ?? "auto";
    if (mode !== false) {
      return uploadDirect({ blobs, names, canonicalIds: canonicalIds.map((id, index) => id || (index === 0 && files.length === 1 ? options.canonicalId ?? null : null)), paths, metadata, target }, options);
    }
    const form = new FormData();
    for (const [index, blob] of blobs.entries()) form.append("files", blob, names[index]);
    delete fields.path;
    if (paths.some(Boolean)) fields.paths = JSON.stringify(paths);
    if (!fields.canonicalId && canonicalIds.some(Boolean)) fields.canonicalIds = JSON.stringify(canonicalIds);
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return request<UploadResponse>("/v1/uploads/bulk", { body: form, headers, method: "POST" }, options, Boolean(metadata.idempotencyKey));
  }

  async function waitUploadSession(path: string, options: UploadOptions): Promise<UploadResponse> {
    const bound = deadline(options.timeoutMs ?? 30 * 60_000, options.signal);
    try {
      while (true) {
        const session = await request<UploadSession>(`${path}?statusOnly=true`, {}, { ...options, signal: bound.signal }, true);
        if (session.result) return session.result;
        if (["failed", "aborted", "expired"].includes(session.status)) throw new Error(`Upload session ${session.status}`);
        await sleep(250, bound.signal);
      }
    } finally { bound.dispose(); }
  }

  async function uploadStreamDirect(source: UploadByteStream, metadata: UploadOptions, options: UploadOptions): Promise<UploadResponse> {
    const bound = deadline(options.timeoutMs ?? 30 * 60_000, options.signal);
    const stopped = new AbortController();
    const signal = AbortSignal.any([bound.signal, stopped.signal]);
    const transferOptions = { ...options, signal };
    const iterator = source[Symbol.asyncIterator]();
    const close = () => { source.destroy?.(); void iterator.return?.().catch(() => {}); };
    signal.addEventListener("abort", close, { once: true });
    const observable = source as UploadByteStream & { on?: (event: string, listener: (error: Error) => void) => unknown; off?: (event: string, listener: (error: Error) => void) => unknown };
    const onSourceError = (error: Error) => stopped.abort(error);
    observable.on?.("error", onSourceError);
    let sessionPath: string | undefined;
    const active = new Set<Promise<void>>();
    let failure: unknown;
    try {
      signal.throwIfAborted();
      const session = await request<UploadSession>("/v1/uploads/direct/sessions", jsonRequest("POST", {
        ...intakeTarget(metadata), orgId: metadata.orgId, tags: metadata.tags,
        templateKey: metadata.templateKey, indexingMode: metadata.indexingMode,
        files: [{ filename: options.filename ?? streamFilename(source), mimeType: "application/octet-stream",
          canonicalId: options.canonicalId, path: options.path }],
      }), transferOptions);
      sessionPath = `/v1/uploads/direct/sessions/${encodeURIComponent(session.sessionId)}`;
      const descriptor = session.files[0];
      if (!descriptor || descriptor.mode !== "multipart") throw new Error("Stream upload requires a multipart session");
      const partSize = descriptor.partSize ?? 8 * 1024 * 1024;
      if (!Number.isSafeInteger(partSize) || partSize < 1) throw new Error("Invalid upload part size");
      const parts: Array<{ partNumber: number; etag: string }> = [];
      let buffer = new Uint8Array(partSize);
      let used = 0;
      let sizeBytes = 0;
      let partNumber = 0;
      const send = async (bytes: Uint8Array) => {
        if (failure) throw failure;
        signal.throwIfAborted();
        const number = ++partNumber;
        if (number > 10_000) throw new RangeError("Stream exceeds the multipart upload part limit");
        const signed = await request<{ parts: Array<{ partNumber: number; url: string }> }>(`${sessionPath}/files/${encodeURIComponent(descriptor.id)}/parts/sign`, jsonRequest("POST", { partNumbers: [number] }), transferOptions);
        const url = signed.parts.find((part) => part.partNumber === number)?.url;
        if (!url) throw new Error(`No upload URL for part ${number}`);
        const task = putToStorage(url, new Blob([bytes as Uint8Array<ArrayBuffer>]), undefined, transferOptions).then((etag) => {
          if (!etag) throw new Error(`Storage returned no ETag for part ${number}`);
          parts.push({ partNumber: number, etag });
        }).catch((error) => { failure ??= error; }).finally(() => { active.delete(task); });
        active.add(task);
        if (active.size >= 3) await Promise.race(active);
        if (failure) throw failure;
      };
      while (true) {
        // Abort even when a custom source's next() never resolves.
        const next = await new Promise<IteratorResult<Uint8Array | string>>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          else Promise.resolve(iterator.next()).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        });
        if (next.done) break;
        if (typeof next.value !== "string" && !(next.value instanceof Uint8Array)) throw new TypeError("Upload stream must yield strings or Uint8Array chunks.");
        const bytes = typeof next.value === "string" ? new TextEncoder().encode(next.value) : next.value;
        for (let offset = 0; offset < bytes.length;) {
          const count = Math.min(partSize - used, bytes.length - offset);
          buffer.set(bytes.subarray(offset, offset + count), used);
          used += count; offset += count; sizeBytes += count;
          if (used === partSize) { await send(buffer); buffer = new Uint8Array(partSize); used = 0; }
        }
      }
      if (used || !partNumber) await send(buffer.subarray(0, used));
      await Promise.all(active);
      if (failure) throw failure;
      parts.sort((a, b) => a.partNumber - b.partNumber);
      await request(`${sessionPath}/files/complete`, jsonRequest("POST", { fileId: descriptor.id, sizeBytes, parts }), transferOptions);
      return await waitUploadSession(sessionPath, transferOptions);
    } catch (error) {
      stopped.abort(error);
      close();
      await Promise.all(active);
      if (sessionPath) await request(`${sessionPath}/abort`, { method: "POST" }, { timeoutMs: 10_000 }).catch(() => {});
      throw error;
    } finally { close(); observable.off?.("error", onSourceError); signal.removeEventListener("abort", close); bound.dispose(); }
  }

  /** PUT to a presigned storage URL: no API credentials, its own long deadline. */
  async function putToStorage(url: string, body: Blob, contentType: string | undefined, options: UploadOptions): Promise<string | null> {
    const bound = deadline(positiveDuration(options.timeoutMs ?? 30 * 60_000, "timeoutMs"), options.signal);
    try {
      for (let attempt = 0; ; attempt++) {
        let response: Response;
        try { response = await fetchImpl(url, {
          method: "PUT",
          body,
          credentials: "omit",
          headers: contentType ? { "Content-Type": contentType } : undefined,
          signal: bound.signal,
        }); } catch (error) {
          if (attempt >= 2 || bound.signal.aborted) throw error;
          await sleep(250 * 2 ** attempt, bound.signal);
          continue;
        }
        if (attempt < 2 && [408, 429, 500, 502, 503, 504].includes(response.status)) {
          await response.body?.cancel().catch(() => {});
          await sleep(250 * 2 ** attempt, bound.signal);
          continue;
        }
        if (!response.ok) throw new DocSlurpApiError(publicHttpError(response.status), response.status, await response.text().catch(() => ""));
        await response.body?.cancel().catch(() => {});
        return response.headers.get("etag");
      }
    } catch (error) {
      if (bound.signal.aborted) throw bound.signal.reason;
      throw error;
    } finally {
      bound.dispose();
    }
  }

  /** Transfer known-size files; the server reconciles storage and starts ingestion. */
  async function uploadDirect(args: {
    blobs: Blob[];
    names: string[];
    canonicalIds: Array<string | null>;
    paths: string[];
    metadata: UploadOptions | (UploadInput & UploadOptions);
    target: { newWorkspace: boolean; workspace?: string };
  }, options: UploadOptions): Promise<UploadResponse> {
    const { metadata } = args;
    const session = await request<{ sessionId: string; files: DirectUploadDescriptor[] }>("/v1/uploads/direct/sessions", jsonRequest("POST", {
      ...(metadata.orgId ? { orgId: metadata.orgId } : {}),
      ...(metadata.tags ? { tags: metadata.tags } : {}),
      ...(metadata.indexingMode ? { indexingMode: metadata.indexingMode } : {}),
      ...(args.target.workspace ? { workspace: args.target.workspace } : {}),
      ...(args.target.newWorkspace ? { newWorkspace: true } : {}),
      ...(metadata.templateKey ? { templateKey: metadata.templateKey } : {}),
      files: args.blobs.map((blob, index) => ({
        filename: args.names[index],
        mimeType: blob.type || "application/octet-stream",
        sizeBytes: blob.size,
        ...(args.canonicalIds[index] ? { canonicalId: args.canonicalIds[index] } : {}),
        ...(args.paths[index] ? { path: args.paths[index] } : {}),
      })),
    }), options);
    const sessionPath = `/v1/uploads/direct/sessions/${encodeURIComponent(session.sessionId)}`;
    const remaining = args.blobs.map((blob, index) => ({ blob, name: args.names[index] }));
    try {
      for (const descriptor of session.files) {
        const at = remaining.findIndex((source) => source.name === descriptor.filename && source.blob.size === descriptor.sizeBytes);
        const source = at < 0 ? undefined : remaining.splice(at, 1)[0];
        if (!source) throw new Error(`Direct upload session returned an unknown file: ${descriptor.filename}`);
        if (descriptor.mode === "single") {
          await putToStorage(descriptor.putUrl ?? "", source.blob, descriptor.mimeType, options);
          continue;
        }
        for (const part of descriptor.pendingParts ?? []) {
          const start = (part.partNumber - 1) * (descriptor.partSize ?? part.sizeBytes);
          await putToStorage(part.url, source.blob.slice(start, start + part.sizeBytes), undefined, options);
        }

      }
      return await waitUploadSession(sessionPath, options);
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

    /** The caller's recent runs, newest first. */
    async listRuns(options?: RequestOptions): Promise<WorkspaceRun[]> {
      return (await request<{ runs: WorkspaceRun[] }>("/v1/runs", {}, options, true)).runs;

    },

    getJob,
    streamJob,

    /** Applies workspace settings. Re-index-queuing changes return the queued `job`. */
    updateWorkspace(id: string | undefined, input: UpdateWorkspaceInput, requestOptions?: RequestOptions): Promise<WorkspaceUpdateResponse> {
      return request<WorkspaceUpdateResponse>(wsPath(id), jsonRequest("PATCH", input), requestOptions);
    },
    /** Impact and cost of an {@link UpdateWorkspaceInput}, without applying it. */
    updateWorkspaceEstimate(id: string | undefined, input: UpdateWorkspaceInput, requestOptions?: RequestOptions): Promise<EstimateResponse> {
      return estimateAt(`${wsPath(id)}/estimate`, input, requestOptions);
    },
    updateSearchSettings(id: string | undefined, input: JsonObject, requestOptions?: RequestOptions): Promise<WorkspaceUpdateResponse> {
      return request<WorkspaceUpdateResponse>(`${wsPath(id)}/search-settings`, jsonRequest("PATCH", input), requestOptions);
    },
    /** Session-only: the search-settings mutation accepts no API key. */
    updateSearchSettingsEstimate(id: string | undefined, input: JsonObject, requestOptions?: RequestOptions): Promise<EstimateResponse> {
      return estimateAt(`${wsPath(id)}/search-settings/estimate`, input, requestOptions);
    },
    /**
     * Re-runs a run's documents as new versions (all stages, `stageFrom` on, or only `stages`). Server keys need
     * `ingest`. Re-extracts files whose bytes did not change, which a re-upload would not (identical bytes reuse
     * the earlier extraction). Spends credits; price it with {@link reprocessEstimate}.
     */
    async reprocessRun(runId: string, input: ReprocessRunInput = {}, requestOptions?: RequestOptions): Promise<ReprocessRunResult> {
      const body = await request<WorkspaceRun & { run?: WorkspaceRun; job?: JobStatus; warnings?: string[] }>(
        `/v1/runs/${encodeURIComponent(runId)}/reprocess`, jsonRequest("POST", input), requestOptions,
      );
      // A deferred start answers { run, warnings, job }; a started one answers the run itself plus job.
      if (body.run) return { run: body.run, job: body.job, warnings: body.warnings ?? [] };
      const { job, warnings: _warnings, ...run } = body;
      return { run: run as WorkspaceRun, job, warnings: [] };
    },
    /** What {@link reprocessRun} would cost, without starting it. Server keys need `ingest`. */
    reprocessEstimate(runId: string, input: JsonObject = {}, requestOptions?: RequestOptions): Promise<EstimateResponse> {
      return estimateAt(`/v1/runs/${encodeURIComponent(runId)}/reprocess/estimate`, input, requestOptions);
    },
    /** Cost of fully indexing one document (`{ documentId }`) or a workspace (`{ workspace?, documentIds? }`). */
    fullIndexEstimate(input: { documentId: string } | { workspace?: string; documentIds?: string[] } = {}, requestOptions?: RequestOptions): Promise<EstimateResponse> {
      if ("documentId" in input) return estimateAt(`/v1/documents/${encodeURIComponent(input.documentId)}/full-index/estimate`, {}, requestOptions);
      return estimateAt(`${wsPath(input.workspace)}/full-index/estimate`, { documentIds: input.documentIds }, requestOptions);
    },
    rebuildGraphEstimate(input: { workspace?: string } & JsonObject = {}, requestOptions?: RequestOptions): Promise<EstimateResponse> {
      const { workspace, ...body } = input;
      return estimateAt(`${wsPath(typeof workspace === "string" ? workspace : undefined)}/graph/jobs/estimate`, body, requestOptions);
    },
    /** Cost of an upload before sending any bytes. */
    uploadEstimate(input: UploadEstimateInput, requestOptions?: RequestOptions): Promise<EstimateResponse> {
      return estimateAt("/v1/uploads/estimate", inWorkspace(input), requestOptions);
    },
    /**
     * Sets how many versions of each document are kept (1–100; null clears the override).
     * Pass `workspace` for a workspace override, `orgId` for the organization default.
     */
    setRetention(target: { orgId: string } | { workspace?: string }, retainDocumentVersions: number | null, requestOptions?: RequestOptions): Promise<JsonObject> {
      if (retainDocumentVersions !== null && (!Number.isInteger(retainDocumentVersions) || retainDocumentVersions < 1 || retainDocumentVersions > 100)) {
        throw new RangeError("retainDocumentVersions must be an integer from 1 to 100 (or null to clear).");
      }
      const path = "orgId" in target ? `/v1/organizations/${encodeURIComponent(target.orgId)}` : wsPath(target.workspace);
      return request<JsonObject>(path, jsonRequest("PATCH", { retainDocumentVersions }), requestOptions);
    },

    getWorkspaceState(id: string | undefined = clientWorkspace, options: WorkspaceStateOptions = {}): Promise<WorkspaceState> {
      if (!id?.trim()) throw new Error("Set DOCSLURP_WORKSPACE or pass a workspace for workspace state.");
      const hours = options.recentWindowHours ?? 24;
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new RangeError("recentWindowHours must be an integer from 1 to 720");
      return request<WorkspaceState>(`/v1/workspaces/${encodeURIComponent(id)}/state?recentWindowHours=${hours}`, {}, options, true);
    },

    /**
     * Ingest report: pages, bytes, text layer, images, vision, searchability and
     * cost for the workspace (default workspace when none is configured), plus
     * the settings that shaped it and recommendations. No model call.
     */
    /** Re-runs a recommendation's affected files (up to 100) with the workspace's current settings. Server keys need `ingest`. */
    reprocessIngestRecommendation(id: string | undefined, input: IngestRecommendationInput, options?: RequestOptions): Promise<IngestRecommendationReprocessResult> {
      return request(`/v1/workspaces/${encodeURIComponent(id?.trim() || clientWorkspace)}/ingest-report/reprocess`, jsonRequest("POST", input), options);
    },
    /** Applies a recommendation's own settings patch to the workspace. Server keys need `workspaces:manage`. */
    applyIngestRecommendation(id: string | undefined, input: IngestRecommendationInput, options?: RequestOptions): Promise<IngestRecommendationApplyResult> {
      return request(`/v1/workspaces/${encodeURIComponent(id?.trim() || clientWorkspace)}/ingest-report/apply`, jsonRequest("POST", input), options);
    },
    getIngestReport(id: string | undefined = clientWorkspace, options: IngestReportOptions = {}): Promise<IngestReport> {
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

    /**
     * Streamed grounded answer, as a streaming companion to chat(). Yields a
     * retrieval `status`, the `message` (a full ChatResponse) and a final `done`
     * envelope. Throws if the stream ends before `done`, so a truncated answer
     * is never mistaken for success. This targets the legacy SSE endpoint; for
     * the canonical stream use POST /v1/chat/completions with stream: true.
     */
    async *chatStream(input: ChatInput, requestOptions: RequestOptions = {}): AsyncGenerator<ChatStreamEvent> {
      const target = inWorkspace(input);
      const params = new URLSearchParams({ q: target.q, workspace: target.workspace ?? clientWorkspace });
      if (target.sessionId) params.set("sessionId", target.sessionId);
      if (target.model) params.set("model", target.model);
      let completed = false;
      for await (const frame of streamEventsAt(`/v1/search/chat/stream?${params.toString()}`, requestOptions)) {
        if (frame.event === "status" || frame.event === "message" || frame.event === "done") {
          if (frame.event === "done") completed = true;
          yield { event: frame.event, data: frame.data } as ChatStreamEvent;
        }
      }
      if (!completed) throw new Error("DocSlurp chat stream ended before completion");
    },

    getDocument(documentId: string, requestOptions?: RequestOptions): Promise<DocumentViewerPayload> {
      return request<DocumentViewerPayload>(`/v1/documents/${encodeURIComponent(documentId)}`, {}, requestOptions, true);
    },

    /** Documents in a workspace (the client default unless one is passed), newest first. */
    async listDocuments(input: ListDocumentsInput = {}, requestOptions?: RequestOptions): Promise<DocumentRecord[]> {
      const params = new URLSearchParams({ workspace: input.workspace?.trim() || clientWorkspace });
      if (input.runId) params.set("runId", input.runId);
      if (input.tags) params.set("tags", input.tags);
      return (await request<{ documents: DocumentRecord[] }>(`/v1/documents?${params.toString()}`, {}, requestOptions, true)).documents;

    },

    /** Every version of a document (newest first), including archived versions and purged tombstones. */
    async listDocumentVersions(documentId: string, requestOptions?: RequestOptions): Promise<DocumentVersionEntry[]> {
      const body = await request<{ versions: DocumentVersionEntry[] }>(`/v1/documents/${encodeURIComponent(documentId)}/versions`, {}, requestOptions, true);
      return body.versions;
    },

    /**
     * Delete a document and return the identities of the removed record.
     * Server keys need `ingest`; browser keys can't delete. 409 while a run is still processing the document.
     */
    deleteDocument(documentId: string, requestOptions?: RequestOptions): Promise<DeletedDocument> {
      return request<DeletedDocument>(`/v1/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }, requestOptions);
    },
    /** Replaces a document's tags (no re-ingestion). Server keys need `ingest`. */
    setDocumentTags(documentId: string, tags: string[], requestOptions?: RequestOptions): Promise<{ documentId: string; tags: string[] }> {
      return request(`/v1/documents/${encodeURIComponent(documentId)}/tags`, jsonRequest("PUT", { tags }), requestOptions);
    },
    /**
     * Reprocesses, retags, deletes or exports many documents at once. Server keys need `ingest` (`artifacts` for
     * `export-artifacts`), and every document must be in a workspace the key can use (404 before any change otherwise).
     */
    bulkDocuments(input: BulkDocumentsInput, requestOptions?: RequestOptions): Promise<BulkDocumentsResult> {
      return request(`/v1/documents/bulk`, jsonRequest("POST", input), requestOptions);
    },

    uploadUrls,
    /** @deprecated Use upload({ urls }) or uploadUrls(). */
    ingestUrls: uploadUrls,
    async listWorkspaceTags(id: string = clientWorkspace, options?: RequestOptions): Promise<Array<{ tag: string; documentCount: number }>> {
      return (await request<{ tags: Array<{ tag: string; documentCount: number }> }>(`/v1/workspaces/${encodeURIComponent(id)}/tags`, {}, options, true)).tags;
    },
    async listWorkspaces(options?: RequestOptions): Promise<WorkspaceRecord[]> {
      return (await request<{ workspaces: WorkspaceRecord[] }>("/v1/workspaces", {}, options, true)).workspaces;
    },
    getWorkspace(id: string, options?: RequestOptions): Promise<WorkspaceRecord> {
      return request(`/v1/workspaces/${encodeURIComponent(id)}`, {}, options, true);
    },
    createUploadSession(input: UploadSessionInput, options?: RequestOptions): Promise<UploadSession> {
      return request("/v1/uploads/direct/sessions", jsonRequest("POST", { ...input, ...intakeTarget(input) }), options);
    },
    getUploadSession(sessionId: string, options?: RequestOptions): Promise<UploadSession> {
      return request(`/v1/uploads/direct/sessions/${encodeURIComponent(sessionId)}`, {}, options, true);
    },
    completeUploadFile(sessionId: string, input: CompleteUploadFileInput, options?: RequestOptions): Promise<{ ok: boolean }> {
      return request(`/v1/uploads/direct/sessions/${encodeURIComponent(sessionId)}/files/complete`, jsonRequest("POST", input), options);
    },
    signUploadParts(sessionId: string, fileId: string, partNumbers: number[], options?: RequestOptions): Promise<{ parts: Array<{ partNumber: number; url: string }> }> {
      return request(`/v1/uploads/direct/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/parts/sign`, jsonRequest("POST", { partNumbers }), options);
    },
    completeUploadSession(sessionId: string, options?: RequestOptions): Promise<UploadResponse> {
      return request(`/v1/uploads/direct/sessions/${encodeURIComponent(sessionId)}/confirm`, { method: "POST" }, options);
    },
    abortUploadSession(sessionId: string, options?: RequestOptions): Promise<{ ok: boolean }> {
      return request(`/v1/uploads/direct/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }, options);
    },

    search,

    upload,

    /** Mints a sealed `X-DocSlurp-Capability` token a browser can use; needs a server key. */
    createCapability(input: CreateCapabilityInput = {}, requestOptions?: RequestOptions): Promise<{ token: string; expiresAt: string } & JsonObject> {
      return request("/v1/capabilities", jsonRequest("POST", input), requestOptions);
    },

    /** Indexes every unindexed page of a workspace (or the given documents) in the background. */
    fullIndex(input: { workspace?: string; documentIds?: string[] } = {}, requestOptions?: RequestOptions): Promise<FullIndexResponse> {
      return request<FullIndexResponse>(`${wsPath(input.workspace)}/full-index`, jsonRequest("POST", { documentIds: input.documentIds }), requestOptions);
    },

    /** Indexes one document in full. */
    fullIndexDocument(documentId: string, requestOptions?: RequestOptions): Promise<FullIndexResponse> {
      return request<FullIndexResponse>(`/v1/documents/${encodeURIComponent(documentId)}/full-index`, { method: "POST" }, requestOptions);
    },

    estimateIndexingMode,
    /** Alias of {@link estimateIndexingMode}. */
    setIndexingModeEstimate(mode: IndexingMode, input: { workspace?: string } = {}, requestOptions?: RequestOptions) {
      return estimateIndexingMode(mode, input, requestOptions);
    },
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
