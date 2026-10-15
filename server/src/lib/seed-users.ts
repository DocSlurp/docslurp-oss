import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

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
        'seed-shared-org',
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

    await sql`
      insert into org_memberships (org_id, user_id, role)
      values
        ('seed-shared-org', ${adminUserId}, 'owner'),
        ('seed-shared-org', ${memberUserId}, 'member')
      on conflict (org_id, user_id) do update
      set role = excluded.role
    `;

    await sql`
      insert into workspaces (
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
        'seed-shared-workspace',
        'seed-shared-org',
        ${adminUserId},
        'Seed Shared Workspace',
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
      insert into workspace_members (workspace_id, user_id, role, invited_by_user_id)
      values
        ('seed-shared-workspace', ${adminUserId}, 'admin', ${adminUserId}),
        ('seed-shared-workspace', ${memberUserId}, 'editor', ${adminUserId})
      on conflict (workspace_id, user_id) do update
      set role = excluded.role,
          invited_by_user_id = excluded.invited_by_user_id
    `;

    if (includeFixtures) {
      await sql`
        insert into workspace_runs (
          id,
          org_id,
          user_id,
          workspace_id,
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
          'seed-queued-run',
          'seed-shared-org',
          ${adminUserId},
          'seed-shared-workspace',
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
          workspace_id = excluded.workspace_id,
          status = 'queued',
          stage = 'queued',
          updated_at = now()
      `;
    }

    console.log("[seed] Seed users and shared workspace ready:");
    console.log(`- admin:  ${adminIdentity.email}`);
    console.log(`- member: ${memberIdentity.email}`);
    console.log("- org:    seed-shared-org");
    console.log("- ws:     seed-shared-workspace");
    if (includeFixtures) console.log("- run:    seed-queued-run");
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
