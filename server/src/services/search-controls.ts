import { randomUUID } from "node:crypto";

import {
  defaultWorkspaceSearchSettings,
  updateWorkspaceSearchSettingsSchema,
  workspaceSearchSettingsSchema,
  type SearchResult,
  type UpdateWorkspaceSearchSettingsInput,
  type WorkspaceSearchSettings
} from "@docslurp/shared";

import { sql } from "../db.js";
import { canEditWorkspace, getWorkspaceAccess } from "./organizations.js";

export type SettingsRow = {
  workspace_id: string;
  user_id: string;
  typo_tolerance: boolean;
  dedupe_by_filename: boolean;
  ranking_rules: Record<string, unknown> | null;
  boosts: Record<string, unknown> | null;
  pinned_results: Array<{ queryPattern: string; documentId?: string; chunkId?: string; rank?: number }> | null;
  synonyms: Record<string, string[]> | null;
  compat_settings: Record<string, unknown> | null;
  rules: Array<Record<string, unknown>> | null;
  compat_metadata: Record<string, unknown> | null;
};

export async function getWorkspaceSearchSettings(workspaceId: string, userId: string, client: typeof sql = sql): Promise<WorkspaceSearchSettings> {
  const [row] = await client<SettingsRow[]>`
    select workspace_id, user_id, typo_tolerance, dedupe_by_filename, ranking_rules, boosts, pinned_results, synonyms, compat_settings, rules, compat_metadata
    from workspace_search_settings
    where workspace_id = ${workspaceId}
    limit 1
  `;

  return parseWorkspaceSearchSettingsRow(row, workspaceId, userId);
}

/** Settings from a workspace_search_settings row (defaults without one); shared with the one-query search setup. */
export function parseWorkspaceSearchSettingsRow(row: SettingsRow | undefined, workspaceId: string, userId: string): WorkspaceSearchSettings {
  if (!row) {
    return workspaceSearchSettingsSchema.parse({
      ...defaultWorkspaceSearchSettings,
      workspaceId,
      userId
    });
  }

  const compatMetadata = row.compat_metadata ?? {};
  const workspaceUi = readWorkspaceUiSettings(compatMetadata);

  return workspaceSearchSettingsSchema.parse({
    workspaceId,
    userId: row.user_id,
    typoTolerance: row.typo_tolerance,
    dedupeByFilename: row.dedupe_by_filename,
    rankingRules: row.ranking_rules ?? {},
    boosts: row.boosts ?? {},
    pinnedResults: row.pinned_results ?? [],
    synonyms: row.synonyms ?? {},
    retrievalDefaults: workspaceUi.retrievalDefaults,
    chat: workspaceUi.chat,
    compatSettings: row.compat_settings ?? {},
    rules: row.rules ?? [],
    compatMetadata
  });
}

