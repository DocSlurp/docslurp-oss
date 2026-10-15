import { randomUUID } from "node:crypto";

import { sql as defaultSql, type SqlClient } from "../db.js";
import { signalPipelineCancel } from "../lib/temporal.js";
import { cancelOrgSubscription } from "./billing/customers.js";
import { cancelWorkspaceRuns, deleteWorkspaceData, type DataDeletionDeps } from "./data-deletion.js";

/**
 * Tenant offboarding: organization deletion and account deletion.
 * The flow, the retained records and the SLA are in docs/data-deletion.md.
 *
 * Tenant data (workspaces, runs, documents, chunks, graphs, chats, settings,
 * keys, grants, SSO) is deleted; LanceDB rows and object-storage artifacts go
 * through the cleanup queues that the delete triggers fill. Billing and audit
 * records are kept for accounting: a deleted org or account keeps an
 * anonymized tombstone row (deleted_at set, name/email scrubbed) so the credit
 * ledger, credit grants, storage meter, usage events and audit log still
 * resolve.
 */

export class OffboardingError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OffboardingError";
  }
}

export interface OffboardingDeps extends DataDeletionDeps {
  /** Cancels the org's Stripe subscription; must be a no-op when there is none. */
  cancelSubscription: (orgId: string) => Promise<unknown>;
}

export const defaultOffboardingDeps: OffboardingDeps = {
  sql: defaultSql,
  cancelWorkflow: (runId) => signalPipelineCancel(runId),
  cancelSubscription: (orgId) => cancelOrgSubscription(orgId),
};

export const DELETED_ORGANIZATION_NAME = "Deleted organization";
export const DELETED_USER_NAME = "Deleted user";

export interface OrganizationDeletionResult {
  orgId: string;
  workspaces: number;
  documents: number;
  runsCancelled: number;
}

type OrgRow = {
  id: string;
  name: string;
  is_personal: boolean;
  personal_owner_user_id: string | null;
  deleted_at: string | null;
  role: string | null;
};

function normalizeConfirmation(value: string | undefined | null): string {
  return (value ?? "").trim();
}

/**
 * Delete an organization: owner only, confirmed by typing the org name.
 * Personal organizations are removed with the account instead.
 */
export async function deleteOrganization(
  input: { orgId: string; userId: string; confirmation: string },
  deps: OffboardingDeps = defaultOffboardingDeps,
): Promise<OrganizationDeletionResult> {
  const [org] = await deps.sql<OrgRow[]>`
    select o.id, o.name, o.is_personal, o.personal_owner_user_id, o.deleted_at::text, om.role
    from organizations o
    left join org_memberships om on om.org_id = o.id and om.user_id = ${input.userId}
    where o.id = ${input.orgId}
    limit 1
  `;
  if (!org || org.deleted_at || !org.role) {
    throw new OffboardingError(404, "organization_not_found", "Organization not found");
  }
  if (org.role !== "owner") {
    throw new OffboardingError(403, "organization_forbidden", "Only an organization owner can delete it");
  }
  if (org.is_personal) {
    throw new OffboardingError(409, "personal_organization", "Your personal organization is deleted with your account");
  }
  if (normalizeConfirmation(input.confirmation) !== org.name.trim()) {
    throw new OffboardingError(400, "confirmation_mismatch", "Type the organization name exactly to confirm");
  }
  return await purgeOrganization(org.id, input.userId, "organization_deleted", deps);
}

/**
 * Remove everything an organization owns. Idempotent and resumable: the
 * tombstone is written first, then each step only deletes what is left, and
 * `resumeOrganizationDeletions` finishes an interrupted purge.
 */
