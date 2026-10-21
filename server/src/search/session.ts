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
import { trackCurrentChatTurnWrite } from "../lib/chat-turn-context.js";

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
}

export interface SearchSessionScope {
  workspaceId?: string | null;
  orgId?: string | null;
}

export function createSearchSessionJournal(args: {
  rootSessionId?: string;
  scope?: SearchSessionScope;
}): SearchSessionJournal {
  return new SqlSearchSessionJournal(
    args.rootSessionId ?? randomUUID(),
    args.scope ?? {},
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
  ) {
    this.sessionId = sessionId;
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
    // The usage flush runs in the snapshot's transaction: a failing chat turn
    // waits for the commit, or its refund would miss these events.
    const pending = trackCurrentChatTurnWrite(this.persistenceTail.then(() => this.persistSnapshot(input)));
    this.persistenceTail = pending.catch(() => undefined);
    return pending;
  }

  flushUsage(userId: string): Promise<void> {
    const pending = trackCurrentChatTurnWrite(this.persistenceTail.then(async () => {
      await this.usage.flush({ userId, scope: { ...this.scope, sessionId: this.sessionId } });
    }));
    this.persistenceTail = pending.catch(() => undefined);
    return pending;
  }

  private async persistSnapshot(input: PersistSearchSessionInput): Promise<void> {
    const encryptionKey = getSearchQueryEncryptionKey();
    const metadataJson = JSON.stringify(
      { ...buildSearchSessionMetadata(input.metadata), durationMs: Date.now() - this.startedAtMs,
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
      await client`delete from search_session_results where session_id = ${this.sessionId}`;
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