export async function upsertWorkspaceSearchSettings(settings: WorkspaceSearchSettings, client: typeof sql = sql): Promise<void> {
  const parsed = workspaceSearchSettingsSchema.parse(settings);
  const rankingRulesJson = JSON.parse(JSON.stringify(parsed.rankingRules)) as Record<string, unknown>;
  const boostsJson = JSON.parse(JSON.stringify(parsed.boosts)) as Record<string, unknown>;
  const pinnedResultsJson = JSON.parse(JSON.stringify(parsed.pinnedResults)) as Array<Record<string, unknown>>;
  const synonymsJson = JSON.parse(JSON.stringify(parsed.synonyms)) as Record<string, string[]>;
  const compatSettingsJson = JSON.parse(JSON.stringify(parsed.compatSettings)) as Record<string, unknown>;
  const rulesJson = JSON.parse(JSON.stringify(parsed.rules)) as Array<Record<string, unknown>>;
  const compatMetadataJson = JSON.parse(JSON.stringify({
    ...parsed.compatMetadata,
    workspaceUi: {
      retrievalDefaults: parsed.retrievalDefaults,
      chat: parsed.chat
    }
  })) as Record<string, unknown>;

  await client`
    insert into workspace_search_settings (
      workspace_id, user_id, typo_tolerance, dedupe_by_filename, ranking_rules, boosts, pinned_results, synonyms, compat_settings, rules, compat_metadata
    ) values (
      ${parsed.workspaceId},
      ${parsed.userId},
      ${parsed.typoTolerance},
      ${parsed.dedupeByFilename},
      ${client.json(rankingRulesJson as Parameters<typeof sql.json>[0])},
      ${client.json(boostsJson as Parameters<typeof sql.json>[0])},
      ${client.json(pinnedResultsJson as Parameters<typeof sql.json>[0])},
      ${client.json(synonymsJson as Parameters<typeof sql.json>[0])},
      ${client.json(compatSettingsJson as Parameters<typeof sql.json>[0])},
      ${client.json(rulesJson as Parameters<typeof sql.json>[0])},
      ${client.json(compatMetadataJson as Parameters<typeof sql.json>[0])}
    )
    on conflict (workspace_id) do update set
      user_id = excluded.user_id,
      typo_tolerance = excluded.typo_tolerance,
      dedupe_by_filename = excluded.dedupe_by_filename,
      ranking_rules = excluded.ranking_rules,
      boosts = excluded.boosts,
      pinned_results = excluded.pinned_results,
      synonyms = excluded.synonyms,
      compat_settings = excluded.compat_settings,
      rules = excluded.rules,
      compat_metadata = excluded.compat_metadata,
      updated_at = now()
  `;
}

export async function getWorkspaceSearchSettingsForUser(
  workspaceId: string,
  userId: string
): Promise<WorkspaceSearchSettings | null> {
  const access = await getWorkspaceAccess(workspaceId, userId);
  if (!access) {
    return null;
  }

  return await getWorkspaceSearchSettings(workspaceId, userId);
}

/** Applies a retrieval-defaults patch; a null clears an optional (pipeline-derived) setting. */
function mergeRetrievalDefaults(
  current: WorkspaceSearchSettings["retrievalDefaults"],
  patch: UpdateWorkspaceSearchSettingsInput["retrievalDefaults"],
): WorkspaceSearchSettings["retrievalDefaults"] {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as WorkspaceSearchSettings["retrievalDefaults"];
}

/** The settings a search-settings PATCH would store; pure, shared by the mutation and its estimate. */
export function mergeWorkspaceSearchSettings(
  current: WorkspaceSearchSettings,
  input: UpdateWorkspaceSearchSettingsInput,
): WorkspaceSearchSettings {
  const parsedInput = updateWorkspaceSearchSettingsSchema.parse(input);
  return workspaceSearchSettingsSchema.parse({
    ...current,
    typoTolerance: parsedInput.typoTolerance ?? current.typoTolerance,
    dedupeByFilename: parsedInput.dedupeByFilename ?? current.dedupeByFilename,
    rankingRules: parsedInput.rankingRules ?? current.rankingRules,
    boosts: parsedInput.boosts ?? current.boosts,
    pinnedResults: parsedInput.pinnedResults ?? current.pinnedResults,
    synonyms: parsedInput.synonyms ?? current.synonyms,
    retrievalDefaults: mergeRetrievalDefaults(current.retrievalDefaults, parsedInput.retrievalDefaults),
    chat: {
      ...current.chat,
      ...(parsedInput.chat ?? {})
    }
  });
}

export async function updateWorkspaceSearchSettingsForUser(args: {
  workspaceId: string;
  userId: string;
  input: UpdateWorkspaceSearchSettingsInput;
}): Promise<WorkspaceSearchSettings | null> {
  return mutateWorkspaceSearchSettingsForUser({ ...args, mutate: current => mergeWorkspaceSearchSettings(current, args.input) });
}