export async function purgeOrganization(
  orgId: string,
  actorUserId: string,
  reason: "organization_deleted" | "account_deleted",
  deps: OffboardingDeps = defaultOffboardingDeps,
  options: { skipBilling?: boolean } = {},
): Promise<OrganizationDeletionResult> {
  const { sql } = deps;
  // Billing first: if Stripe refuses, nothing has been deleted yet.
  if (!options.skipBilling) {
    try {
      await deps.cancelSubscription(orgId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "billing_not_configured") {
        throw new OffboardingError(503, "billing_not_configured", "Billing is not configured, so the subscription cannot be cancelled");
      }
      throw new OffboardingError(502, "subscription_cancel_failed", `Could not cancel the subscription: ${message}`);
    }
  }

  // Tombstone and access removal in one transaction: the org disappears for
  // every member and credential at once.
  await sql.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    await client`
      update organizations
      set deleted_at = coalesce(deleted_at, now()), auto_recharge_enabled = false, updated_at = now()
      where id = ${orgId}
    `;
    await client`delete from org_memberships where org_id = ${orgId}`;
    await client`delete from workspace_invites where org_id = ${orgId}`;
    await client`
      update api_keys set revoked_at = coalesce(revoked_at, now()) where org_id = ${orgId}
    `;
    await client`
      update mcp_oauth_grants set revoked_at = coalesce(revoked_at, now()) where org_id = ${orgId}
    `;
    await client`delete from sso_auth_requests where org_id = ${orgId}`;
    await client`delete from sso_identity_links where org_id = ${orgId}`;
    await client`delete from sso_domains where org_id = ${orgId}`;
    await client`
      insert into audit_log (id, org_id, user_id, action, resource_type, resource_id, metadata)
      values (${randomUUID()}, ${orgId}, ${actorUserId}, 'organization.deleted', 'organization', ${orgId},
        ${client.json({ reason })})
    `;
  });

  const workspaceIds = (await sql<{ id: string }[]>`
    select id from workspaces where org_id = ${orgId}
  `).map((row) => row.id);

  const cancelled = await cancelWorkspaceRuns(workspaceIds, "Organization deleted", deps);

  // Webhook deliveries about this org's runs that have not gone out yet.
  if (workspaceIds.length > 0) {
    await sql`
      delete from webhook_outbox
      where dispatched_at is null
        and payload ->> 'runId' in (
          select id from workspace_runs where workspace_id = any(${sql.array(workspaceIds)})
        )
    `;
  }

  // Drop the org's LanceDB tables whole instead of deleting rows document by
  // document; the per-document sweep skips tables queued here.
  await sql`
    insert into storage_cleanup_queue (kind, org_id, target, payload, reason)
    select 'vector_table', ${orgId}, ${orgId} || '|' || vi.embedding_model || '|' || vi.dimension,
      jsonb_build_object('embeddingModel', vi.embedding_model, 'dimension', vi.dimension), ${reason}
    from vector_indexes vi
    join documents d on d.id = vi.document_id
    join workspaces w on w.id = d.workspace_id
    where w.org_id = ${orgId} and vi.backend = 'lancedb'
    group by vi.embedding_model, vi.dimension
    on conflict (kind, target) do nothing
  `;
  await sql`
    insert into storage_cleanup_queue (kind, org_id, target, payload, reason)
    select distinct 'vector_table', ${orgId}, o.table_key, jsonb_build_object('uri', o.lance_uri, 'table', o.lance_table), ${reason}
    from vector_index_outbox o
    where o.org_id = ${orgId}
    on conflict (kind, target) do nothing
  `;

  let documents = 0;
  for (const workspaceId of workspaceIds) {
    documents += (await deleteWorkspaceData(workspaceId, deps)).documents;
  }

  // Org-scoped rows that are not billing or audit history.
  await sql`delete from ai_operations where org_id = ${orgId}`;
  await sql`delete from graph_jobs where org_id = ${orgId}`;
  await sql`delete from budget_alerts where org_id = ${orgId}`;
  await sql`delete from credit_leases where org_id = ${orgId}`;
  await sql`delete from interactive_spend_holds where org_id = ${orgId}`;
  await sql`delete from notification_deliveries where org_id = ${orgId}`;
  await sql`delete from notification_prefs where org_id = ${orgId}`;
  await sql`delete from upload_sessions where org_id = ${orgId}`;
  await sql`
    update api_keys set name = 'Deleted key', allowed_domains = '{}' where org_id = ${orgId}
  `;
  // Anonymize the tombstone. Stripe ids, plan and credit pools stay for accounting.
  await sql`
    update organizations
    set name = ${DELETED_ORGANIZATION_NAME},
        slug = null,
        personal_owner_user_id = null,
        sso_config = '{}'::jsonb,
        monthly_budget_cents = null,
        auto_recharge_enabled = false,
        auto_recharge_threshold_credits = null,
        auto_recharge_amount_cents = null,
        auto_recharge_monthly_limit_cents = null,
        auto_recharge_authorized_at = null,
        auto_recharge_authorized_by_user_id = null,
        offboarded_at = now(),
        updated_at = now()
    where id = ${orgId}
  `;

  console.log(
    `[offboarding] org deleted orgId=${orgId} reason=${reason} workspaces=${workspaceIds.length} documents=${documents} runsCancelled=${cancelled.cancelled}`,
  );
  return { orgId, workspaces: workspaceIds.length, documents, runsCancelled: cancelled.cancelled };
}

