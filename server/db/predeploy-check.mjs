#!/usr/bin/env node
// Read-only pre-deploy report for the 0121-0127 release (docs/rollout-0121-0127.md):
//
//   DATABASE_URL=... node server/db/predeploy-check.mjs [--strict] [--json]
//
// Everything runs in one READ ONLY transaction with a statement timeout; it changes nothing. It measures what the
// migrations and the new code will meet in this database and prints what to fix or watch first:
//   1. migrations still pending, and transactions old enough to make a migration lock wait time out;
//   2. document_chunks rows and size, and the state of the folded keyword index (how long its CONCURRENTLY build will take);
//   3. api_keys and webhooks 0125 deletes or homes, and the memberships 0127 removes (one organization per user);
//   4. stored pipelines whose piiPolicy.patterns name a detector this build no longer accepts;
//   5. recorded stage artifacts that are empty, which the fail-closed readers refuse (object-store existence is not checkable from SQL);
//   6. runs in flight, by the routing version they are pinned to.
// Exit code: 0 for a report, 1 with --strict when a BLOCKER is found, 2 when the check itself could not run.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { directDatabaseUrl, INDEX_NAME } from "./folded-search-index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_RUN_STATUSES = ["queued", "blocked", "processing"];
/** Measured on a laptop with ~2 KB chunks: 0.8 ms per row for the CONCURRENTLY build. Production IO differs; this is a budget, not a promise. */
const INDEX_BUILD_MS_PER_ROW = 0.8;

const gb = (bytes) => `${(Number(bytes) / 1024 ** 3).toFixed(2)} GiB`;
const minutes = (ms) => `${(ms / 60_000).toFixed(1)} min`;

/** Pure: the pending journal entries given the newest applied migration timestamp (drizzle compares `when` to created_at). */
export function pendingMigrations(journal, newestAppliedMs) {
  return (journal.entries ?? []).filter((entry) => entry.when > newestAppliedMs).map((entry) => entry.tag);
}

/** Pure: a report section is { title, level: "ok" | "warn" | "blocker", lines[] }. */
export function section(title, level, lines) {
  return { title, level, lines };
}

export function render(sections) {
  const mark = { ok: "OK     ", warn: "WARN   ", blocker: "BLOCKER" };
  return sections
    .map((s) => [`[${mark[s.level]}] ${s.title}`, ...s.lines.map((line) => `          ${line}`)].join("\n"))
    .join("\n");
}

async function columnExists(client, table, column) {
  const { rows } = await client.query(
    "select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2",
    [table, column],
  );
  return rows.length > 0;
}

async function loadAcceptedPiiPatterns() {
  // The patterns the code in this checkout accepts: shared's built enum, never a copy kept here.
  const mod = await import("@docslurp/shared");
  const options = mod.piiPatternTypeSchema?.options;
  if (!Array.isArray(options) || options.length === 0) throw new Error("@docslurp/shared does not export piiPatternTypeSchema (build it: pnpm --filter @docslurp/shared build)");
  return options;
}