/** Serialize every read/merge/write, including first inserts, with proposal Apply. */
export async function mutateWorkspaceSearchSettingsForUser(args: {
  workspaceId: string;
  userId: string;
  mutate: (current: WorkspaceSearchSettings) => WorkspaceSearchSettings;
}): Promise<WorkspaceSearchSettings | null> {
  return await sql.begin(async tx => {
    const client = tx as unknown as typeof sql;
    await client`select pg_advisory_xact_lock(hashtextextended(${`config-change:${args.workspaceId}`}, 0))`;
    const access = await getWorkspaceAccess(args.workspaceId, args.userId, client);
    if (!access || !canEditWorkspace(access, args.userId)) return null;
    const current = await getWorkspaceSearchSettings(args.workspaceId, args.userId, client);
    const next = args.mutate(current);
    await upsertWorkspaceSearchSettings(next, client);
    await client`update workspaces set updated_at=now() where id=${args.workspaceId}`;
    return next;
  });
}

/**
 * Whether this user may change a workspace's search configuration. The session
 * route already enforces this (updateWorkspaceSearchSettingsForUser); the
 * compatibility routes (Algolia/Meilisearch/Typesense/Pagefind) must enforce the
 * same rule, or a read-only workspace member can rewrite settings through an API
 * key they are allowed to create. Security finding SEC-2026-10-01.
 */
export async function userCanEditWorkspaceSettings(workspaceId: string, userId: string): Promise<boolean> {
  const access = await getWorkspaceAccess(workspaceId, userId);
  return access !== null && canEditWorkspace(access, userId);
}

