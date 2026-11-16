import { PIPELINE_FIELD_IMPACT, type PipelineFeatures, type ProjectRecord } from "@docslurp/shared";
import { HTTPException } from "hono/http-exception";
import type { sql } from "../db.js";

export class PolicyTransitionUnavailableError extends HTTPException {
  readonly code = "policy_publication_unavailable";
  constructor() { super(409, { message: "Tightening privacy or PII policy requires an empty project. Retained documents or run history remain; artifact fencing is not available. No settings or jobs were saved." }); }
}

/** Not a rebuild estimate: every retained version and run counts, regardless of state or index mode.
 * The run-admission trigger takes the same project row lock and checks the admitted policy after it.
 * Existing runs prevent tightening even before their first document arrives or after documents are purged.
 */
export async function assertPolicyTransitionAllowed(client: typeof sql, current: ProjectRecord, next: PipelineFeatures) {
  const tightening = (["privacyMode", "piiPolicy"] as const).some(field => {
    if (JSON.stringify(current.pipeline[field]) === JSON.stringify(next[field])) return false;
    const classify = PIPELINE_FIELD_IMPACT[field];
    return typeof classify === "function" && classify(current.pipeline, next) === "reindex-required";
  });
  if (!tightening) return;
  // Admission takes the organization spend lock before the project row lock. Keep that order.
  await client`select pg_advisory_xact_lock(spend_admission_lock_key(${current.orgId}))`;
  const [project] = await client`select id from projects where id=${current.id} and org_id=${current.orgId} for update`;
  if (!project) throw new PolicyTransitionUnavailableError();
  const [retained] = await client`select
    exists(select 1 from documents where project_id=${current.id} and org_id=${current.orgId})
    or exists(select 1 from project_runs where project_id=${current.id} and org_id=${current.orgId}) as present`;
  if (retained?.present) throw new PolicyTransitionUnavailableError();
}
