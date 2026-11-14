import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { HTTPException } from "hono/http-exception";

import { apiError, apiErrorCodeForStatus, defaultPipelineFeatures, isApiErrorCode, normalizePipelineFeatures, stripManagedPipelineFields, type ApiErrorCode, type ApiErrorDetails } from "@docslurp/shared";

import { withApiErrorDetails } from "../lib/api-error.js";

export const DEFAULT_PROJECT_NAME = "Default";

export type ProjectAccessErrorCode = Extract<ApiErrorCode, "organization_not_found" | "project_not_found" | "project_forbidden" | "project_ambiguous" | "invalid_request" | "forbidden" | "editor_required">;

/**
 * A project reference that cannot be served to the caller. Extends Hono's
 * HTTPException so it answers 400/403/404 with a JSON body from any route, even
 * ones that do not catch it, instead of surfacing as a 500. `details` carries
 * server-authored context such as the slug a `project` value was looked up
 * by; the public error boundary forwards only its allowlisted keys.
 */
export class ProjectAccessError extends HTTPException {
  constructor(
    status: 400 | 403 | 404 | 409,
    readonly code: ProjectAccessErrorCode,
    message: string,
    readonly details?: ApiErrorDetails,
  ) {
    super(status, { message, res: Response.json(apiError(isApiErrorCode(code) ? code : apiErrorCodeForStatus(status), message, details), { status }) });
    this.name = "ProjectAccessError";
    if (details) withApiErrorDetails(this, details);
  }
}

/** A `project` value with no letters or digits once slugified (e.g. "!!!"). */
export function invalidProjectInputError(input: string): ProjectAccessError {
  return new ProjectAccessError(400, "invalid_request", `project "${input}" has no letters or digits; pass a project ID, slug or name`, {
    issues: [{ path: "project", message: "project must contain a letter or digit", code: "invalid_value" }],
  });
}

/** No project the caller can use matches a `project` value; names the slug it was looked up by. */
export function projectInputNotFoundError(lookup: { slug?: string; id?: string }): ProjectAccessError {
  const target = lookup.slug ? `"${lookup.slug}"` : "that ID";
  return new ProjectAccessError(
    404,
    "project_not_found",
    `No project matching ${target} was found. Pass a project ID, slug or name from this organization, or omit project to use the default project.`,
    lookup.slug ? { projectSlug: lookup.slug } : undefined,
  );
}

// The pool client or an open transaction (organization creation inserts inside its tx).
type DefaultProjectSql = postgres.Sql<any> | postgres.TransactionSql<any>;

/**
 * Inserts the organization's default project if it has none. The partial
 * unique index on (org_id) where is_default makes concurrent callers converge
 * on one row. Kept free of project-service imports so organization creation
 * can call it without an import cycle.
 */
export async function insertDefaultProject(
  db: DefaultProjectSql,
  args: { orgId: string; userId: string },
): Promise<void> {
  const query = db as postgres.Sql<any>;
  await query`
    insert into projects (id, org_id, user_id, name, is_default, pipeline)
    values (
      ${randomUUID()},
      ${args.orgId},
      ${args.userId},
      ${DEFAULT_PROJECT_NAME},
      true,
      ${query.json(stripManagedPipelineFields(JSON.parse(JSON.stringify(normalizePipelineFeatures(defaultPipelineFeatures)))))}
    )
    on conflict (org_id) where is_default do nothing
  `;
}
