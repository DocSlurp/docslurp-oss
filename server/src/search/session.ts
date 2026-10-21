import { AsyncResource } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

import { sql } from "../db.js";
import {
  createUsageLedger,
  type UsageEvent,
  type UsageInput,
  type UsageLedger,
  type UsageRecorder,
} from "../lib/ai-usage.js";
import type { SearchFilters } from "./filters.js";
import { currentChatSessionId } from "../lib/chat-agent-context.js";
import { reportPublicError } from "../lib/public-errors.js";

export type SearchUsageEvent = UsageEvent;

export interface SearchSessionMetadataInput {
  originalQuery: string;
  effectiveQuery?: string;
  filters?: SearchFilters | Record<string, unknown>;
  options: SearchSessionOptions;
  workspaceId: string;
  selfQueryReasons?: string[];
  availability?: unknown;
  retrievalChain?: unknown;
  finalization?: unknown;
  diagnostics?: Record<string, unknown>;
}

export interface PersistSearchSessionInput {
  userId: string;
  query: string;
  variant?: string;
  results: readonly unknown[];
  chunks: readonly SearchSessionChunk[];
  metadata: SearchSessionMetadataInput;
}

export interface SearchSessionChunk {
  id: string;
  score: number;
}

export interface SearchSessionOptions {
  runId?: string;
  filters?: unknown;
  useHyDE?: boolean;
  useRerank?: boolean;
  rerankProvider?: "bm25" | "deepinfra";
  rerankModel?: "Qwen/Qwen3-Reranker-0.6B";
  candidateDepth?: number;
  resultOrder?: "relevance" | "prompt";
  useMmr?: boolean;
  parentRetrieval?: boolean;
  queryRewrite?: boolean;
  queryDecompose?: boolean;
  stepback?: boolean;
  summarySeed?: boolean;
  useContextualCompression?: boolean;
  selfQuery?: boolean;
  iterativeMultiHop?: boolean;
}

/**
 * Search Session journal. It is the Usage Recorder for every strategy call in
 * one search: `record()` logs and buffers, `adoptUsage()` takes child-search
 * events (already logged by the child) without logging them again, and
 * `persist()` writes buffered events stamped `{sessionId, workspaceId, orgId}`.
 */
export interface SearchSessionJournal extends UsageRecorder {
  readonly sessionId: string;
  record(input: UsageInput): void;
  adoptUsage(events: Iterable<SearchUsageEvent | undefined>): void;
  usageEvents(): SearchUsageEvent[];
  recordDiagnostic(key: string, value: unknown): void;
  diagnostics(): Record<string, unknown>;
  persist(input: PersistSearchSessionInput): Promise<void>;
  /** Flush paid usage even when search fails or suppresses result-session logging. */
  flushUsage(userId: string): Promise<void>;
  /**
   * Run a write that must follow this session's earlier writes (zero-result
   * diagnostics after the session row). Awaited inline, or queued behind the
   * session's writes when they are write-behind.
   */
  afterWrites(task: () => Promise<void>): Promise<void>;
  /** True when persist/flushUsage return before their writes commit. */
  readonly writeBehind: boolean;
}

/**
 * Write-behind (SEARCH_SESSION_WRITE_BEHIND, on by default with
 * SEARCH_LANCEDB_NATIVE): the session row, result ranks, usage events and
 * zero-result diagnostics are written after the response instead of before
 * it. Writes of one session id stay in order (a reused id's latest attempt
 * still decides the rows), at most SEARCH_WRITE_BEHIND_CONCURRENCY run at
 * once so they never crowd searches out of the pool, and readers of a
 * session's rows (GET /search/diagnostics) wait for its pending writes with
 * `awaitSearchSessionWrites`. A failed write is reported, never thrown at the
 * search that already answered.
 */
export function searchSessionWriteBehindEnabled(native: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.SEARCH_SESSION_WRITE_BEHIND ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return native;
}

