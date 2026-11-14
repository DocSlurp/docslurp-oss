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
/** The organization id the seed used before it switched to UUIDs. */
const LEGACY_SEED_ORG_ID = "seed-shared-org";

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

    // Renaming the old rows in place would miss everything keyed by their ids outside these tables (stored objects,
    // vector tables, usage and search history), so an old database is refused instead of half-migrated.
    const [legacy] = await sql<{ id: string }[]>`select id from organizations where id = ${LEGACY_SEED_ORG_ID} limit 1`;
    if (legacy) {
      throw new Error(
        `[seed] This database holds the seed organization under its old id "${LEGACY_SEED_ORG_ID}". `
        + "Seed ids are now UUIDs, which realtime subscriptions require. Reset the development database "
        + "(for the compose stack: docker compose down -v, then pnpm db:up && pnpm db:migrate && pnpm db:seed) "
        + "or point DATABASE_URL at a fresh one.",
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
        ${SEED_IDS.org},
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
      where user_id in (${adminUserId}, ${memberUserId}) and org_id <> ${SEED_IDS.org}
    `;
    await sql`
      insert into org_memberships (org_id, user_id, role)
      values
        (${SEED_IDS.org}, ${adminUserId}, 'owner'),
        (${SEED_IDS.org}, ${memberUserId}, 'member')
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
        ${SEED_IDS.project},
        ${SEED_IDS.org},
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
        (${SEED_IDS.project}, ${adminUserId}, 'admin', ${adminUserId}),
        (${SEED_IDS.project}, ${memberUserId}, 'editor', ${adminUserId})
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
          pipeline
        )
        values (
          ${SEED_IDS.queuedRun},
          ${SEED_IDS.org},
          ${adminUserId},
          ${SEED_IDS.project},
          'bulk-upload',
          'queued',
          'queued',
          1,
          0,
          0,
          0,
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
    console.log(`- org:    ${SEED_IDS.org} (slug seed-shared-org)`);
    console.log(`- ws:     ${SEED_IDS.project}`);
    if (includeFixtures) console.log(`- run:    ${SEED_IDS.queuedRun}`);
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
