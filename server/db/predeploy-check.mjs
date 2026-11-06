#!/usr/bin/env node
// Read-only pre-deploy report for the 0121-0127 release (docs/rollout-0121-0127.md):
//
//   DATABASE_URL=... node server/db/predeploy-check.mjs [--strict] [--json] [--ack-0127=<hash>] [--redact | --no-redact]
//
// Everything runs in one READ ONLY transaction with a statement timeout; it changes nothing. It measures what the
// migrations and the new code will meet in this database and prints what to fix or watch first:
//   1. migrations still pending, and transactions old enough to make a migration lock wait time out;
//   2. documents rows and size (every documents reader waits while the migration holds its lock), document_chunks rows and
//      size, and the state of the folded keyword index (how long its CONCURRENTLY build will take);
//   3. api_keys and webhooks 0125 deletes or homes;
//   4. every user 0127 affects (one organization per user), by running the migration's own plan SQL, read from
//      0127_one_org_per_user.sql: the organization kept, those removed (funded or not), keys and grants revoked, owners
//      promoted and organizations left without a member. A removal from a funded organization or a plain member promoted to
//      owner is a BLOCKER until an owner acknowledges that exact list with --ack-0127=<hash>, and 0127 itself refuses to run
//      unless the migrator has DOCSLURP_ACK_0127=<the same hash>;
//   5. stored pipelines whose piiPolicy.patterns name a detector this build no longer accepts or whose vectorBackends name a
//      backend it no longer writes (Chroma, removed), and stored extraction configs
//      naming an extractor id this build does not know (built-in ids plus DOCSLURP_EXTRACTOR_ID_ALIASES keys);
//   6. recorded stage artifacts that are empty, which the fail-closed readers refuse (object-store existence is not checkable from SQL);
//   7. runs in flight, by the routing version they are pinned to;
//   8. the pricing-provider durable state (0131): pending, or which runtime roles could write it directly (a BLOCKER).
// Output names people and organizations by id only (no emails, no organization names) with --redact or whenever stdout is
// not a terminal (CI logs); an owner's interactive terminal gets the full list unless --redact is given.
// Exit code: 0 for a report, 1 with --strict when a BLOCKER is found, 2 when the check itself could not run.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { directDatabaseUrl, INDEX_NAME } from "./folded-search-index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ONE_ORG_MIGRATION = path.join(here, "migrations", "0127_one_org_per_user.sql");
/** Vector backends this build writes (packages/shared embedding.ts SUPPORTED_VECTOR_BACKENDS; pinned by its test). */
export const SUPPORTED_VECTOR_BACKENDS = ["lancedb", "orama", "milvus"];
/** Migrations of this release that wait a bounded time for their locks (the shared lock prelude, 0122). */
const BOUNDED_LOCK_MIGRATIONS = ["0122", "0123", "0125", "0126", "0127", "0128", "0129", "0130"];
/** Lines listed per affected-user report before the rest is summarized (--json carries the same lines). */
const MAX_LISTED = 500;
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

/** Pure: the text between `-- <name>:begin` and `-- <name>:end` in a migration, or throws. */
function between(migrationSql, name) {
  const match = new RegExp(`-- ${name}:begin\\n([\\s\\S]*?)\\n-- ${name}:end`).exec(migrationSql);
  if (!match) throw new Error(`0127_one_org_per_user.sql has no ${name} markers`);
  return match[1];
}

/**
 * Pure: 0127's plan and promotion queries, read from the migration so the report and the migration cannot drift. The plan
 * calls docslurp_personal_org_is_empty(), which 0127 itself (re)defines, so the function's body from the same file is
 * inlined. Before 0125 webhooks have no org_id: 0125 deletes every webhook of a user with several memberships, and those are
 * the only users rule 2 applies to, so "no webhooks" holds for every personal organization the rule examines.
 */
export function oneOrgPlanSql(migrationSql, { webhooksHaveOrg = true } = {}) {
  const fn = /FUNCTION docslurp_personal_org_is_empty\(p_org_id text\)[^$]*\$\$([\s\S]*?)\$\$/.exec(migrationSql);
  if (!fn) throw new Error("0127_one_org_per_user.sql does not define docslurp_personal_org_is_empty");
  let body = fn[1].replace(/\bp_org_id\b/g, "candidate.id");
  if (!webhooksHaveOrg) {
    const webhookRule = "NOT EXISTS (SELECT 1 FROM webhooks h WHERE h.org_id = o.id)";
    if (!body.includes(webhookRule)) throw new Error("docslurp_personal_org_is_empty no longer has the expected webhook rule");
    body = body.replace(webhookRule, "true");
  }
  const call = "docslurp_personal_org_is_empty(candidate.id)";
  const plan = between(migrationSql, "one-org-plan");
  if (!plan.includes(call)) throw new Error(`the 0127 plan no longer calls ${call}`);
  return { plan: plan.replace(call, `(${body})`), promotions: between(migrationSql, "one-org-promotions"), ownerless: between(migrationSql, "one-org-ownerless"), ack: between(migrationSql, "one-org-ack") };
}