const pendingSessionWrites = new Map<string, Promise<void>>();
const WRITE_BEHIND_RETRY_DELAY_MS = 250;
let saturatedWrites = 0;
function countSaturatedWrite(): void {
  saturatedWrites += 1;
  if (saturatedWrites === 1 || saturatedWrites % 100 === 0) {
    console.warn(`[search] write-behind backlog full (SEARCH_WRITE_BEHIND_MAX_PENDING); ${saturatedWrites} searches waited for their writes`);
  }
}
let activeBackgroundWrites = 0;
const backgroundQueue: Array<() => void> = [];

function writeBehindConcurrency(): number {
  const parsed = Number(process.env.SEARCH_WRITE_BEHIND_CONCURRENCY);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 2;
}

/**
 * Most writes allowed to wait for a background slot (SEARCH_WRITE_BEHIND_MAX_PENDING,
 * default 200). Past it a search waits for its own writes, as without write-behind:
 * the backlog (and the usage a crash could lose, and the spend budgets cannot see
 * yet) stays bounded instead of growing with load.
 */
function writeBehindMaxPending(): number {
  const parsed = Number(process.env.SEARCH_WRITE_BEHIND_MAX_PENDING);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 200;
}

/** Background session writes queued or running in this process. */
export function searchSessionWriteBacklog(): { active: number; queued: number } {
  return { active: activeBackgroundWrites, queued: backgroundQueue.length };
}

/** Run `task` when a background write slot is free. */
function inBackgroundSlot(task: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = () => {
      activeBackgroundWrites++;
      task().then(resolve, reject).finally(() => {
        activeBackgroundWrites--;
        backgroundQueue.shift()?.();
      });
    };
    if (activeBackgroundWrites < writeBehindConcurrency()) start();
    else backgroundQueue.push(start);
  });
}

/** Wait (bounded) until the session's queued writes have committed or failed. */
export async function awaitSearchSessionWrites(sessionId: string, timeoutMs = 5_000): Promise<void> {
  const pending = pendingSessionWrites.get(sessionId);
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
  clearTimeout(timer);
}