export async function collectReport(client, { journal, acceptedPiiPatterns }) {
  const sections = [];
  // The report is used both before and after the breaking terminology cutover.
  // Choose from known schema names; never guess when both generations exist.
  const { rows: [schema] } = await client.query("select to_regclass('public.projects') is not null as projects, to_regclass('public.workspaces') is not null as workspaces");
  if (schema.projects && schema.workspaces) throw new Error("Ambiguous project schema; refusing the predeploy report");
  const q = async (text, params = []) => (await client.query(
    schema.projects ? text.replaceAll("workspace_runs", "project_runs").replaceAll("workspaces", "projects").replaceAll("workspace_id", "project_id") : text,
    params,
  )).rows;

  // 1. Migrations and long transactions.
  // A failed statement would abort the read-only transaction, so the table is looked up, not tried.
  const [{ has_table: hasMigrationsTable }] = await q("select to_regclass('drizzle.__drizzle_migrations') is not null as has_table");
  const [{ newest }] = hasMigrationsTable
    ? await q("select coalesce(max(created_at), 0)::bigint as newest from drizzle.__drizzle_migrations")
    : [{ newest: 0 }];
  const pending = pendingMigrations(journal, Number(newest));
  const longTx = await q(
    `select pid, state, extract(epoch from now() - xact_start)::int as seconds, left(regexp_replace(query, '\\s+', ' ', 'g'), 80) as query
     from pg_stat_activity
     where datname = current_database() and pid <> pg_backend_pid() and xact_start < now() - interval '30 seconds'
     order by xact_start limit 10`,
  );
  sections.push(section(
    `Migrations: ${pending.length} pending${pending.length ? ` (${pending[0]} .. ${pending[pending.length - 1]})` : ""}`,
    longTx.length > 0 && pending.length > 0 ? "warn" : "ok",
    longTx.length > 0
      ? [
          "Transactions open for more than 30 s. 0122, 0123, 0125 and 0127 wait at most 10 s (3 s for api_keys) for their locks, so a long reader",
          "makes the migration fail fast instead of queueing the site behind it; re-run it after these end:",
          ...longTx.map((row) => `pid ${row.pid} ${row.state} ${row.seconds}s: ${row.query}`),
        ]
      : ["No transaction older than 30 s."],
  ));

  // 2. document_chunks and the folded index.
  const [chunks] = await q(
    `select c.reltuples::bigint as rows, pg_total_relation_size(c.oid) as total_bytes, pg_relation_size(c.oid) as heap_bytes,
            pg_indexes_size(c.oid) as index_bytes
     from pg_class c where c.oid = 'public.document_chunks'::regclass`,
  );
  const [folded] = await q(
    `select i.indisvalid and i.indisready as valid, pg_relation_size(i.indexrelid) as bytes
     from pg_index i where i.indexrelid = to_regclass($1)`,
    [`public.${INDEX_NAME}`],
  );
  const legacyColumn = await columnExists(client, "document_chunks", "ts_folded");
  const analyzed = Number(chunks.rows) >= 0;
  const rows = analyzed ? Number(chunks.rows) : 0;
  const estimateMs = rows * INDEX_BUILD_MS_PER_ROW;
  const rowsLabel = analyzed ? `~${rows.toLocaleString("en-US")} rows` : "row count unknown (never analyzed; run ANALYZE document_chunks)";
  sections.push(section(
    `document_chunks: ${rowsLabel}, ${gb(chunks.total_bytes)} (heap ${gb(chunks.heap_bytes)}, indexes ${gb(chunks.index_bytes)})`,
    legacyColumn ? "blocker" : !folded ? "warn" : folded.valid ? "ok" : "warn",
    [
      legacyColumn
        ? "A stored document_chunks.ts_folded column exists (an earlier draft of 0121 ran here). Drop it and its index before deploying: the new code does not read it."
        : "0121 only defines docslurp_fold_text(); it does not touch the table.",
      folded
        ? `${INDEX_NAME}: ${folded.valid ? "valid" : "INVALID (an interrupted build; node server/db/folded-search-index.mjs drops and rebuilds it)"}, ${gb(folded.bytes)}`
        : `${INDEX_NAME}: not built. Keyword search works without it (the folded leg is cut off after SEARCH_FOLDED_UNINDEXED_TIMEOUT_MS). ` +
          `After the migration run node server/db/folded-search-index.mjs; budget ${analyzed ? `~${minutes(estimateMs)} for ${rows.toLocaleString("en-US")} rows` : `(row count unknown)`} (${INDEX_BUILD_MS_PER_ROW} ms/row measured), concurrently, without blocking reads or writes.`,
    ],
  ));

  // 3. api_keys and webhooks without an organization (0125), and memberships beyond one per user (0127). Both migrations
  // delete rows; this counts them as they will meet this database, before or after 0125 is applied.
  // A user's "only organization": exactly one membership in a live organization.
  const onlyOrg = `select om.user_id, min(om.org_id) as org_id, bool_and(om.role in ('owner', 'admin')) as administers
    from org_memberships om join organizations o on o.id = om.org_id and o.deleted_at is null
    group by om.user_id having count(*) = 1`;
  const [keys] = await q(
    `select count(*)::int as total, count(only_org.user_id)::int as homed, count(*) filter (where k.revoked_at is null)::int as live
     from api_keys k left join (${onlyOrg}) only_org on only_org.user_id = k.user_id
     where k.org_id is null`,
  );
  const keysDeleted = keys.total - keys.homed;
  sections.push(section(
    `api_keys without an organization: ${keys.total} (${keys.live} not yet revoked)`,
    keysDeleted > 0 ? "warn" : "ok",
    keys.total === 0
      ? ["None. Every key has an org_id."]
      : [
          "validateApiKey has never served these. 0125 moves a key, revoked, to its owner's only organization and deletes the rest.",
          `${keys.homed} will be homed (revoked); ${keysDeleted} will be DELETED (owner in no organization or in several).`,
        ],
  ));

  const hookHasOrg = await columnExists(client, "webhooks", "org_id");
  const [hooks] = await q(
    `select count(*)::int as total, count(only_org.user_id) filter (where only_org.administers)::int as homed
     from webhooks w left join (${onlyOrg}) only_org on only_org.user_id = w.user_id
     ${hookHasOrg ? "where w.org_id is null" : ""}`,
  );
  const hooksDeleted = hooks.total - hooks.homed;
  sections.push(section(
    `webhooks ${hookHasOrg ? "without an organization" : "to be given an organization by 0125"}: ${hooks.total}`,
    hooksDeleted > 0 ? "warn" : "ok",
    hooks.total === 0
      ? ["None."]
      : [
          `${hooks.homed} will be homed to their creator's only organization (the creator administers it).`,
          `${hooksDeleted} will be DELETED with their delivery log (creator in several organizations, in none, or only a member). Recreate them per organization after the deploy.`,
        ],
  ));

  // 0127: one organization per user (DOCSLURP_MAX_ORGS_PER_USER=1). Mirrors the migration's rules.
  const [{ has_index: oneOrgIndex }] = await q("select to_regclass('public.org_memberships_one_org_per_user') is not null as has_index");
  if (oneOrgIndex) {
    sections.push(section("Memberships beyond one per user (0127): already applied", "ok", ["org_memberships_one_org_per_user exists."]));
  } else {
    const keysOf = hookHasOrg ? "or exists (select 1 from webhooks h where h.org_id = o.id)" : "";
    const [members] = await q(
      `with multi as (select user_id from org_memberships group by user_id having count(*) > 1),
       candidates as (
         select om.org_id, om.user_id,
           case
             when o.deleted_at is not null then 'deleted_organization'
             when o.is_personal and o.personal_owner_user_id = om.user_id and o.funded_at is null
               and not exists (select 1 from workspace_runs r where r.org_id = o.id)
               and not exists (select 1 from documents d join workspaces w on w.id = d.workspace_id where w.org_id = o.id)
               and not (exists (select 1 from api_keys k where k.org_id = o.id) ${keysOf})
               then 'empty_personal_organization'
           end as reason
         from org_memberships om join organizations o on o.id = om.org_id
         where om.user_id in (select user_id from multi)
       ),
       kept as (
         select user_id, count(*) filter (where reason is null) as remaining from candidates group by user_id
       )
       select (select count(*) from multi)::int as users,
         (select count(*) from candidates where reason = 'deleted_organization')::int as deleted_org,
         (select count(*) from candidates where reason = 'empty_personal_organization')::int as empty_personal,
         (select coalesce(sum(greatest(remaining - 1, 0)), 0) from kept)::int as not_kept`,
    );
    const removed = members.deleted_org + members.empty_personal + members.not_kept;
    sections.push(section(
      `Memberships beyond one per user (0127): ${members.users} user(s), ${removed} membership(s) to remove`,
      removed > 0 ? "warn" : "ok",
      members.users === 0
        ? ["None. Every user belongs to at most one organization."]
        : [
            `${members.deleted_org} in tombstoned organizations; ${members.empty_personal} in empty personal organizations (DELETED with the organization);`,
            `${members.not_kept} more removed by the keep rule (owner/admin first, then most recent run or document). Removed memberships are copied`,
            "to org_memberships_removed_backup; the user loses access to that organization's data at once (keys and MCP grants revoked).",
          ],
    ));
  }

  // 4. Stored pipelines naming detectors the build no longer accepts.
  const badPatterns = await q(
    `select source, pattern, count(*)::int as pipelines
     from (
       select 'workspaces' as source, jsonb_array_elements_text(pipeline -> 'piiPolicy' -> 'patterns') as pattern
         from workspaces where jsonb_typeof(pipeline -> 'piiPolicy' -> 'patterns') = 'array'
       union all
       select 'upload_sessions', jsonb_array_elements_text(pipeline -> 'piiPolicy' -> 'patterns')
         from upload_sessions where jsonb_typeof(pipeline -> 'piiPolicy' -> 'patterns') = 'array'
       union all
       select 'workspace_runs (in flight)', jsonb_array_elements_text(pipeline -> 'piiPolicy' -> 'patterns')
         from workspace_runs where status = any($2::text[]) and jsonb_typeof(pipeline -> 'piiPolicy' -> 'patterns') = 'array'
     ) found
     where pattern <> all($1::text[])
     group by source, pattern order by source, pattern`,
    [acceptedPiiPatterns, ACTIVE_RUN_STATUSES],
  );
  sections.push(section(
    `Stored pipelines with PII patterns this build rejects: ${badPatterns.length}`,
    badPatterns.length > 0 ? "blocker" : "ok",
    badPatterns.length === 0
      ? [`Every stored piiPolicy.patterns entry is one of: ${acceptedPiiPatterns.join(", ")}.`]
      : [
          "The previous release accepted any string here and silently scanned for nothing; this one rejects the pipeline. Edit or remove these entries first:",
          ...badPatterns.map((row) => `${row.source}: "${row.pattern}" in ${row.pipelines} pipeline(s)`),
        ],
  ));

  // 5. Empty recorded artifacts.
  const emptyArtifacts = await q(
    `select s.stage_name, count(*)::int as states, count(distinct s.document_id)::int as documents
     from document_run_stage_states s
     join workspace_runs r on r.id = s.run_id
     where s.status = 'completed' and s.stage_name in ('extract-markdown', 'to-canonical', 'embed')
       and (s.artifact_uri is null or btrim(s.artifact_uri) = '')
       and r.status = any($1::text[])
     group by s.stage_name order by s.stage_name`,
    [ACTIVE_RUN_STATUSES],
  );
  sections.push(section(
    `Completed stage states without an artifact, in runs in flight: ${emptyArtifacts.reduce((sum, row) => sum + row.states, 0)}`,
    emptyArtifacts.length > 0 ? "warn" : "ok",
    emptyArtifacts.length === 0
      ? ["None. (Whether each recorded object still exists in storage is not checkable from SQL; ArtifactReadError in SigNoz shows it.)"]
      : [
          "The readers fail closed on a missing artifact (ArtifactReadError, retried by the stage) instead of answering from the raw source:",
          ...emptyArtifacts.map((row) => `${row.stage_name}: ${row.states} state(s) over ${row.documents} document(s)`),
        ],
  ));

  // 6. Runs in flight by pin.
  const pins = await q(
    `select coalesce(artifacts ->> 'run:vision-routing-version', '(none)') as pin, status, count(*)::int as runs
     from workspace_runs where status = any($1::text[]) group by 1, 2 order by 1, 2`,
    [ACTIVE_RUN_STATUSES],
  );
  const byPin = new Map();
  for (const row of pins) byPin.set(row.pin, (byPin.get(row.pin) ?? 0) + row.runs);
  sections.push(section(
    `Runs in flight by routing pin: ${[...byPin].map(([pin, runs]) => `${pin}=${runs}`).join(" ") || "none"}`,
    "ok",
    [
      "v3 = evidence routing (this release). v1 and (none) route with the keyword rules, as before. A v2 pin was written by the previous release's canary:",
      "this release routes it as v1 and warns ([vision-routing] ... routing as v1). Old workers treat v3 as unknown and route it as v1, never as evidence routing.",
      ...pins.map((row) => `${row.pin} ${row.status}: ${row.runs}`),
    ],
  ));
  return sections;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const journal = JSON.parse(readFileSync(path.join(here, "migrations", "meta", "_journal.json"), "utf8"));
  const acceptedPiiPatterns = await loadAcceptedPiiPatterns();
  const require = createRequire(import.meta.url);
  const { Client } = require("pg");
  const client = new Client({ connectionString: directDatabaseUrl(url) });
  await client.connect();
  try {
    await client.query("begin read only");
    await client.query("set local statement_timeout = '30s'");
    const sections = await collectReport(client, { journal, acceptedPiiPatterns });
    await client.query("rollback");
    console.log(process.argv.includes("--json") ? JSON.stringify(sections, null, 2) : render(sections));
    if (process.argv.includes("--strict") && sections.some((s) => s.level === "blocker")) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[predeploy-check] could not run: ${error?.message ?? error}`);
    process.exitCode = 2;
  });
}