/**
 * Pure: how a person or organization is named in the report. Redacted (CI logs, any non-interactive run, --redact) it is
 * the opaque id only, never an email or an organization name; the full report is for the owner's terminal.
 */
export function namer(redact) {
  return {
    user: (row) => (redact ? `user ${row.user_id}` : `${row.email} (${row.user_id})`),
    org: (id, name) => (redact ? id : `"${name}" (${id})`),
  };
}

/** Pure: the extractor ids this build knows: built-in ids plus the keys of DOCSLURP_EXTRACTOR_ID_ALIASES (`<old>:<new>,...`). */
export function knownExtractorIds(builtInIds, env = process.env) {
  const aliases = (env.DOCSLURP_EXTRACTOR_ID_ALIASES ?? "").split(",").map((entry) => entry.split(":")[0]?.trim()).filter(Boolean);
  return [...new Set([...builtInIds, ...aliases])];
}

async function loadBuiltInExtractorIds() {
  const mod = await import("@docslurp/shared");
  const ids = mod.builtInDocumentExtractorDescriptors?.map((entry) => entry.id);
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("@docslurp/shared does not export builtInDocumentExtractorDescriptors (build it: pnpm --filter @docslurp/shared build)");
  // Retired ids are known too: parsing drops them (extractor-aliases.ts), so a stored mention is not a rollout problem.
  return [...ids, ...(mod.RETIRED_EXTRACTOR_IDS ?? [])];
}

async function loadAcceptedPiiPatterns() {
  // The patterns the code in this checkout accepts: shared's built enum, never a copy kept here.
  const mod = await import("@docslurp/shared");
  const options = mod.piiPatternTypeSchema?.options;
  if (!Array.isArray(options) || options.length === 0) throw new Error("@docslurp/shared does not export piiPatternTypeSchema (build it: pnpm --filter @docslurp/shared build)");
  return options;
}

