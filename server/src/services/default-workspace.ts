import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { HTTPException } from "hono/http-exception";

import { apiError, apiErrorCodeForStatus, defaultPipelineFeatures, isApiErrorCode, normalizePipelineFeatures, type ApiErrorCode, type ApiErrorDetails } from "@docslurp/shared";

import { withApiErrorDetails } from "../lib/api-error.js";

export const DEFAULT_WORKSPACE_NAME = "Default";

export type WorkspaceAccessErrorCode = Extract<ApiErrorCode, "organization_not_found" | "workspace_not_found" | "workspace_forbidden" | "invalid_request" | "forbidden">;

/**
 * A workspace reference that cannot be served to the caller. Extends Hono's
 * HTTPException so it answers 400/403/404 with a JSON body from any route, even
 * ones that do not catch it, instead of surfacing as a 500. `details` carries
 * server-authored context such as the slug a `workspace` value was looked up
 * by; the public error boundary forwards only its allowlisted keys.
 */
export class WorkspaceAccessError extends HTTPException {
  constructor(
    status: 400 | 403 | 404,
    readonly code: WorkspaceAccessErrorCode,
    message: string,
    readonly details?: ApiErrorDetails,
  ) {
    super(status, { message, res: Response.json(apiError(isApiErrorCode(code) ? code : apiErrorCodeForStatus(status), message, details), { status }) });
    this.name = "WorkspaceAccessError";
    if (details) withApiErrorDetails(this, details);
  }
}

/** A `workspace` value with no letters or digits once slugified (e.g. "!!!"). */
export function invalidWorkspaceInputError(input: string): WorkspaceAccessError {
  return new WorkspaceAccessError(400, "invalid_request", `workspace "${input}" has no letters or digits; pass a workspace ID, slug or name`, {
    issues: [{ path: "workspace", message: "workspace must contain a letter or digit", code: "invalid_value" }],
  });
}

/** No workspace the caller can use matches a `workspace` value; names the slug it was looked up by. */
export function workspaceInputNotFoundError(lookup: { slug?: string; id?: string }): WorkspaceAccessError {
  const target = lookup.slug ? `"${lookup.slug}"` : "that ID";
  return new WorkspaceAccessError(
    404,
    "workspace_not_found",
    `No workspace matching ${target} was found. Pass a workspace ID, slug or name from this organization, or omit workspace to use the default workspace.`,
    lookup.slug ? { workspaceSlug: lookup.slug } : undefined,
  );
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
      ${query.json(JSON.parse(JSON.stringify(normalizePipelineFeatures({ ...defaultPipelineFeatures, summarize: true }))))}
    )
    on conflict (org_id) where is_default do nothing
  `;
}
