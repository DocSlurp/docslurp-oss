import type { Sql } from "postgres";

import { sqlJson } from "./sql-helpers.js";

/** One audit_log row (notifications, retention and integrity sweeps record what they did). */
export async function appendAuditLog(sql: Sql<Record<string, unknown>>, args: {
  orgId?: string | null;
  userId?: string | null;
  projectId?: string | null;
  runId?: string | null;
  documentId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    insert into audit_log (
      id,
      org_id,
      user_id,
      project_id,
      run_id,
      document_id,
      action,
      resource_type,
      resource_id,
      metadata,
      created_at
    )
    values (
      gen_random_uuid()::text,
      ${args.orgId ?? null},
      ${args.userId ?? null},
      ${args.projectId ?? null},
      ${args.runId ?? null},
      ${args.documentId ?? null},
      ${args.action},
      ${args.resourceType},
      ${args.resourceId ?? null},
      ${sqlJson(sql, args.metadata ?? {})}::jsonb,
      now()
    )
  `;
}