/** Tests and shutdown: wait for every queued session write (at most `timeoutMs` when given). */
export async function drainSearchSessionWrites(timeoutMs?: number): Promise<void> {
  const drain = (async () => {
    while (pendingSessionWrites.size > 0) await Promise.all([...pendingSessionWrites.values()]);
  })();
  if (timeoutMs === undefined) return await drain;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([drain, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
  clearTimeout(timer);
}

export interface SearchSessionScope {
  workspaceId?: string | null;
  orgId?: string | null;
}

export function createSearchSessionJournal(args: {
  rootSessionId?: string;
  scope?: SearchSessionScope;
  writeBehind?: boolean;
}): SearchSessionJournal {
  return new SqlSearchSessionJournal(
    args.rootSessionId ?? randomUUID(),
    args.scope ?? {},
    args.writeBehind ?? false,
  );
}

export function toSearchMetadataRecord(
  value: SearchFilters | Record<string, unknown> | undefined,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown>;
}

class SqlSearchSessionJournal implements SearchSessionJournal {
  readonly sessionId: string;
  private readonly startedAtMs = Date.now();

  private readonly usage: UsageLedger = createUsageLedger({});
  private persistenceTail: Promise<void> = Promise.resolve();
  private readonly diagnosticEvents: Record<string, unknown> = {};
  /** The chat turn whose search agent ran this retrieval, if any. */
  private readonly chatSessionId = currentChatSessionId();

  constructor(
    sessionId: string,
    private readonly scope: SearchSessionScope,
    readonly writeBehind: boolean = false,
  ) {
    this.sessionId = sessionId;
  }

  /**
   * Chain `write` after this session's earlier writes. Inline: the caller
   * awaits it and sees its error. Write-behind: it runs in a background slot,
   * in the caller's async context (request-scoped API key attribution), after
   * any earlier queued write for the same session id, even from another
   * journal; the returned promise resolves at once.
   */
  private enqueue(write: () => Promise<void>, operation: string): Promise<void> {
    if (!this.writeBehind) {
      const pending = this.persistenceTail.then(write);
      this.persistenceTail = pending.catch(() => undefined);
      return pending;
    }
    const bound = AsyncResource.bind(write);
    // Backpressure: a full backlog makes this search wait for its own write.
    const saturated = backgroundQueue.length >= writeBehindMaxPending();
    const previous = pendingSessionWrites.get(this.sessionId) ?? Promise.resolve();
    const pending = Promise.all([previous, this.persistenceTail])
      .then(() => inBackgroundSlot(bound))
      // One retry, as the inline path retries a failed usage flush: these writes carry billed usage.
      // A failed attempt rolled back (each write is one transaction), so retrying cannot double it.
      .catch(async () => {
        await new Promise<void>((resolve) => { setTimeout(resolve, WRITE_BEHIND_RETRY_DELAY_MS); });
        await inBackgroundSlot(bound);
      })
      .catch((error) => { reportPublicError(error, { operation: `search-write-behind:${operation}`, sessionId: this.sessionId }); });
    this.persistenceTail = pending;
    pendingSessionWrites.set(this.sessionId, pending);
    void pending.finally(() => {
      if (pendingSessionWrites.get(this.sessionId) === pending) pendingSessionWrites.delete(this.sessionId);
    });
    if (saturated) countSaturatedWrite();
    return saturated ? pending : Promise.resolve();
  }

  afterWrites(task: () => Promise<void>): Promise<void> {
    return this.enqueue(task, "after-writes");
  }

  record(input: UsageInput): void {
    this.usage.record(this.chatSessionId ? { ...input, metadata: { ...input.metadata, chatSessionId: this.chatSessionId } } : input);
  }

  adoptUsage(events: Iterable<SearchUsageEvent | undefined>): void {
    this.usage.adopt(events);
  }

  usageEvents(): SearchUsageEvent[] {
    return this.usage.events();
  }

  recordDiagnostic(key: string, value: unknown): void {
    this.diagnosticEvents[key] = JSON.parse(JSON.stringify(value ?? null));
  }

  diagnostics(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.diagnosticEvents)) as Record<
      string,
      unknown
    >;
  }

  persist(input: PersistSearchSessionInput): Promise<void> {
    // Snapshot now: the metadata and duration describe the search as it answered.
    const durationMs = Date.now() - this.startedAtMs;
    return this.enqueue(() => this.persistSnapshot(input, durationMs), "persist");
  }

  flushUsage(userId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.usage.flush({ userId, scope: { ...this.scope, sessionId: this.sessionId } });
    }, "usage");
  }

  private async persistSnapshot(input: PersistSearchSessionInput, durationMs: number): Promise<void> {
    const encryptionKey = getSearchQueryEncryptionKey();
    const metadataJson = JSON.stringify(
      { ...buildSearchSessionMetadata(input.metadata), durationMs,
        ...(this.chatSessionId ? { chatSessionId: this.chatSessionId } : {}) },
    );
    const usageBatch = await sql.begin(async (client) => {
      const storedQuery = encryptionKey
        ? client`'enc:pgp:v1:' || encode(pgp_sym_encrypt(${input.query}, ${encryptionKey}), 'base64')`
        : redactedSearchQuery(input.query);
      const sessions = await client<{ id: string; inserted: boolean }[]>`
        insert into search_sessions (id, user_id, query, variant, result_count, metadata)
        values (
          ${this.sessionId},
          ${input.userId},
          ${storedQuery},
          ${input.variant ?? null},
          ${input.results.length},
          ${metadataJson}::text::jsonb
        )
        on conflict (id) do update set
          result_count = excluded.result_count,
          metadata = excluded.metadata,
          variant = excluded.variant
        where search_sessions.user_id = excluded.user_id
          and search_sessions.metadata ->> 'workspaceId' = excluded.metadata ->> 'workspaceId'
          and search_sessions.metadata ->> 'queryHash' = excluded.metadata ->> 'queryHash'
        returning id, (xmax = 0) as inserted
      `;
      if (sessions.length === 0) {
        throw new Error("Search session belongs to a different query or scope");
      }
      // A reused session id whose latest attempt found results is no longer a
      // zero-result search. A fresh row cannot have diagnostics yet.
      if (!sessions[0]!.inserted && input.results.length > 0) {
        await client`delete from search_zero_results where session_id = ${this.sessionId}`;
      }

      // Keep ranks/citations aligned with the latest streamed snapshot, while
      // retaining usage for every actual retrieval attempt under the root id.
      // A freshly inserted session has no result rows to replace.
      if (!sessions[0]!.inserted) await client`delete from search_session_results where session_id = ${this.sessionId}`;
      if (input.chunks.length > 0) {
        const rows = input.chunks.map((c, i) => ({
          id: randomUUID(),
          session_id: this.sessionId,
          chunk_id: c.id,
          rank: i + 1,
          score: c.score,
        }));
        await client`insert into search_session_results ${client(rows)}`;
      }

      return await this.usage.flushWithin(client, {
        userId: input.userId,
        scope: {
          sessionId: this.sessionId,
          workspaceId: this.scope.workspaceId ?? input.metadata.workspaceId,
          orgId: this.scope.orgId ?? null,
        },
      });
    });
    // Advance only after commit, so a rolled-back write remains retryable.
    usageBatch.commit();
  }
}

