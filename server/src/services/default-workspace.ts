import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { HTTPException } from "hono/http-exception";

import { defaultPipelineFeatures, normalizePipelineFeatures } from "@docslurp/shared";

export const DEFAULT_WORKSPACE_NAME = "Default";

export type WorkspaceAccessErrorCode = "organization_not_found" | "workspace_not_found" | "workspace_forbidden";

/**
 * A workspace reference that cannot be served to the caller. Extends Hono's
 * HTTPException so it answers 403/404 with a JSON body from any route, even
 * ones that do not catch it, instead of surfacing as a 500.
 */
export class WorkspaceAccessError extends HTTPException {
  constructor(status: 403 | 404, readonly code: WorkspaceAccessErrorCode, message: string) {
    super(status, { message, res: Response.json({ error: message, code }, { status }) });
    this.name = "WorkspaceAccessError";
  }
}

// The pool client or an open transaction (organization creation inserts inside its tx).
type DefaultWorkspaceSql = postgres.Sql<any> | postgres.TransactionSql<any>;

/**
 * Inserts the organization's default workspace if it has none. The partial
 * unique index on (org_id) where is_default makes concurrent callers converge
 * on one row. Kept free of workspace-service imports so organization creation
 * can call it without an import cycle.
 */
export async function insertDefaultWorkspace(
  db: DefaultWorkspaceSql,
  args: { orgId: string; userId: string },
): Promise<void> {
  const query = db as postgres.Sql<any>;
  await query`
    insert into workspaces (id, org_id, user_id, name, is_default, pipeline)
    values (
      ${randomUUID()},
      ${args.orgId},
      ${args.userId},
      ${DEFAULT_WORKSPACE_NAME},
      true,
      ${query.json(JSON.parse(JSON.stringify(normalizePipelineFeatures(defaultPipelineFeatures))))}
    )
    on conflict (org_id) where is_default do nothing
  `;
}