export function applySearchControls(args: {
  query: string;
  results: SearchResult[];
  settings: WorkspaceSearchSettings;
}): SearchResult[] {
  let out = [...args.results];

  // De-duplicate by filename if requested
  if (args.settings.dedupeByFilename) {
    const uniqueDocumentKeys = new Set(
      out
        .map((result) => result.citation.filename || result.citation.documentId)
        .filter((key): key is string => Boolean(key)),
    );

    if (uniqueDocumentKeys.size > 1) {
      const seen = new Set<string>();
      out = out.filter((r) => {
        const key = r.citation.filename || r.citation.documentId;
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }

  // Boosts: simple numeric add/multiply based on tags/mime/heading
  // We keep it intentionally minimal for now.
  const boosts = normalizeBoosts(args.settings.boosts);
  if (boosts.any) {
    const anyBoost = boosts.any;
    out = out.map((r) => ({
      ...r,
      score: r.score + anyBoost
    }));
  }
  if (boosts.byMime) {
    const boostsByMime = boosts.byMime;
    out = out.map((r) => ({
      ...r,
      score: r.score + (boostsByMime[getMime(r.citation.filename)] ?? 0)
    }));
  }

  // Pinned results: place matching pins at preferred rank
  const pins = (args.settings.pinnedResults ?? []).filter((p) => matchesQuery(args.query, p.queryPattern));
  if (pins.length > 0) {
    const idSet = new Set<string>(out.map((r) => `${r.citation.documentId}:${r.citation.chunkIndex}`));
    const pinned: SearchResult[] = [];
    for (const p of pins) {
      let candidate: SearchResult | null = null;
      if (p.chunkId) {
        candidate = out.find((r) => `${r.citation.documentId}:${r.citation.chunkIndex}` === p.chunkId) ?? null;
      } else if (p.documentId) {
        candidate = out.find((r) => r.citation.documentId === p.documentId) ?? null;
      }
      if (candidate) {
        idSet.delete(`${candidate.citation.documentId}:${candidate.citation.chunkIndex}`);
        pinned.push(candidate);
      }
    }
    const remaining = out.filter((r) => idSet.has(`${r.citation.documentId}:${r.citation.chunkIndex}`));
    const orderedPins = pinned.sort((a, b) => (safeRank(a, pins) - safeRank(b, pins)));
    out = [...orderedPins, ...remaining];
  }

  return out;
}

function readWorkspaceUiSettings(metadata: Record<string, unknown>) {
  const defaults = defaultWorkspaceSearchSettings;
  const workspaceUi = metadata.workspaceUi;

  if (!workspaceUi || typeof workspaceUi !== "object") {
    return {
      retrievalDefaults: defaults.retrievalDefaults,
      chat: defaults.chat
    };
  }

  const uiRecord = workspaceUi as Record<string, unknown>;
  return {
    retrievalDefaults: workspaceSearchSettingsSchema.shape.retrievalDefaults.parse(uiRecord.retrievalDefaults ?? {}),
    chat: workspaceSearchSettingsSchema.shape.chat.parse(uiRecord.chat ?? {})
  };
}

export async function recordZeroResultDiagnostics(args: {
  sessionId: string;
  userId: string;
  workspaceId: string;
  query: string;
  filtersJson: Record<string, unknown>;
}): Promise<void> {
  // Only current (non-superseded) documents serve search; stop at the first chunk.
  const emptyIndexRows = await sql<{ count: number }[]>`
    select count(*)::int as count
    from (
      select 1
      from document_chunks c
      join documents d on d.id = c.document_id
      where d.workspace_id = ${args.workspaceId}
        and d.superseded_at is null
      limit 1
    ) indexed
  `;

  const reasons: string[] = [];
  const suggestions: Array<{ kind: string; message: string }> = [];

  if ((emptyIndexRows[0]?.count ?? 0) === 0) {
    reasons.push("empty-index");
    suggestions.push({ kind: "ingest", message: "No indexed content. Upload and index documents for this workspace." });
  }

  // Heuristic: very short query
  if (args.query.trim().split(/\s+/).filter(Boolean).length === 1 && args.query.length < 4) {
    reasons.push("query-too-short");
    suggestions.push({ kind: "lengthen-query", message: "Use a longer or more specific query." });
  }

  // One row per search session: a session id reused across attempts replaces
  // its earlier diagnostics instead of counting the same search again.
  await sql`
    with cleared as (
      delete from search_zero_results where session_id = ${args.sessionId}
    )
    insert into search_zero_results (id, session_id, user_id, workspace_id, reason, suggestions)
    values (${randomUUID()}, ${args.sessionId}, ${args.userId}, ${args.workspaceId}, ${reasons.join("|") || "unknown"}, ${sql.json(suggestions)})
  `;
}

function normalizeBoosts(boosts: Record<string, unknown>): {
  any?: number;
  byMime?: Record<string, number>;
} {
  const out: { any?: number; byMime?: Record<string, number> } = {};
  if (typeof (boosts as any).any === "number") out.any = (boosts as any).any as number;
  if (boosts && typeof boosts === "object" && (boosts as any).byMime) {
    out.byMime = {};
    const byMime = (boosts as any).byMime as Record<string, unknown>;
    for (const [k, v] of Object.entries(byMime)) {
      if (typeof v === "number") out.byMime![k] = v;
    }
  }
  return out;
}

function getMime(filename: string): string {
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  return "unknown";
}

function matchesQuery(query: string, pattern: string): boolean {
  try {
    const re = new RegExp(pattern, "i");
    return re.test(query);
  } catch {
    return query.toLowerCase().includes(pattern.toLowerCase());
  }
}

function safeRank(item: SearchResult, pins: Array<{ queryPattern: string; documentId?: string; chunkId?: string; rank?: number }>): number {
  const index = pins.findIndex((p) => (p.chunkId && `${item.citation.documentId}:${item.citation.chunkIndex}` === p.chunkId) || (p.documentId && p.documentId === item.citation.documentId));
  const desired = index >= 0 ? pins[index]?.rank : undefined;
  return desired ?? (index >= 0 ? index + 1 : Number.MAX_SAFE_INTEGER);
}
