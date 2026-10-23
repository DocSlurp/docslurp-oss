import { randomUUID } from "node:crypto";

import { sql, type SqlClient } from "../db.js";
import { currentRequestId } from "../lib/request-context.js";
import { andSqlFragments, type SqlFragment } from "../lib/sql-fragments.js";

type AuditLogRow = {
  id: string;
  org_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  run_id: string | null;
  document_id: string | null;
  api_key_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export interface AuditLogEntry {
  id: string;
  orgId: string | null;
  userId: string | null;
  workspaceId: string | null;
  runId: string | null;
  documentId: string | null;
  apiKeyId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogListInput {
  actorUserId?: string;
  orgId?: string;
  userId?: string;
  workspaceId?: string;
  runId?: string;
  documentId?: string;
  apiKeyId?: string;
  action?: string;
  resourceType?: string;
  before?: string;
  limit?: number;
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  nextCursor: string | null;
}

function mapAuditRow(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    documentId: row.document_id,
    apiKeyId: row.api_key_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    ipAddress: row.ip_address,
    metadata: row.metadata ?? {},
    createdAt: row.created_at
  };
}

export async function appendAuditLog(args: {
  orgId?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
  runId?: string | null;
  documentId?: string | null;
  apiKeyId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}, client: SqlClient = sql): Promise<AuditLogEntry> {
  const requestId = currentRequestId();
  const metadata = {
    ...(args.metadata ?? {}),
    ...(requestId ? { requestId } : {})
  };

  const [row] = await client<AuditLogRow[]>`
    insert into audit_log (
      id,
      org_id,
      user_id,
      workspace_id,
      run_id,
      document_id,
      api_key_id,
      action,
      resource_type,
      resource_id,
      ip_address,
      metadata,
      created_at
    )
    values (
      ${randomUUID()},
      ${args.orgId ?? null},
      ${args.userId ?? null},
      ${args.workspaceId ?? null},
      ${args.runId ?? null},
      ${args.documentId ?? null},
      ${args.apiKeyId ?? null},
      ${args.action},
      ${args.resourceType},
      ${args.resourceId ?? null},
      ${args.ipAddress ?? null},
      ${JSON.stringify(metadata)}::text::jsonb,
      now()
    )
    returning
      id,
      org_id,
      user_id,
      workspace_id,
      run_id,
      document_id,
      api_key_id,
      action,
      resource_type,
      resource_id,
      ip_address,
      metadata,
      created_at::text
  `;

  return mapAuditRow(row);
}

export function buildAuditLogListQuery(args?: AuditLogListInput): {
  query: string;
  params: Array<string | number>;
  limit: number;
} {
  const conditions = ["1=1"];
  const params: Array<string | number> = [];

  if (args?.actorUserId) {
    params.push(args.actorUserId);
    const actorParam = `$${params.length}`;
    conditions.push(`(
      org_id in (
        select org_id from org_memberships where user_id = ${actorParam}
      )
      or workspace_id in (
        select w.id
        from workspaces w
        join org_memberships om on om.org_id = w.org_id
        where om.user_id = ${actorParam}
      )
      or run_id in (
        select r.id
        from workspace_runs r
        join org_memberships om on om.org_id = r.org_id
        where om.user_id = ${actorParam}
      )
      or document_id in (
        select d.id
        from documents d
        join org_memberships om on om.org_id = d.org_id
        where om.user_id = ${actorParam}
      )
    )`);
  }

  if (args?.orgId) {
    params.push(args.orgId);
    conditions.push(`org_id = $${params.length}`);
  }

  if (args?.userId) {
    params.push(args.userId);
    conditions.push(`user_id = $${params.length}`);
  }

  if (args?.workspaceId) {
    params.push(args.workspaceId);
    conditions.push(`workspace_id = $${params.length}`);
  }

  if (args?.runId) {
    params.push(args.runId);
    conditions.push(`run_id = $${params.length}`);
  }

  if (args?.documentId) {
    params.push(args.documentId);
    conditions.push(`document_id = $${params.length}`);
  }

  if (args?.apiKeyId) {
    params.push(args.apiKeyId);
    conditions.push(`api_key_id = $${params.length}`);
  }

  if (args?.action) {
    params.push(args.action);
    conditions.push(`action = $${params.length}`);
  }

  if (args?.resourceType) {
    params.push(args.resourceType);
    conditions.push(`resource_type = $${params.length}`);
  }

  if (args?.before) {
    params.push(args.before);
    conditions.push(`created_at < $${params.length}::timestamptz`);
  }

  const limit = Math.max(1, Math.min(args?.limit ?? 200, 500));
  params.push(limit + 1);

  return {
    query: `select
      id,
      org_id,
      user_id,
      workspace_id,
      run_id,
      document_id,
      api_key_id,
      action,
      resource_type,
      resource_id,
      ip_address,
      metadata,
      created_at::text
    from audit_log
    where ${conditions.join(" and ")}
    order by created_at desc, id desc
    limit $${params.length}`,
    params,
    limit
  };
}

export async function listAuditLogPage(args?: AuditLogListInput): Promise<AuditLogPage> {
  const { whereClause, limit } = buildAuditLogListSql(args);
  const rows = await sql<AuditLogRow[]>`
    select
      id,
      org_id,
      user_id,
      workspace_id,
      run_id,
      document_id,
      api_key_id,
      action,
      resource_type,
      resource_id,
      ip_address,
      metadata,
      created_at::text
    from audit_log
    where ${whereClause}
    order by created_at desc, id desc
    limit ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit).map(mapAuditRow);

  return {
    entries,
    nextCursor: hasMore ? entries.at(-1)?.createdAt ?? null : null
  };
}

export async function listAuditLog(args?: AuditLogListInput): Promise<AuditLogEntry[]> {
  const page = await listAuditLogPage(args);

  return page.entries;
}

function buildAuditLogListSql(args?: AuditLogListInput): {
  whereClause: SqlFragment;
  limit: number;
} {
  const conditions: SqlFragment[] = [];

  if (args?.actorUserId) {
    conditions.push(sql`(
      org_id in (
        select org_id from org_memberships where user_id = ${args.actorUserId}
      )
      or workspace_id in (
        select w.id
        from workspaces w
        join org_memberships om on om.org_id = w.org_id
        where om.user_id = ${args.actorUserId}
      )
      or run_id in (
        select r.id
        from workspace_runs r
        join org_memberships om on om.org_id = r.org_id
        where om.user_id = ${args.actorUserId}
      )
      or document_id in (
        select d.id
        from documents d
        join org_memberships om on om.org_id = d.org_id
        where om.user_id = ${args.actorUserId}
      )
    )`);
  }

  if (args?.orgId) {
    conditions.push(sql`org_id = ${args.orgId}`);
  }

  if (args?.userId) {
    conditions.push(sql`user_id = ${args.userId}`);
  }

  if (args?.workspaceId) {
    conditions.push(sql`workspace_id = ${args.workspaceId}`);
  }

  if (args?.runId) {
    conditions.push(sql`run_id = ${args.runId}`);
  }

  if (args?.documentId) {
    conditions.push(sql`document_id = ${args.documentId}`);
  }

  if (args?.apiKeyId) {
    conditions.push(sql`api_key_id = ${args.apiKeyId}`);
  }

  if (args?.action) {
    conditions.push(sql`action = ${args.action}`);
  }

  if (args?.resourceType) {
    conditions.push(sql`resource_type = ${args.resourceType}`);
  }

  if (args?.before) {
    conditions.push(sql`created_at < ${args.before}::timestamptz`);
  }

  return {
    whereClause: andSqlFragments(conditions),
    limit: Math.max(1, Math.min(args?.limit ?? 200, 500)),
  };
}
