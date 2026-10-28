import { Hono } from "hono";
import { z } from "zod";

import { sql } from "../db.js";
import { apiStatusError } from "../lib/api-error.js";
import { getRequestActor } from "../lib/request-actor.js";
import { CLIENT_SURFACES } from "../services/client-surface.js";
import { userUsageTotals } from "../services/usage-attribution.js";

/**
 * Platform-admin user directory: every account across every organization,
 * with auth status, activation and client-surface signals. Cross-tenant by
 * design, so it is reachable only from a platform-admin browser session
 * (ADMIN_EMAILS); API keys and OAuth tokens are refused even for an admin.
 * Never exposes credentials, token material, IPs or session user agents.
 */
export const adminUsersRoutes = new Hono();

adminUsersRoutes.use("*", async (c, next) => {
  const actor = getRequestActor(c);
  if (actor.type !== "session" || actor.user.isAdmin !== true) return apiStatusError(c, 403, "Platform administrator required");
  c.header("Cache-Control", "private, no-store");
  await next();
});

const SORTS = ["newest", "oldest", "last_active", "documents", "searches"] as const;
const FILTERS = ["all", "verified", "unverified", "google", "github", "password", "uploaded", "never_uploaded", "searched", "api_key", "deleted"] as const;

export const adminUsersQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  filter: z.enum(FILTERS).default("all"),
  surface: z.enum(CLIENT_SURFACES).optional(),
  sort: z.enum(SORTS).default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();

type UserRow = {
  id: string; email: string; name: string;
  created_at: string; deleted_at: string | null; email_verified: boolean; two_factor_enabled: boolean;
  providers: string[]; passkeys: number;
  org_id: string | null; org_name: string | null; credit_balance_cents: number | null; org_count: number;
  last_active_at: string | null; active_sessions: number;
  workspaces: number; documents: number; pages: number; last_upload_at: string | null; upload_sessions: number;
  searches: number; last_search_at: string | null; chat_sessions: number;
  api_keys: number; browser_keys: number; api_key_last_used_at: string | null;
  surfaces: { surface: string; client: string | null; first_seen_at: string; last_seen_at: string; requests: number }[];
  attribution: Record<string, string | null> | null;
  total: number;
};

function filterClause(filter: typeof FILTERS[number]) {
  switch (filter) {
    case "verified": return sql`and u."emailVerified"`;
    case "unverified": return sql`and not u."emailVerified"`;
    case "google": return sql`and exists (select 1 from account a where a."userId" = u.id and a."providerId" = 'google')`;
    case "github": return sql`and exists (select 1 from account a where a."userId" = u.id and a."providerId" = 'github')`;
    case "password": return sql`and exists (select 1 from account a where a."userId" = u.id and a."providerId" = 'credential')`;
    case "uploaded": return sql`and exists (select 1 from documents d where d.user_id = u.id)`;
    case "never_uploaded": return sql`and not exists (select 1 from documents d where d.user_id = u.id)`;
    case "searched": return sql`and (exists (select 1 from search_sessions s where s.user_id = u.id) or exists (select 1 from chat_sessions cs where cs.user_id = u.id))`;
    case "api_key": return sql`and exists (select 1 from api_keys k where k.user_id = u.id and k.revoked_at is null)`;
    case "deleted": return sql`and u.deleted_at is not null`;
    default: return sql``;
  }
}

function sortClause(sort: typeof SORTS[number]) {
  switch (sort) {
    case "oldest": return sql`u."createdAt" asc, u.id`;
    case "last_active": return sql`last_active_at desc nulls last, u.id`;
    case "documents": return sql`documents desc, u."createdAt" desc, u.id`;
    case "searches": return sql`searches desc, u."createdAt" desc, u.id`;
    default: return sql`u."createdAt" desc, u.id`;
  }
}