async function oneOrgSection(q, { plan, promotions, ownerless: ownerlessSql, ack }, ack0127, redact) {
  const name = namer(redact);
  const removed = await q(
    `with removed_memberships as (${plan})
     select gone.user_id, coalesce(u.email, '(no user row)') as email, gone.org_id, o.name as org_name, o.is_personal, gone.reason, om.role,
       (o.funded_at is not null or coalesce(o.auto_recharge_enabled, false)) as funded,
       (select count(*) from api_keys k where k.org_id = gone.org_id and k.user_id = gone.user_id and k.revoked_at is null)::int as keys,
       (select count(*) from mcp_oauth_grants g where g.org_id = gone.org_id and g.user_id = gone.user_id and g.revoked_at is null)::int as grants,
       (select count(*) from workspaces w where w.org_id = gone.org_id and w.user_id = gone.user_id)::int as workspaces,
       (select count(*) from org_memberships rest where rest.org_id = gone.org_id
          and not exists (select 1 from removed_memberships g2 where g2.org_id = rest.org_id and g2.user_id = rest.user_id))::int as members_left,
       (select count(*) from org_memberships rest where rest.org_id = gone.org_id and rest.role = 'owner'
          and not exists (select 1 from removed_memberships g2 where g2.org_id = rest.org_id and g2.user_id = rest.user_id))::int as owners_left,
       kept.org_id as kept_org_id, kept.name as kept_org_name
     from removed_memberships gone
     join org_memberships om on om.org_id = gone.org_id and om.user_id = gone.user_id
     join organizations o on o.id = gone.org_id
     left join "user" u on u.id = gone.user_id
     left join lateral (
       -- The membership the user keeps: not removed, and not in an organization rule 2 deletes.
       select rest.org_id, ko.name from org_memberships rest join organizations ko on ko.id = rest.org_id
       where rest.user_id = gone.user_id
         and not exists (select 1 from removed_memberships g2 where g2.org_id = rest.org_id and g2.user_id = rest.user_id)
         and not exists (select 1 from removed_memberships g3 where g3.org_id = rest.org_id and g3.reason = 'empty_personal_organization')
       order by rest.org_id
       limit 1
     ) kept on true
     order by gone.user_id, gone.org_id`,
  );
  const promoted = await q(
    `with removed_memberships as (${plan}), owner_promotions as (${promotions})
     select p.org_id, o.name as org_name, p.user_id, coalesce(u.email, '(no user row)') as email, p.previous_role
     from owner_promotions p join organizations o on o.id = p.org_id left join "user" u on u.id = p.user_id
     order by p.org_id`,
  );
  // The acknowledgement the migration itself demands: its own SQL, so the hash printed here is the one it compares.
  const [needed] = await q(`with removed_memberships as (${plan}), owner_promotions as (${promotions}) ${ack}`);
  // Organizations the migration refuses to leave with members but no owner (it aborts while any exists).
  const unownable = await q(
    `with removed_memberships as (${plan}), owner_promotions as (${promotions}), ownerless as (${ownerlessSql})
     select x.org_id, x.is_personal, x.members_left, o.name as org_name from ownerless x join organizations o on o.id = x.org_id order by x.org_id`,
  );
  const users = new Map();
  const promotedOrgIds = new Set(promoted.map((row) => row.org_id));
  for (const row of removed) {
    const entry = users.get(row.user_id) ?? { label: name.user(row), kept: row.kept_org_id ? name.org(row.kept_org_id, row.kept_org_name) : "NO organization (personal one provisioned at next sign-in)", removed: [] };
    const handled = row.workspaces === 0 ? null
      // 0127 hands them to the organization's longest-standing remaining owner, the promoted one included; without one they stay put.
      : row.reason === "not_kept" ? (row.owners_left > 0 || promotedOrgIds.has(row.org_id) ? `${row.workspaces} workspace(s) handed over` : `${row.workspaces} workspace(s) left with no owner to hand them to`)
      : row.reason === "empty_personal_organization" ? `${row.workspaces} empty workspace(s) deleted`
      : null;
    const facts = [row.reason, row.role, row.funded ? "FUNDED" : null, `${row.keys} key(s)`, `${row.grants} grant(s)`, handled];
    entry.removed.push(redact ? `${row.org_id} (${facts.filter(Boolean).join(", ")})` : `"${row.org_name}" (${row.org_id}, ${facts.filter(Boolean).join(", ")})`);
    users.set(row.user_id, entry);
  }
  const promotedOrgs = new Set(promoted.map((row) => row.org_id));
  const live = removed.filter((row) => row.reason === "not_kept");
  const memberless = [...new Map(live.filter((row) => row.members_left === 0).map((row) => [row.org_id, row])).values()];
  const funded = live.filter((row) => row.funded);
  const memberPromotions = promoted.filter((row) => row.previous_role === "member");
  const hash = needed?.hash ?? null;
  if (hash && (needed.funded_removals !== funded.length || needed.promotions !== promoted.length || needed.member_promotions !== memberPromotions.length)) {
    throw new Error(`0127 acknowledgement list (${needed.funded_removals} funded removal(s), ${needed.promotions} promotion(s), ${needed.member_promotions} of members) disagrees with the report (${funded.length}, ${promoted.length}, ${memberPromotions.length})`);
  }
  const acknowledged = hash !== null && ack0127 === hash;
  const count = (reason) => removed.filter((row) => row.reason === reason).length;
  const userLines = [...users.values()].map((entry) => `${entry.label}: keeps ${entry.kept}; removed from ${entry.removed.join("; ")}`);
  const listed = userLines.length > MAX_LISTED ? [...userLines.slice(0, MAX_LISTED), `... and ${userLines.length - MAX_LISTED} more user(s)`] : userLines;
  return section(
    `Memberships beyond one per user (0127): ${users.size} user(s), ${removed.length} membership(s) to remove`,
    unownable.length > 0 || (hash && !acknowledged) ? "blocker" : removed.length > 0 || promoted.length > 0 ? "warn" : "ok",
    removed.length === 0 && promoted.length === 0 && unownable.length === 0
      ? ["None. Every user belongs to at most one live organization."]
      : [
          `${count("deleted_organization")} in tombstoned organizations; ${count("empty_personal_organization")} in empty personal organizations (DELETED with the organization and its empty workspaces, backed up to organizations_removed_backup);`,
          `${count("not_kept")} more removed by the keep rule (team before personal, then most recent run or document, then role, then oldest membership).`,
          "Removed memberships are copied to org_memberships_removed_backup; the user loses access at once (keys and MCP grants revoked).",
          funded.length === 0
            ? "No user is removed from a funded organization."
            : `${funded.length} removal(s) from a FUNDED organization (paid balance or auto top-up): ${funded.map((row) => `${name.user(row)} from ${row.org_id}`).join(", ")}.`,
          ...(unownable.length === 0 ? [] : [`0127 WILL ABORT: ${unownable.length} organization(s) would keep members but no owner and cannot be given one (personal organizations are never handed to another user): ${unownable.map((row) => `${name.org(row.org_id, row.org_name)} (${row.members_left} member(s) left)`).join(", ")}. Resolve each (restore its owner, or remove or move the other members) and re-run this check.`]),
          ...(promoted.length === 0 ? [] : [`${promoted.length} promotion(s) to OWNER, each in the acknowledgement: ${promoted.map((row) => `${name.user(row)} in ${row.org_id} (was ${row.previous_role})`).join(", ")}.`]),
          ...(memberPromotions.length === 0 ? [] : [`${memberPromotions.length} plain member(s) promoted to OWNER: ${memberPromotions.map((row) => `${name.user(row)} in ${row.org_id}`).join(", ")}.`]),
          ...(hash === null
            ? []
            : [acknowledged
                ? `Acknowledged with --ack-0127=${hash}; run the migrator with DOCSLURP_ACK_0127=${hash}.`
                : `BLOCKER until an owner reviews the funded removals and promotions above and re-runs with --ack-0127=${hash}; 0127 itself refuses to run unless the migrator has DOCSLURP_ACK_0127=${hash} (the hash changes when the list does).`]),
          ...(promoted.length === 0 ? [] : [`Owner promoted (the last owner is removed and members remain): ${promoted.map((row) => `${row.org_id} -> ${name.user(row)} (was ${row.previous_role})`).join(", ")}.`]),
          ...(memberless.length === 0 ? [] : [`Left with NO member (data kept, nobody can reach it until an operator restores a membership from the backup): ${memberless.map((row) => name.org(row.org_id, row.org_name)).join(", ")}.`]),
          ...listed,
        ],
  );
}

