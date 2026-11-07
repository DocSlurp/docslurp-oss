import { randomUUID } from "node:crypto";

import {
  defaultProjectSearchSettings,
  updateProjectSearchSettingsSchema,
  projectSearchSettingsSchema,
  type SearchResult,
  type UpdateProjectSearchSettingsInput,
  type ProjectSearchSettings
} from "@docslurp/shared";

import { sql } from "../db.js";
import { notifySearchEligibilityChanged } from "../search/eligibility-hint.js";
import { canEditProject, getProjectAccess } from "./organizations.js";

export type SettingsRow = {
  project_id: string;
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

export async function getProjectSearchSettings(projectId: string, userId: string, client: typeof sql = sql): Promise<ProjectSearchSettings> {
  const [row] = await client<SettingsRow[]>`
    select project_id, user_id, typo_tolerance, dedupe_by_filename, ranking_rules, boosts, pinned_results, synonyms, compat_settings, rules, compat_metadata
    from project_search_settings
    where project_id = ${projectId}
    limit 1
  `;

  return parseProjectSearchSettingsRow(row, projectId, userId);
}

/** Settings from a project_search_settings row (defaults without one); shared with the one-query search setup. */
export function parseProjectSearchSettingsRow(row: SettingsRow | undefined, projectId: string, userId: string): ProjectSearchSettings {
  if (!row) {
    return projectSearchSettingsSchema.parse({
      ...defaultProjectSearchSettings,
      projectId,
      userId
    });
  }

  const compatMetadata = row.compat_metadata ?? {};
  const projectUi = readProjectUiSettings(compatMetadata);

  return projectSearchSettingsSchema.parse({
    projectId,
    userId: row.user_id,
    typoTolerance: row.typo_tolerance,
    dedupeByFilename: row.dedupe_by_filename,
    rankingRules: row.ranking_rules ?? {},
    boosts: row.boosts ?? {},
    pinnedResults: row.pinned_results ?? [],
    synonyms: row.synonyms ?? {},
    retrievalDefaults: projectUi.retrievalDefaults,
    chat: projectUi.chat,
    compatSettings: row.compat_settings ?? {},
    rules: row.rules ?? [],
    compatMetadata
  });
}

export async function upsertProjectSearchSettings(settings: ProjectSearchSettings, client: typeof sql = sql): Promise<void> {
  const parsed = projectSearchSettingsSchema.parse(settings);
  const rankingRulesJson = JSON.parse(JSON.stringify(parsed.rankingRules)) as Record<string, unknown>;
  const boostsJson = JSON.parse(JSON.stringify(parsed.boosts)) as Record<string, unknown>;
  const pinnedResultsJson = JSON.parse(JSON.stringify(parsed.pinnedResults)) as Array<Record<string, unknown>>;
  const synonymsJson = JSON.parse(JSON.stringify(parsed.synonyms)) as Record<string, string[]>;
  const compatSettingsJson = JSON.parse(JSON.stringify(parsed.compatSettings)) as Record<string, unknown>;
  const rulesJson = JSON.parse(JSON.stringify(parsed.rules)) as Array<Record<string, unknown>>;
  const compatMetadataJson = JSON.parse(JSON.stringify({
    ...parsed.compatMetadata,
    projectUi: {
      retrievalDefaults: parsed.retrievalDefaults,
      chat: parsed.chat
    }
  })) as Record<string, unknown>;

  await client`
    insert into project_search_settings (
      project_id, user_id, typo_tolerance, dedupe_by_filename, ranking_rules, boosts, pinned_results, synonyms, compat_settings, rules, compat_metadata
    ) values (
      ${parsed.projectId},
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
    on conflict (project_id) do update set
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
  // Ranking, synonyms and retrieval defaults change answers: drop cached ones in every API process.
  await notifySearchEligibilityChanged(client, [parsed.projectId]);
}

export async function getProjectSearchSettingsForUser(
  projectId: string,
  userId: string
): Promise<ProjectSearchSettings | null> {
  const access = await getProjectAccess(projectId, userId);
  if (!access) {
    return null;
  }

  return await getProjectSearchSettings(projectId, userId);
}

/** Applies a retrieval-defaults patch; a null clears an optional (pipeline-derived) setting. */
function mergeRetrievalDefaults(
  current: ProjectSearchSettings["retrievalDefaults"],
  patch: UpdateProjectSearchSettingsInput["retrievalDefaults"],
): ProjectSearchSettings["retrievalDefaults"] {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as ProjectSearchSettings["retrievalDefaults"];
}

/** The settings a search-settings PATCH would store; pure, shared by the mutation and its estimate. */
export function mergeProjectSearchSettings(
  current: ProjectSearchSettings,
  input: UpdateProjectSearchSettingsInput,
): ProjectSearchSettings {
  const parsedInput = updateProjectSearchSettingsSchema.parse(input);
  return projectSearchSettingsSchema.parse({
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

export async function updateProjectSearchSettingsForUser(args: {
  projectId: string;
  userId: string;
  input: UpdateProjectSearchSettingsInput;
}): Promise<ProjectSearchSettings | null> {
  return mutateProjectSearchSettingsForUser({ ...args, mutate: current => mergeProjectSearchSettings(current, args.input) });
}

/** Serialize every read/merge/write, including first inserts, with proposal Apply. */
export async function mutateProjectSearchSettingsForUser(args: {
  projectId: string;
  userId: string;
  mutate: (current: ProjectSearchSettings) => ProjectSearchSettings;
}): Promise<ProjectSearchSettings | null> {
  return await sql.begin(async tx => {
    const client = tx as unknown as typeof sql;
    await client`select pg_advisory_xact_lock(hashtextextended(${`config-change:${args.projectId}`}, 0))`;
    const access = await getProjectAccess(args.projectId, args.userId, client);
    if (!access || !canEditProject(access, args.userId)) return null;
    const current = await getProjectSearchSettings(args.projectId, args.userId, client);
    const next = args.mutate(current);
    await upsertProjectSearchSettings(next, client);
    await client`update projects set updated_at=now() where id=${args.projectId}`;
    return next;
  });
}

/**
 * Whether this user may change a project's search configuration. The session
 * route already enforces this (updateProjectSearchSettingsForUser); the
 * compatibility routes (Algolia/Meilisearch/Typesense/Pagefind) must enforce the
 * same rule, or a read-only project member can rewrite settings through an API
 * key they are allowed to create. Security finding SEC-2026-10-01.
 */
export async function userCanEditProjectSettings(projectId: string, userId: string): Promise<boolean> {
  const access = await getProjectAccess(projectId, userId);
  return access !== null && canEditProject(access, userId);
}

export function applySearchControls(args: {
  query: string;
  results: SearchResult[];
  settings: ProjectSearchSettings;
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

function readProjectUiSettings(metadata: Record<string, unknown>) {
  const defaults = defaultProjectSearchSettings;
  const projectUi = metadata.projectUi;

  if (!projectUi || typeof projectUi !== "object") {
    return {
      retrievalDefaults: defaults.retrievalDefaults,
      chat: defaults.chat
    };
  }

  const uiRecord = projectUi as Record<string, unknown>;
  return {
    retrievalDefaults: projectSearchSettingsSchema.shape.retrievalDefaults.parse(uiRecord.retrievalDefaults ?? {}),
    chat: projectSearchSettingsSchema.shape.chat.parse(uiRecord.chat ?? {})
  };
}

export async function recordZeroResultDiagnostics(args: {
  sessionId: string;
  userId: string;
  projectId: string;
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
      where d.project_id = ${args.projectId}
        and d.superseded_at is null
      limit 1
    ) indexed
  `;

  const reasons: string[] = [];
  const suggestions: Array<{ kind: string; message: string }> = [];

  if ((emptyIndexRows[0]?.count ?? 0) === 0) {
    reasons.push("empty-index");
    suggestions.push({ kind: "ingest", message: "No indexed content. Upload and index documents for this project." });
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
    insert into search_zero_results (id, session_id, user_id, project_id, reason, suggestions)
    values (${randomUUID()}, ${args.sessionId}, ${args.userId}, ${args.projectId}, ${reasons.join("|") || "unknown"}, ${sql.json(suggestions)})
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
