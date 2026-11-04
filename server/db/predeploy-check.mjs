#!/usr/bin/env node
// Read-only pre-deploy report for the 0121-0125 rollout (docs/rollout-expand-contract-0121-0125.md):
//
//   DATABASE_URL=... node server/db/predeploy-check.mjs [--strict] [--json]
//
// Everything runs in one READ ONLY transaction with a statement timeout; it changes nothing. It measures what the
// migrations and the new code will meet in this database and prints what to fix or watch first:
//   1. migrations still pending, and transactions old enough to make a migration lock wait time out;
//   2. document_chunks rows and size, and the state of the folded keyword index (how long its CONCURRENTLY build will take);
//   3. api_keys and webhooks without an organization, with the organizations their owners could be homed to;
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
  const q = async (text, params = []) => (await client.query(text, params)).rows;

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
          "Transactions open for more than 30 s. 0122, 0123 and 0125 wait at most 10 s (3 s for api_keys) for their locks, so a long reader",
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

  // 3. api_keys and webhooks without an organization.
  const keyHasOrg = await columnExists(client, "api_keys", "org_id");
  const keys = keyHasOrg
    ? await q(
        `select k.id, k.user_id, k.revoked_at is not null as revoked, p.id as personal_org
         from api_keys k left join organizations p on p.is_personal and p.personal_owner_user_id = k.user_id
         where k.org_id is null order by k.created_at limit 200`,
      )
    : [];
  const liveKeys = keys.filter((key) => !key.revoked);
  sections.push(section(
    `api_keys without an organization: ${keys.length} (${liveKeys.length} not yet revoked)`,
    liveKeys.length > 0 ? "warn" : "ok",
    keys.length === 0
      ? ["None. Every key has an org_id."]
      : [
          "validateApiKey has never served these. 0125 revokes them (fail closed) and re-homes only to the owner's personal organization; nothing is deleted.",
          `${keys.filter((key) => key.personal_org).length} have an owner with a personal organization; ${keys.filter((key) => !key.personal_org).length} stay unhomed (revoked) until the contract step deletes them.`,
        ],
  ));

  const hookHasOrg = await columnExists(client, "webhooks", "org_id");
  const hooks = await q(
    `select w.id, w.user_id, ${hookHasOrg ? "w.org_id" : "null::text"} as org_id,
            (select count(distinct r.org_id) from workspace_runs r where r.user_id = w.user_id and r.org_id is not null) as run_orgs,
            (select p.id from organizations p where p.is_personal and p.personal_owner_user_id = w.user_id) as personal_org,
            (select count(*) from org_memberships om where om.user_id = w.user_id and om.role in ('owner', 'admin')) as admin_orgs
     from webhooks w ${hookHasOrg ? "where w.org_id is null" : ""} order by w.created_at limit 500`,
  );
  const unhomed = hooks.filter((hook) => !hook.personal_org && Number(hook.admin_orgs) === 0);
  const multiOrg = hooks.filter((hook) => Number(hook.run_orgs) > 1);
  sections.push(section(
    `webhooks ${hookHasOrg ? "without an organization" : "to be homed by 0125"}: ${hooks.length}`,
    unhomed.length > 0 || multiOrg.length > 0 ? "warn" : "ok",
    hooks.length === 0
      ? ["None."]
      : [
          `${unhomed.length} cannot be homed (no personal organization and no owned or administered one); they keep a NULL org_id, new code does not match them, and the contract step backs them up before removing them.`,
          `${multiOrg.length} belong to a user with runs in more than one organization: before this change they fired for all of that user's runs, afterwards only for the one organization they are homed to (the one their own deliveries ran in, else personal). Recreate them per organization if that matters.`,
          ...hooks.slice(0, 10).map((hook) => `webhook ${hook.id} user ${hook.user_id} runs-in-orgs=${hook.run_orgs} personal=${hook.personal_org ?? "-"} admin-orgs=${hook.admin_orgs}`),
        ],
  ));

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