export async function collectReport(client, { journal, acceptedPiiPatterns, extractorIds, oneOrgMigrationSql, ack0127 = null, redact = false }) {
  oneOrgMigrationSql ??= readFileSync(ONE_ORG_MIGRATION, "utf8");
  extractorIds ??= knownExtractorIds(await loadBuiltInExtractorIds());
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
          `Transactions open for more than 30 s. ${BOUNDED_LOCK_MIGRATIONS.slice(0, -1).join(", ")} and ${BOUNDED_LOCK_MIGRATIONS.at(-1)} wait at most 10 s (3 s for api_keys) for their locks, so a long reader`,
          "makes the migration fail fast instead of queueing the site behind it; re-run it after these end:",
          ...longTx.map((row) => `pid ${row.pid} ${row.state} ${row.seconds}s${redact ? "" : `: ${row.query}`}`),
        ]
      : ["No transaction older than 30 s."],
  ));

  // 2. documents, document_chunks and the folded index.
  const [docs] = await q(
    `select c.reltuples::bigint as rows, pg_total_relation_size(c.oid) as total_bytes, pg_relation_size(c.oid) as heap_bytes,
            pg_indexes_size(c.oid) as index_bytes
     from pg_class c where c.oid = 'public.documents'::regclass`,
  );
  const docRows = Number(docs.rows);
  sections.push(section(
    `documents: ${docRows >= 0 ? `~${docRows.toLocaleString("en-US")} rows` : "row count unknown (never analyzed; run ANALYZE documents)"}, ${gb(docs.total_bytes)} (heap ${gb(docs.heap_bytes)}, indexes ${gb(docs.index_bytes)})`,
    "ok",
    [
      "The migration holds ACCESS EXCLUSIVE on documents from its first statement to its commit (lock prelude, 0122): every documents",
      "reader waits for the whole migration. Nothing scans or rewrites documents under that lock (0122 and 0126 change the catalog only);",
      "0127 reads it only for the organizations of users with several memberships.",
    ],
  ));
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

  // 0127: one organization per user (DOCSLURP_MAX_ORGS_PER_USER=1), from the migration's own plan SQL.
  const [{ has_index: oneOrgIndex }] = await q("select to_regclass('public.org_memberships_one_org_per_user') is not null as has_index");
  if (oneOrgIndex) {
    sections.push(section("Memberships beyond one per user (0127): already applied", "ok", ["org_memberships_one_org_per_user exists."]));
  } else {
    sections.push(await oneOrgSection(q, oneOrgPlanSql(oneOrgMigrationSql, { webhooksHaveOrg: hookHasOrg }), ack0127, redact));
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

  // 4c. Stored pipelines naming a vector backend this build no longer writes (Chroma was removed): they are refused at parse,
  // never rerouted to another backend.
  const badBackends = await q(
    `select source, backend, count(*)::int as pipelines from (
       select 'workspaces' as source, jsonb_array_elements_text(pipeline -> 'vectorBackends') as backend
         from workspaces where jsonb_typeof(pipeline -> 'vectorBackends') = 'array'
       union all
       select 'upload_sessions', jsonb_array_elements_text(pipeline -> 'vectorBackends')
         from upload_sessions where jsonb_typeof(pipeline -> 'vectorBackends') = 'array'
       union all
       select 'workspace_runs (in flight)', jsonb_array_elements_text(pipeline -> 'vectorBackends')
         from workspace_runs where status = any($2::text[]) and jsonb_typeof(pipeline -> 'vectorBackends') = 'array'
     ) found
     where lower(btrim(backend)) <> all($1::text[])
     group by source, backend order by source, backend`,
    [[...SUPPORTED_VECTOR_BACKENDS], ACTIVE_RUN_STATUSES],
  );
  sections.push(section(
    `Stored pipelines naming a vector backend this build does not write: ${badBackends.length}`,
    badBackends.length > 0 ? "blocker" : "ok",
    badBackends.length === 0
      ? [`Every stored vectorBackends entry is one of: ${SUPPORTED_VECTOR_BACKENDS.join(", ")}.`]
      : [
          "This build refuses these pipelines (unsupported vector backend; Chroma was removed) instead of writing elsewhere. Edit them to a supported backend first:",
          ...badBackends.map((row) => `${row.source}: "${String(row.backend).slice(0, 64)}" in ${row.pipelines} pipeline(s)`),
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

  // 5b. Stored extraction configs naming an extractor id this build does not know.
  const unknownExtractors = await q(
    `with configs as (
       select 'workspaces' as source, pipeline -> 'documentExtraction' as x from workspaces where jsonb_typeof(pipeline -> 'documentExtraction') = 'object'
       union all
       select 'upload_sessions', pipeline -> 'documentExtraction' from upload_sessions where jsonb_typeof(pipeline -> 'documentExtraction') = 'object'
       union all
       select 'workspace_runs (in flight)', pipeline -> 'documentExtraction' from workspace_runs
         where status = any($2::text[]) and jsonb_typeof(pipeline -> 'documentExtraction') = 'object'
     ),
     lists as (
       select source, value as list from configs, jsonb_each(case when jsonb_typeof(x -> 'order') = 'object' then x -> 'order' else '{}' end)
       union all
       select source, value from configs, jsonb_each(case when jsonb_typeof(x -> 'components') = 'object' then x -> 'components' else '{}' end)
       union all
       select source, x -> 'pages' from configs
       union all
       select source, x -> 'enrich' from configs
     ),
     ids as (
       select source, id from lists, jsonb_array_elements_text(case when jsonb_typeof(list) = 'array' then list else '[]' end) as id
       union all
       select source, x -> 'voting' ->> 'secondary' from configs
         where jsonb_typeof(x -> 'voting' -> 'secondary') = 'string' and x -> 'voting' ->> 'secondary' <> 'next-in-order'
       union all
       select source, key from configs, jsonb_object_keys(case when jsonb_typeof(x -> 'options') = 'object' then x -> 'options' else '{}' end) as key
     )
     select source, left(id, 64) as id, count(*)::int as mentions from ids where id <> all($1::text[])
     group by 1, 2 order by 1, 2`,
    [extractorIds, ACTIVE_RUN_STATUSES],
  );
  sections.push(section(
    `Stored extraction configs naming an extractor id this build does not know: ${unknownExtractors.reduce((sum, row) => sum + row.mentions, 0)}`,
    unknownExtractors.length > 0 ? "warn" : "ok",
    unknownExtractors.length === 0
      ? ["Every documentExtraction id is a built-in id or a DOCSLURP_EXTRACTOR_ID_ALIASES key of this environment."]
      : [
          "Compared with this build's built-in ids and the DOCSLURP_EXTRACTOR_ID_ALIASES keys set where this check runs (set it as on the",
          "API and worker). A plugin-served id is listed too. Unknown ids fail validation: alias them or edit these configs first.",
          ...unknownExtractors.map((row) => `${row.source}: "${row.id}" (${row.mentions} mention(s))`),
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
  const inFlight = [...byPin.values()].reduce((sum, runs) => sum + runs, 0);
  sections.push(section(
    `Runs in flight: ${inFlight}${inFlight ? ` (by routing pin: ${[...byPin].map(([pin, runs]) => `${pin}=${runs}`).join(" ")})` : ""}`,
    "ok",
    [
      `${inFlight} run(s) queued, blocked or processing. They continue across the deploy (old workers finish theirs; new workers pick up the rest).`,
      "v3 = evidence routing (this release). v1 and (none) route with the keyword rules, as before. A v2 pin was written by the previous release's canary:",
      "this release routes it as v1 and warns ([vision-routing] ... routing as v1). Old workers treat v3 as unknown and route it as v1, never as evidence routing.",
      ...pins.map((row) => `${row.pin} ${row.status}: ${row.runs}`),
    ],
  ));

  // 7. Pricing-provider durable state (0131): a new table and function, no lock on existing tables. Once present, no runtime
  // role may write it directly (it only rises through pricing_state_raise); a direct write grant is a BLOCKER.
  const [{ has_state: hasState }] = await q("select to_regclass('public.pricing_provider_state') is not null as has_state");
  if (!hasState) {
    sections.push(section("Pricing-provider state (0131): pending", "ok", [
      "0131 creates pricing_provider_state and pricing_state_raise(key, candidate) (SECURITY DEFINER). It locks no existing table.",
      "API, worker and chat-executor roles get SELECT and EXECUTE only; the pricing provider reads and raises its keys through them.",
    ]));
  } else {
    const writers = await q(
      `select r.rolname as role, array_remove(array[
         case when has_table_privilege(r.oid, 'public.pricing_provider_state', 'INSERT') then 'insert' end,
         case when has_table_privilege(r.oid, 'public.pricing_provider_state', 'UPDATE') then 'update' end,
         case when has_table_privilege(r.oid, 'public.pricing_provider_state', 'DELETE') then 'delete' end,
         case when has_table_privilege(r.oid, 'public.pricing_provider_state', 'TRUNCATE') then 'truncate' end], null) as privileges
       from pg_roles r where r.rolname = any($1::text[])`,
      [["docslurp_app", "docslurp_worker", "docslurp_backup"]],
    );
    const direct = writers.filter((row) => row.privileges.length > 0);
    const [{ keys }] = await q("select count(*)::int as keys from pricing_provider_state");
    sections.push(section(
      `Pricing-provider state (0131): ${keys} key(s)`,
      direct.length ? "blocker" : "ok",
      direct.length
        ? ["Runtime roles can write pricing_provider_state directly (it must only rise through pricing_state_raise); run the role reconciliation (migrate.mjs):",
          ...direct.map((row) => `${row.role}: ${row.privileges.join(", ")}`)]
        : ["No runtime role writes the table directly; values rise only through pricing_state_raise."],
    ));
  }
  return sections;
}

/** Pure: redact unless asked not to (--no-redact) on an interactive terminal; --redact always redacts (CI passes it). */
export function redactOutput(argv, isTTY) {
  if (argv.includes("--redact")) return true;
  if (argv.includes("--no-redact")) return false;
  return !isTTY;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const journal = JSON.parse(readFileSync(path.join(here, "migrations", "meta", "_journal.json"), "utf8"));
  const acceptedPiiPatterns = await loadAcceptedPiiPatterns();
  const extractorIds = knownExtractorIds(await loadBuiltInExtractorIds());
  const ack0127 = process.argv.find((arg) => arg.startsWith("--ack-0127="))?.slice("--ack-0127=".length) ?? null;
  const redact = redactOutput(process.argv, process.stdout.isTTY);
  const require = createRequire(import.meta.url);
  const { Client } = require("pg");
  const client = new Client({ connectionString: directDatabaseUrl(url) });
  await client.connect();
  try {
    await client.query("begin read only");
    await client.query("set local statement_timeout = '30s'");
    const sections = await collectReport(client, { journal, acceptedPiiPatterns, extractorIds, ack0127, redact });
    if (redact) console.error("[predeploy-check] redacted output (ids only, no emails or organization names); run with --no-redact in an owner's terminal for the full list");
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