/** Finishes org deletions interrupted after the tombstone was written. */
export async function resumeOrganizationDeletions(deps: OffboardingDeps = defaultOffboardingDeps): Promise<number> {
  const pending = await deps.sql<{ id: string }[]>`
    select id from organizations
    where deleted_at is not null and offboarded_at is null
      and deleted_at < now() - interval '5 minutes'
    order by deleted_at
    limit 5
  `;
  for (const org of pending) {
    await purgeOrganization(org.id, "system", "organization_deleted", deps, { skipBilling: true }).catch((error) => {
      console.error(`[offboarding] resume failed orgId=${org.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return pending.length;
}

export interface AccountDeletionPlan {
  /** Orgs where the user is the only owner but not the only member: ownership must move first. */
  blockers: Array<{ orgId: string; name: string; memberCount: number }>;
  /** The personal org and orgs where the user is the only member. */
  deleteOrganizations: Array<{ orgId: string; name: string; isPersonal: boolean }>;
  /** Orgs the user leaves; content they added there stays with the org. */
  leaveOrganizations: Array<{ orgId: string; name: string; role: string }>;
}

export async function planAccountDeletion(userId: string, sql: SqlClient = defaultSql): Promise<AccountDeletionPlan> {
  const rows = await sql<{
    org_id: string; name: string; is_personal: boolean; personal_owner_user_id: string | null;
    role: string; members: number; owners: number;
  }[]>`
    select o.id as org_id, o.name, o.is_personal, o.personal_owner_user_id, om.role,
      (select count(*)::int from org_memberships m where m.org_id = o.id) as members,
      (select count(*)::int from org_memberships m where m.org_id = o.id and m.role = 'owner') as owners
    from org_memberships om
    join organizations o on o.id = om.org_id
    where om.user_id = ${userId} and o.deleted_at is null
    order by o.is_personal desc, o.created_at
  `;
  const plan: AccountDeletionPlan = { blockers: [], deleteOrganizations: [], leaveOrganizations: [] };
  for (const row of rows) {
    if (row.is_personal && row.personal_owner_user_id === userId) {
      plan.deleteOrganizations.push({ orgId: row.org_id, name: row.name, isPersonal: true });
    } else if (row.members <= 1) {
      plan.deleteOrganizations.push({ orgId: row.org_id, name: row.name, isPersonal: false });
    } else if (row.role === "owner" && row.owners <= 1) {
      plan.blockers.push({ orgId: row.org_id, name: row.name, memberCount: row.members });
    } else {
      plan.leaveOrganizations.push({ orgId: row.org_id, name: row.name, role: row.role });
    }
  }
  return plan;
}

/**
 * Delete the signed-in user's account, confirmed by typing their email.
 * Refused while they are the only owner of an org with other members (they
 * must transfer ownership or delete that org first). Their personal org and
 * orgs where they are the only member are purged; they leave every other org.
 * Credentials, sessions, keys, webhooks, MCP connections, settings and their
 * own chat and search history are deleted; the user row stays as an
 * anonymized tombstone (see docs/data-deletion.md).
 */
export async function deleteAccount(
  input: { userId: string; confirmation: string },
  deps: OffboardingDeps = defaultOffboardingDeps,
): Promise<{ deletedOrganizations: string[]; leftOrganizations: string[] }> {
  const { sql } = deps;
  const [user] = await sql<{ email: string; deleted_at: string | null }[]>`
    select email, deleted_at::text from "user" where id = ${input.userId} limit 1
  `;
  if (!user || user.deleted_at) throw new OffboardingError(404, "user_not_found", "Account not found");
  if (normalizeConfirmation(input.confirmation).toLowerCase() !== user.email.trim().toLowerCase()) {
    throw new OffboardingError(400, "confirmation_mismatch", "Type your email address exactly to confirm");
  }

  const plan = await planAccountDeletion(input.userId, sql);
  if (plan.blockers.length > 0) {
    throw new OffboardingError(
      409,
      "ownership_transfer_required",
      `Make another member an owner of ${plan.blockers.map((org) => org.name).join(", ")} before deleting your account`,
      { blockers: plan.blockers },
    );
  }

  for (const org of plan.deleteOrganizations) {
    await purgeOrganization(org.orgId, input.userId, "account_deleted", deps);
  }

  const leftOrgIds = plan.leaveOrganizations.map((org) => org.orgId);
  await sql.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    const userId = input.userId;
    await client`delete from org_memberships where user_id = ${userId}`;
    await client`delete from workspace_members where user_id = ${userId}`;
    await client`delete from workspace_invites where invited_by_user_id = ${userId} and status = 'pending'`;
    // Credentials and integrations.
    await client`update mcp_oauth_grants set revoked_at = coalesce(revoked_at, now()) where user_id = ${userId}`;
    await client`delete from mcp_oauth_requests where user_id = ${userId}`;
    await client`
      update api_keys set revoked_at = coalesce(revoked_at, now()), name = 'Deleted key', allowed_domains = '{}'
      where user_id = ${userId}
    `;
    await client`delete from webhook_outbox where user_id = ${userId}`;
    await client`delete from webhook_deliveries where user_id = ${userId}`;
    await client`delete from webhooks where user_id = ${userId}`;
    await client`delete from mcp_service_connections where user_id = ${userId}`;
    await client`delete from oauth_accounts where user_id = ${userId}`;
    await client`delete from sso_identity_links where user_id = ${userId}`;
    // Personal settings and activity.
    await client`delete from user_settings where user_id = ${userId}`;
    await client`delete from notification_prefs where user_id = ${userId}`;
    await client`delete from notification_deliveries where user_id = ${userId}`;
    await client`delete from chat_sessions where user_id = ${userId}`;
    await client`delete from search_sessions where user_id = ${userId}`;
    await client`delete from query_suggestions where user_id = ${userId}`;
    await client`delete from search_zero_results where user_id = ${userId}`;
    await client`delete from idempotency_cache where user_id = ${userId}`;
    // Better Auth: sessions, credentials, pending verifications.
    await client`delete from "session" where "userId" = ${userId}`;
    await client`delete from "account" where "userId" = ${userId}`;
    await client`delete from verification where identifier = ${user.email} or identifier like ${`%${user.email}%`}`;
    // Tombstone: the id stays on retained org content and billing history.
    await client`
      update "user"
      set name = ${DELETED_USER_NAME},
          email = ${`deleted-${userId}@deleted.invalid`},
          image = null,
          "emailVerified" = false,
          deleted_at = now(),
          "updatedAt" = now()
      where id = ${userId}
    `;
    await client`
      insert into audit_log (id, user_id, action, resource_type, resource_id, metadata)
      values (${randomUUID()}, ${userId}, 'account.deleted', 'user', ${userId},
        ${client.json({ deletedOrganizations: plan.deleteOrganizations.map((org) => org.orgId), leftOrganizations: leftOrgIds })})
    `;
  });

  console.log(`[offboarding] account deleted userId=${input.userId} orgsDeleted=${plan.deleteOrganizations.length} orgsLeft=${leftOrgIds.length}`);
  return { deletedOrganizations: plan.deleteOrganizations.map((org) => org.orgId), leftOrganizations: leftOrgIds };
}