export function buildSearchSessionMetadata(
  args: SearchSessionMetadataInput,
): Record<string, unknown> {
  return {
    queryHash: hashSearchQuery(args.originalQuery),
    effectiveQueryHash: args.effectiveQuery
      ? hashSearchQuery(args.effectiveQuery)
      : null,
    filters: toSearchMetadataRecord(args.filters),
    selfQueryReasons: args.selfQueryReasons ?? [],
    workspaceId: args.workspaceId,
    runId: args.options.runId ?? null,
    useHyDE: args.options.useHyDE ?? false,
    useRerank: args.options.useRerank ?? false,
    rerankProvider: args.options.rerankProvider ?? "bm25",
    rerankModel: args.options.rerankProvider === "deepinfra" ? (args.options.rerankModel ?? "Qwen/Qwen3-Reranker-0.6B") : null,
    candidateDepth: args.options.candidateDepth ?? null,
    resultOrder: args.options.resultOrder ?? null,
    useMmr: args.options.useMmr ?? false,
    parentRetrieval: args.options.parentRetrieval ?? false,
    queryRewrite: args.options.queryRewrite ?? false,
    queryDecompose: args.options.queryDecompose ?? false,
    stepback: args.options.stepback ?? false,
    summarySeed: args.options.summarySeed ?? false,
    useContextualCompression: args.options.useContextualCompression ?? false,
    selfQuery: args.options.selfQuery ?? false,
    iterativeMultiHop: args.options.iterativeMultiHop ?? false,
    availability: args.availability ?? null,
    retrievalChain: args.retrievalChain ?? [],
    finalization: args.finalization ?? null,
    diagnostics: args.diagnostics ?? {},
    deferred: (args.diagnostics as { deferred?: unknown } | undefined)?.deferred ?? null,
  };
}

function hashSearchQuery(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex");
}

function getSearchQueryEncryptionKey(): string | null {
  const key =
    process.env.SEARCH_QUERY_ENCRYPTION_KEY ?? process.env.SECRETS_ENCRYPTION_KEY;
  const trimmed = key?.trim();
  return trimmed && trimmed.length >= 32 ? trimmed : null;
}

/**
 * True for a `search_sessions.query` that is stored encrypted (`enc:pgp:v1:`)
 * or hashed (`redacted:sha256:`). Those rows carry no readable query text, so
 * they must never be shown back as suggestions or history.
 */
export function isProtectedStoredQuery(query: string): boolean {
  return query.startsWith("enc:") || query.startsWith("redacted:");
}

function redactedSearchQuery(query: string): string {
  return `redacted:sha256:${hashSearchQuery(query)}`;
}