adminUsersRoutes.get("/", async (c) => {
  const parsed = adminUsersQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return apiStatusError(c, 400, "Invalid user query");
  const { q, filter, surface, sort, limit, offset } = parsed.data;
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await sql<UserRow[]>`
    select u.id, u.email, u.name, u."createdAt" as created_at, u.deleted_at,
      u."emailVerified" as email_verified, u."twoFactorEnabled" as two_factor_enabled,
      coalesce((select array_agg(distinct a."providerId" order by a."providerId") from account a where a."userId" = u.id), '{}') as providers,
      (select count(*)::int from passkey p where p."userId" = u.id) as passkeys,
      po.id as org_id, po.name as org_name, po.credit_balance_cents::double precision as credit_balance_cents,
      (select count(*)::int from org_memberships m where m.user_id = u.id) as org_count,
      sess.last_active_at, sess.active_sessions,
      (select count(*)::int from workspaces w where w.user_id = u.id) as workspaces,
      docs.documents, docs.pages, docs.last_upload_at,
      (select count(*)::int from upload_sessions us where us.user_id = u.id) as upload_sessions,
      srch.searches, srch.last_search_at,
      (select count(*)::int from chat_sessions cs where cs.user_id = u.id) as chat_sessions,
      keys.api_keys, keys.browser_keys, keys.api_key_last_used_at,
      coalesce((select json_agg(json_build_object('surface', s.surface, 'client', s.last_client, 'first_seen_at', s.first_seen_at,
        'last_seen_at', s.last_seen_at, 'requests', s.request_count) order by s.last_seen_at desc)
        from user_client_surfaces s where s.user_id = u.id), '[]'::json) as surfaces,
      (select json_build_object('referrer_host', sa.referrer_host, 'referrer_url', sa.referrer_url, 'landing_path', sa.landing_path,
        'utm_source', sa.utm_source, 'utm_medium', sa.utm_medium, 'utm_campaign', sa.utm_campaign, 'utm_term', sa.utm_term,
        'utm_content', sa.utm_content, 'first_seen_at', sa.first_seen_at)
        from user_signup_attribution sa where sa.user_id = u.id) as attribution,
      count(*) over ()::int as total
    from "user" u
    left join organizations po on po.personal_owner_user_id = u.id
    left join lateral (
      select max(se."updatedAt") as last_active_at, count(*) filter (where se."expiresAt" > now())::int as active_sessions
      from session se where se."userId" = u.id
    ) sess on true
    left join lateral (
      select count(*)::int as documents, coalesce(sum(d.page_count), 0)::int as pages, max(d.created_at) as last_upload_at
      from documents d where d.user_id = u.id
    ) docs on true
    left join lateral (
      select count(*)::int as searches, max(s.created_at) as last_search_at from search_sessions s where s.user_id = u.id
    ) srch on true
    left join lateral (
      select count(*) filter (where k.key_type <> 'client')::int as api_keys,
        count(*) filter (where k.key_type = 'client')::int as browser_keys,
        max(k.last_used_at) as api_key_last_used_at
      from api_keys k where k.user_id = u.id and k.revoked_at is null
    ) keys on true
    where (${q} = '' or u.email ilike ${like} or u.name ilike ${like} or u.id = ${q})
      ${filter === "deleted" ? sql`` : sql`and u.deleted_at is null`}
      ${filterClause(filter)}
      ${surface ? sql`and exists (select 1 from user_client_surfaces s where s.user_id = u.id and s.surface = ${surface})` : sql``}
    order by ${sortClause(sort)}
    limit ${limit} offset ${offset}`;
  const usage = await userUsageTotals(rows.map(row => row.id), null);
  return c.json({
    total: rows[0]?.total ?? 0,
    limit, offset,
    users: rows.map(({ total: _total, ...row }) => {
      const spend = usage.get(row.id);
      return { ...row, spend_cents: spend?.costCents ?? 0, ai_tokens: spend?.tokens ?? 0 };
    }),
  });
});

adminUsersRoutes.get("/summary", async (c) => {
  const days = z.coerce.number().int().min(7).max(365).catch(30).parse(c.req.query("days") ?? 30);
  const [totals] = await sql<Record<string, number>[]>`
    select
      count(*)::int as users,
      count(*) filter (where u."createdAt" >= now() - interval '1 day')::int as signups_24h,
      count(*) filter (where u."createdAt" >= now() - interval '7 days')::int as signups_7d,
      count(*) filter (where u."createdAt" >= now() - interval '30 days')::int as signups_30d,
      count(*) filter (where u."emailVerified")::int as verified,
      count(*) filter (where u."twoFactorEnabled")::int as two_factor,
      count(*) filter (where exists (select 1 from account a where a."userId" = u.id and a."providerId" = 'google'))::int as google,
      count(*) filter (where exists (select 1 from account a where a."userId" = u.id and a."providerId" = 'github'))::int as github,
      count(*) filter (where exists (select 1 from account a where a."userId" = u.id and a."providerId" = 'credential'))::int as password,
      count(*) filter (where exists (select 1 from documents d where d.user_id = u.id))::int as uploaded,
      count(*) filter (where exists (select 1 from search_sessions s where s.user_id = u.id)
        or exists (select 1 from chat_sessions cs where cs.user_id = u.id))::int as searched,
      count(*) filter (where exists (select 1 from api_keys k where k.user_id = u.id and k.revoked_at is null))::int as api_key,
      count(*) filter (where exists (select 1 from user_client_surfaces s where s.user_id = u.id and s.surface in ('sdk', 'cli', 'mcp', 'mcp_stdio', 'api', 'openai_compat', 'search_compat')))::int as programmatic,
      count(*) filter (where exists (select 1 from session se where se."userId" = u.id and se."updatedAt" >= now() - interval '7 days'))::int as active_7d
    from "user" u where u.deleted_at is null`;
  const signupsByDay = await sql<{ day: string; signups: number; verified: number }[]>`
    select to_char(d.day, 'YYYY-MM-DD') as day,
      count(u.id)::int as signups, count(u.id) filter (where u."emailVerified")::int as verified
    from generate_series(date_trunc('day', now()) - make_interval(days => ${days - 1}), date_trunc('day', now()), interval '1 day') as d(day)
    left join "user" u on date_trunc('day', u."createdAt") = d.day and u.deleted_at is null
    group by d.day order by d.day`;
  const surfaces = await sql<{ surface: string; users: number; requests: number; active_7d: number }[]>`
    select s.surface, count(distinct s.user_id)::int as users, coalesce(sum(s.request_count), 0)::double precision as requests,
      count(distinct s.user_id) filter (where s.last_seen_at >= now() - interval '7 days')::int as active_7d
    from user_client_surfaces s join "user" u on u.id = s.user_id and u.deleted_at is null
    group by s.surface order by users desc`;
  const referrers = await sql<{ source: string; users: number }[]>`
    select coalesce(sa.utm_source, sa.referrer_host, '(direct)') as source, count(*)::int as users
    from "user" u left join user_signup_attribution sa on sa.user_id = u.id
    where u.deleted_at is null
    group by 1 order by users desc, source limit 15`;
  return c.json({ days, totals, signupsByDay, surfaces, referrers });
});
