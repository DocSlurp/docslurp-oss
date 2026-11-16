import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

/**
 * Fixed ids for the seeded organization, project and queued run. They are UUIDs because every real one is
 * (`randomUUID()` at creation) and id-validating contracts, the realtime resource schema among them, reject
 * anything else. They are fixed so that seeding again updates the same rows.
 */
export const SEED_IDS = Object.freeze({
  org: "5eed0000-0000-4000-8000-000000000001",
  project: "5eed0000-0000-4000-8000-000000000002",
  queuedRun: "5eed0000-0000-4000-8000-000000000003",
});
/**
 * The ids the seed used before it switched to UUIDs. A database seeded with them keeps them: many checkouts can
 * share one development database, and refusing to start (or renaming rows that stored objects, vector tables and
 * history are keyed by) would break all of them at once. Realtime stays on its REST fallback there until a reset.
 */
const LEGACY_SEED_IDS = Object.freeze({ org: "seed-shared-org", project: "seed-shared-project", queuedRun: "seed-queued-run" });

/** Sync development credentials or explicitly requested non-production fixtures. */
export async function seedNonProductionUsers({ includeFixtures = false } = {}): Promise<void> {
  if (process.env.NODE_ENV === "production"
    || (!includeFixtures && process.env.NODE_ENV !== "development")) return;

  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://docslurp:docslurp@localhost:5432/docslurp";

  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10
  });

  const adminIdentity = {
    id: "seed-admin-user",
    email: process.env.SEED_ADMIN_EMAIL ?? "admin@docslurp.local",
    password: process.env.SEED_ADMIN_PASSWORD ?? "testtest",
    name: "DocSlurp Admin"
  };

  const memberIdentity = {
    id: "seed-member-user",
    email: process.env.SEED_MEMBER_EMAIL ?? "member@docslurp.local",
    password: process.env.SEED_MEMBER_PASSWORD ?? "testtest",
    name: "DocSlurp Member"
  };

  async function seedWithTransaction(sql: postgres.TransactionSql): Promise<void> {
    type AuthUserRecord = {
      id: string;
    };

    async function ensureAuthUser(args: { id: string; email: string; password: string; name: string }): Promise<string> {
      const existing = await findAuthUser(args.email);
      if (existing) {
        await syncAuthUser(existing.id, args);
        return existing.id;
      }

      await syncAuthUser(args.id, args);
      return args.id;
    }

    async function findAuthUser(email: string): Promise<AuthUserRecord | null> {
      const [row] = await sql<AuthUserRecord[]>`
        select id
        from "user"
        where email = ${email.toLowerCase()}
        limit 1
      `;

      return row ?? null;
    }

    async function syncAuthUser(id: string, args: { email: string; password: string; name: string }): Promise<void> {
      const passwordHash = await hashPassword(args.password);
      const accountId = `seed-credential-${id}`;

      await sql`
        insert into "user" (
          id,
          email,
          name,
          "emailVerified",
          "createdAt",
          "updatedAt"
        )
        values (
          ${id},
          ${args.email.toLowerCase()},
          ${args.name},
          true,
          now(),
          now()
        )
        on conflict (id) do update
        set email = excluded.email,
            name = excluded.name,
            "emailVerified" = true,
            "updatedAt" = excluded."updatedAt"
      `;

      await sql`
        insert into "account" (
          id,
          "accountId",
          "providerId",
          "userId",
          password,
          "createdAt",
          "updatedAt"
        )
        values (
          ${accountId},
          ${id},
          'credential',
          ${id},
          ${passwordHash},
          now(),
          now()
        )
        on conflict ("providerId", "accountId") do update
        set "userId" = excluded."userId",
            password = excluded.password,
            "updatedAt" = excluded."updatedAt"
      `;
    }

    const [legacy] = await sql<{ id: string }[]>`select id from organizations where id = ${LEGACY_SEED_IDS.org} limit 1`;
    const ids = legacy ? LEGACY_SEED_IDS : SEED_IDS;
    if (legacy) {
      console.warn(
        `[seed] This database holds the seed organization under its old id "${LEGACY_SEED_IDS.org}", so the seed keeps `
        + "the old ids. Realtime subscriptions require UUID ids and fall back to REST polling for this organization. "
        + "For live updates, reset the development database (for the compose stack: docker compose down -v, then "
        + "pnpm db:up && pnpm db:migrate && pnpm db:seed) or point DATABASE_URL at a fresh one.",
      );
    }

    const adminUserId = await ensureAuthUser(adminIdentity);
    const memberUserId = await ensureAuthUser(memberIdentity);

    await sql`
      insert into organizations (
        id,
        name,
        slug,
        is_personal,
        personal_owner_user_id,
        created_by_user_id,
        credit_balance_cents,
        monthly_budget_cents
      )
      values (
        ${ids.org},
        'Seed Shared Org',
        'seed-shared-org',
        false,
        null,
        ${adminUserId},
        100000,
        25000
      )
      on conflict (id) do update
      set
        name = excluded.name,
        slug = excluded.slug,
        created_by_user_id = excluded.created_by_user_id,
        updated_at = now()
    `;

    // One organization per user (DOCSLURP_MAX_ORGS_PER_USER, migration 0127): the seed users live in the shared org, so
    // any other membership they picked up (a personal org from sign-up) is dropped first.
    await sql`
      delete from org_memberships
      where user_id in (${adminUserId}, ${memberUserId}) and org_id <> ${ids.org}
    `;
    await sql`
      insert into org_memberships (org_id, user_id, role)
      values
        (${ids.org}, ${adminUserId}, 'owner'),
        (${ids.org}, ${memberUserId}, 'member')
      on conflict (org_id, user_id) do update
      set role = excluded.role
    `;

    await sql`
      insert into projects (
        id,
        org_id,
        user_id,
        name,
        template_key,
        monthly_budget_cents,
        artifact_retention_days,
        run_retention_days,
        pipeline
      )
      values (
        ${ids.project},
        ${ids.org},
        ${adminUserId},
        'Seed Shared Project',
        'meeting-notes',
        10000,
        30,
        30,
        '{}'::jsonb
      )
      on conflict (id) do update
      set
        org_id = excluded.org_id,
        user_id = excluded.user_id,
        name = excluded.name,
        template_key = excluded.template_key,
        updated_at = now()
    `;

    await sql`
      insert into project_members (project_id, user_id, role, invited_by_user_id)
      values
        (${ids.project}, ${adminUserId}, 'admin', ${adminUserId}),
        (${ids.project}, ${memberUserId}, 'editor', ${adminUserId})
      on conflict (project_id, user_id) do update
      set role = excluded.role,
          invited_by_user_id = excluded.invited_by_user_id
    `;

    if (includeFixtures) {
      await sql`
        insert into project_runs (
          id,
          org_id,
          user_id,
          project_id,
          kind,
          status,
          stage,
          total_documents,
          processed_documents,
          pages_total,
          pages_processed,
          monthly_reservation_cents,
          pipeline
        )
        values (
          ${ids.queuedRun},
          ${ids.org},
          ${adminUserId},
          ${ids.project},
          'bulk-upload',
          'queued',
          'queued',
          1,
          0,
          0,
          0,
          1,
          '{}'::jsonb
        )
        on conflict (id) do update
        set
          org_id = excluded.org_id,
          user_id = excluded.user_id,
          project_id = excluded.project_id,
          status = 'queued',
          stage = 'queued',
          updated_at = now()
      `;
    }

    console.log("[seed] Seed users and shared project ready:");
    console.log(`- admin:  ${adminIdentity.email}`);
    console.log(`- member: ${memberIdentity.email}`);
    console.log(`- org:    ${ids.org} (slug seed-shared-org)`);
    console.log(`- ws:     ${ids.project}`);
    if (includeFixtures) console.log(`- run:    ${ids.queuedRun}`);
  }

  try {
    await sql.begin(async (transaction) => {
      // Serialize replicas against the same database; release automatically on commit/rollback.
      await transaction`select pg_advisory_xact_lock(74123819)`;
      await seedWithTransaction(transaction);
    });
  } finally {
    await sql.end();
  }
}
