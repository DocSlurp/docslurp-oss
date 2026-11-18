import { intakeReceiptContext } from "./intake-receipt-context.js";
import { deprecatedPipelineFields, markDeprecatedFields } from "../lib/deprecation.js";
import { CHART_EXPORT_TIER_UNAVAILABLE_CODE, VISUALS_UNAVAILABLE_CODE } from "@docslurp/shared";
/**
 * HTTP-facing Project Intake actions: request parsing, idempotency, and the
 * response payload. Each action is a thin source adapter over
 * `intakeIntoProject`, which owns validation, storage, project resolution,
 * run creation, processing start, and audit.
 */
import { chartExportOverrideError } from "./chart-export-availability.js";
import type { ChartExportTier } from "@docslurp/shared";
import { createHash } from "node:crypto";

import {
  documentTagsSchema,
  pipelineFeatureOverridesSchema,
  publicPipelineFeatureOverridesSchema,
  sanitizeStoredPipeline,
  projectTemplateKeySchema,
  type ExtractRecord,
  type PipelineFeatureOverrides,
  type PipelineFeatures,
  type ProjectTemplateKey,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { discardUnstartedRun, RunAdmissionRefusedError } from "./run-creation.js";
import { type ProjectRunRow } from "./run-records.js";
import { canContributeToProject, getProjectAccess } from "./organizations.js";
import { getLiveApiKeyById, getLiveIntakeKey } from "./api-keys.js";
import { IntakeCredentialRefusedError, type IntakeAuthTarget } from "./project-intake.js";

import { enforceRequestContentLength } from "../lib/upload-policy.js";
import {
  getCachedIdempotentResponse,
  hashIdempotencyPayload,
  scopedIdempotencyKey,
  storeIdempotentResponse,
} from "./idempotency.js";
import {
  prepareDirectUploadProjectIntake,
  loadDirectUploadSession,
  loadDirectUploadSessionRow,
  lockTenant,
  principalLockTenant,
  withDirectUploadLock,
} from "./direct-upload-session.js";
import { opaqueCanonicalIdForUrl, tryCanonicalIdForUrl } from "../lib/canonical-id.js";
import { sourceKeyWithName } from "../lib/url-document-identity.js";
import { inferProjectTitleFromUrls } from "./project-naming.js";
import { attachExtractRun, chargeExtractRetention, describeExtractById, loadIntakeExtract } from "./extracts.js";
import { extensionForMimeType, remoteUrlIntakeItems, urlDerivedFilename } from "./remote-ingest.js";
import {
  intakeIntoProject,
  REFERENCED_REFUSAL_MESSAGES,
  ProjectIntakeError,
  projectIntakePorts,
  type ProjectIntakeAudit,
  type ProjectIntakePorts,
  type ProjectIntakeRequest,
  type ProjectIntakeResult,
} from "./project-intake.js";

export type ProjectIntakePayload = {
  project: ProjectIntakeResult["project"];
  run: ProjectIntakeResult["run"];
  documents: ProjectIntakeResult["documents"];
  warnings: string[];
  /** Files that were not accepted, with why. Absent when every file was taken. */
  rejected?: ProjectIntakeResult["rejected"];
  pipeline?: PipelineFeatures;
  ingested?: Array<{ filename: string; mimeType: string }>;
  /** Website ingestion: pages read by the crawl and the credits it was charged (ingest is billed separately). */
  crawl?: { startUrl: string; pages: number; credits: number };
  /** Extract mode: the extract this intake belongs to, with its retention and download state. */
  extract?: ExtractRecord;
};

export type ProjectIntakeActionResult = {
  payload: ProjectIntakePayload;
  status: 201;
  temporalDeferred: boolean;
  idempotencyReplayed?: boolean;
};

export type BulkProjectIntakeFile = Pick<File, "arrayBuffer" | "name" | "size" | "type">;

type IntakeTargetArgs = Pick<
  ProjectIntakeRequest,
  "speedBoost" | "userId" | "orgId" | "project" | "newProject" | "templateKey" | "allowedProjectIds" | "pipeline" | "tags" | "indexingMode" | "extract" | "apiKeyId" | "origin"
>;

/** Run admission admits server keys only (fail closed), whatever the intake route accepted before it. */
const INTAKE_KEY_TYPES = ["server"] as const;

/** A credential check for one intake request; called with a resolved target, it checks against that target from then on. */
type IntakeCredentialGuard = (resolved?: IntakeAuthTarget) => Promise<void>;

/**
 * The credential check of a bulk, URL or website intake, from one snapshot (getLiveIntakeKey: live, unexpired, owner a
 * member, OAuth grant unrevoked): a server key with the `ingest` scope, of the target's organization, whose project
 * allowlist (if any) still covers the target project (a restricted key never covers a project the intake creates).
 * Before the project is resolved, `initial` is the target (a website crawl's preflighted project, or the organization
 * alone). A refusal stops all remaining work.
 *
 * Revocation semantics: authorization is checked immediately before each external dispatch (a URL fetch, a crawl
 * provider attempt, a storage write). A step already dispatched (one fetch, one write, a provider request already
 * accepted) may complete after a revocation; nothing new starts. Run admission repeats the check in its transaction
 * (`principalAtAdmission`), so no run starts and nothing bills.
 */
function intakeCredentialGuard(apiKeyId: string | null | undefined, initial: IntakeAuthTarget, requiredScopes: readonly string[] = ["ingest"]): IntakeCredentialGuard {
  let target = initial;
  return async (resolved) => {
    if (resolved) target = resolved;
    if (!apiKeyId) return;
    const key = await getLiveIntakeKey(apiKeyId);
    if (!key || !(INTAKE_KEY_TYPES as readonly string[]).includes(key.keyType) || !key.scopes.includes("ingest")
      || requiredScopes.some(scope => !key.scopes.includes(scope))) throw new IntakeCredentialRefusedError();
    if (target.orgId && key.orgId !== target.orgId) throw new IntakeCredentialRefusedError();
    if (target.projectId !== undefined && key.projectIds.length > 0 && (!target.projectId || !key.projectIds.includes(target.projectId))) {
      throw new IntakeCredentialRefusedError();
    }
  };
}

/** The public answer for a credential refused before an external dispatch or at run admission. */
function credentialRefused(): ProjectIntakeError {
  return new ProjectIntakeError("API key no longer permits this upload", 403);
}

function refusedAs403(error: unknown): never {
  if (error instanceof RunAdmissionRefusedError || error instanceof IntakeCredentialRefusedError) throw credentialRefused();
  throw error;
}

/**
 * Intake that checks its credential (`guard`) before every external dispatch and re-validates the principal inside its
 * run's admission transaction; a refusal at either point is a 403 and stops the remaining work.
 */
async function admittedIntake(request: ProjectIntakeRequest, ports: ProjectIntakePorts, guard: IntakeCredentialGuard): ReturnType<typeof requiredIntake> {
  return await requiredIntake({
    ...request,
    authorizeExternalWork: guard,
    principalAtAdmission: { scope: "ingest", keyTypes: INTAKE_KEY_TYPES },
  }, ports).catch(refusedAs403);
}

/** The check before an intake's external work begins (a crawl, the first fetch or write). */
async function assertIntakeCredentialLive(guard: IntakeCredentialGuard): Promise<void> {
  await guard().catch(refusedAs403);
}

/**
 * Intake, plus extract bookkeeping: the run is linked to its extract on
 * success. (A failed extract request is expired by its route, routes/extracts.ts;
 * a direct upload session may retry its confirm, so its extract keeps its schedule.)
 */
async function requiredIntake(
  request: ProjectIntakeRequest,
  ports: ProjectIntakePorts,
): Promise<ProjectIntakeResult & { extract?: ExtractRecord }> {
  const intake = await intakeIntoProject(request, ports);
  if (!intake) throw new ProjectIntakeError("Attach at least one file.", 400);
  if (!request.extract) return intake;
  // The run is committed (and linked to its extract in its own transaction): nothing below may fail the request.
  const extractId = request.extract.id;
  await chargeExtractRetention(extractId, "admission").catch((error: unknown) => {
    console.error(`[extract] admission charge failed extract=${extractId}; the sweep charges at settle: ${error instanceof Error ? error.message : String(error)}`);
  });
  const extract = await describeExtractById(extractId).catch(() => null);
  return extract ? { ...intake, extract } : intake;
}

function actionResult(
  intake: ProjectIntakeResult & { extract?: ExtractRecord },
  extra: Partial<ProjectIntakePayload> = {},
): ProjectIntakeActionResult {
  return {
    payload: {
      project: intake.project,
      run: intake.run,
      documents: intake.documents,
      warnings: [
        ...(intake.deferredReason ? [intake.deferredReason] : []),
        ...(intake.rejected.length > 0 ? [notAcceptedWarning(intake.rejected, intake.documents.length)] : []),
      ],
      ...(intake.rejected.length > 0 ? { rejected: intake.rejected } : {}),
      ...(intake.extract ? { extract: intake.extract } : {}),
      ...extra,
    },
    status: 201,
    temporalDeferred: Boolean(intake.deferredReason),
  };
}

async function authorizeReceiptProject(projectId: string, userId: string, orgId?: string | null, apiKeyId?: string | null): Promise<void> {
  const access = await getProjectAccess(projectId, userId);
  if (!access || !canContributeToProject(access, userId) || (orgId && access.orgId !== orgId)) {
    throw new ProjectIntakeError("Upload project is no longer accessible", 403);
  }
  if (apiKeyId) {
    const key = await getLiveApiKeyById(apiKeyId);
    if (!key || key.orgId !== access.orgId || !key.scopes.includes("ingest")
      || (key.projectIds.length > 0 && !key.projectIds.includes(projectId))) {
      throw new ProjectIntakeError("API key no longer permits this upload", 403);
    }
  }
}

const URL_INTAKE_ROUTES = new Set(["uploads.url", "extracts.url"]);
const NOT_ACCEPTED_WARNING = /files were not accepted:/;

function notAcceptedWarning(rejected: ProjectIntakeResult["rejected"], documentCount: number): string {
  return `${rejected.length} of ${rejected.length + documentCount} files were not accepted: ${rejected.map((file) => file.filename).join(", ")}.`;
}

/**
 * Receipt format version. A current-version receipt was written by code that
 * names every URL-derived field safely; an unversioned (legacy) receipt may hold
 * a URL, its path segment or a raw reason in any name field.
 */
export const INTAKE_RECEIPT_VERSION = 2;

/** The payload fields a URL intake response carries; nothing else is replayed. */
const URL_RECEIPT_FIELDS = ["project", "run", "documents", "warnings", "rejected", "pipeline", "ingested", "extract"] as const;

/** A current-version URL receipt replays only the fields the response defines. */
export function projectCurrentUrlReceipt(payload: ProjectIntakePayload): ProjectIntakePayload {
  const projected: Record<string, unknown> = {};
  for (const field of URL_RECEIPT_FIELDS) if (payload[field] !== undefined) projected[field] = payload[field];
  return projected as ProjectIntakePayload;
}

/**
 * A legacy (unversioned) URL receipt as it may be replayed: every name field is
 * re-derived, and anything not safely derivable gets the generic value.
 * - project.name and run.projectName: the host-only title from the request's
 *   URLs ("Import from example.com"), else "URL import"; project.slug: the project id.
 * - documents and ingested: `url-<i><ext>` names, source keys renamed to match,
 *   titles dropped. A canonical ID is made opaque only when it is the server's
 *   legacy default for one of the request's URLs; a caller's own ID is kept.
 *   Never throws.
 * - rejected: `urls[i]` with the per-code copy; the not-accepted warning rebuilt.
 */
export function sanitizeLegacyUrlReceipt(payload: ProjectIntakePayload, urls?: readonly string[]): ProjectIntakePayload {
  const title = urls?.length ? inferProjectTitleFromUrls([...urls]) : "URL import";
  const genericName = (position: number, mimeType: string) => `url-${position}${extensionForMimeType(mimeType ?? "")}`;
  // Server-derived legacy IDs: the legacy default of each request URL, replayed as that URL's full-URL hash
  // (the ID adoption gives the row); unparseable URLs have none.
  const serverDefaults = new Map((urls ?? []).flatMap((url) => {
    const legacy = tryCanonicalIdForUrl(url);
    return legacy === null ? [] : [[legacy, opaqueCanonicalIdForUrl(url)] as const];
  }));
  const rejected = payload.rejected?.map((file, position) => {
    const index = typeof file.index === "number" ? file.index : position;
    return { index, filename: `urls[${index}]`, statusCode: file.statusCode, code: file.code, message: REFERENCED_REFUSAL_MESSAGES[file.code] ?? REFERENCED_REFUSAL_MESSAGES.rejected };
  });
  const documents = payload.documents.map((document, position) => {
    const name = genericName(position, document.mimeType);
    const { title: _title, ...rest } = document as typeof document & { title?: unknown };
    return {
      ...rest,
      filename: name,
      ...(typeof document.sourceKey === "string" ? { sourceKey: sourceKeyWithName(document.sourceKey, name) } : {}),
      ...(typeof document.canonicalId === "string" && serverDefaults.has(document.canonicalId)
        ? { canonicalId: serverDefaults.get(document.canonicalId)! }
        : {}),
    };
  });
  return projectCurrentUrlReceipt({
    ...payload,
    project: { ...payload.project, name: title, slug: payload.project.id } as ProjectIntakePayload["project"],
    run: { ...payload.run, projectName: title } as ProjectIntakePayload["run"],
    documents: documents as ProjectIntakePayload["documents"],
    ...(rejected ? { rejected } : {}),
    ...(payload.ingested ? { ingested: payload.ingested.map((file, position) => ({ ...file, filename: genericName(position, file.mimeType) })) } : {}),
    warnings: [
      ...payload.warnings.filter((warning) => !NOT_ACCEPTED_WARNING.test(warning)),
      ...(rejected?.length ? [notAcceptedWarning(rejected, documents.length)] : []),
    ],
  });
}

/** How a stored receipt is replayed: URL routes by version, every other route as stored. */
export function replayedPayload(routeKey: string, stable: ProjectIntakeActionResult & { receiptVersion?: unknown }, urls?: readonly string[]): ProjectIntakePayload {
  if (!URL_INTAKE_ROUTES.has(routeKey)) return stable.payload;
  return stable.receiptVersion === INTAKE_RECEIPT_VERSION ? projectCurrentUrlReceipt(stable.payload) : sanitizeLegacyUrlReceipt(stable.payload, urls);
}

/**
 * Re-validates a direct-upload session's principal at billable admission: the user may still contribute to the
 * session's project (or, for a session that creates its project, still belongs to its organization); a session opened
 * with an API key needs that key live (not revoked or expired, owner still a member), a server key of the session's
 * organization with the `ingest` scope, and a project allowlist that still admits the target. The allowlist used is
 * the live one narrowed by the session's own, never wider than either. Refusals are 403s: no run starts, nothing bills.
 */
export async function liveDirectUploadAdmission(
  session: { org_id: string | null; project_id: string | null; project_name?: string | null; api_key_id?: string | null; allowed_project_ids?: string[] | null },
  userId: string,
): Promise<{ allowedProjectIds: string[] | null }> {
  const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
  await assertSessionProjectStillContributable(session, userId);
  const stored = session.allowed_project_ids ?? [];
  if (!session.api_key_id) return { allowedProjectIds: stored.length ? stored : null };
  const key = await getLiveApiKeyById(session.api_key_id);
  const [revokedGrant] = await sql<Array<{ one: number }>>`select 1 as one from mcp_oauth_grants
    where api_key_id = ${session.api_key_id} and revoked_at is not null limit 1`;
  if (!key || revokedGrant || key.keyType !== "server" || !session.org_id || key.orgId !== session.org_id || !key.scopes.includes("ingest")) {
    throw new ProjectIntakeError("API key no longer permits this upload", 403);
  }
  const live = key.projectIds;
  const allowed = stored.length && live.length ? stored.filter(id => live.includes(id)) : stored.length ? stored : live;
  if ((stored.length || live.length) && (allowed.length === 0 || (session.project_id && !allowed.includes(session.project_id)))) {
    throw new ProjectIntakeError("API key no longer permits this upload", 403);
  }
  // A project-scoped key never creates a project (SEC-2026-10-07).
  if (allowed.length && !session.project_id && !session.project_name) throw new ProjectIntakeError("API key no longer permits this upload", 403);
  return { allowedProjectIds: allowed.length ? allowed : null };
}

/** Replays a cached response for a repeated Idempotency-Key, or runs and caches the action. */
async function idempotently(
  args: { idempotencyKey?: string; routeKey: string; requestHash: string; userId: string; orgId?: string | null; apiKeyId?: string | null; project?: string | null; urls?: readonly string[] },
  run: () => Promise<ProjectIntakeActionResult>,
): Promise<ProjectIntakeActionResult> {
  if (!args.idempotencyKey) return await run();
  // Clients choose their keys, so two tenants will pick the same one: the cache key is scoped to organization and user.
  const idempotencyKey = scopedIdempotencyKey({ orgId: args.orgId, userId: args.userId, apiKeyId: args.apiKeyId, project: args.project }, args.idempotencyKey);

  return await withDirectUploadLock(`intake:${args.routeKey}:${idempotencyKey}`, async () => {
    let cached;
    try {
      cached = await getCachedIdempotentResponse({
        idempotencyKey,
        routeKey: args.routeKey,
        requestHash: args.requestHash,
      });
    } catch (error) {
      throw new ProjectIntakeError(error instanceof Error ? error.message : "Idempotency conflict", 409);
    }
    if (!cached) {
      const receipts = await sql`select r.*, p.creation_ready_at from intake_request_receipts r
        left join project_runs p on p.id = r.run_id
        where r.idempotency_key = ${idempotencyKey} and r.route_key = ${args.routeKey}`;
      let receipt: (typeof receipts)[number] | undefined = receipts[0];
      if (receipt) {
        if (receipt.request_hash !== args.requestHash) throw new ProjectIntakeError("Idempotency conflict", 409);
        if (!receipt.creation_ready_at) {
          if (receipt.external_effect_started !== false) throw new ProjectIntakeError("Intake outcome is uncertain; reconciliation required", 409, undefined, "intake_reconciliation_required");
          if (receipt.run_id && !await discardUnstartedRun(receipt.run_id)) throw new ProjectIntakeError("Committed intake is still recovering; retry shortly", 409);
          await sql`delete from intake_request_receipts where idempotency_key = ${idempotencyKey} and route_key = ${args.routeKey} and run_id is null and external_effect_started = false`;
          receipt = undefined;
        }
      }
      if (receipt) {
        if (!receipt.stable_result) throw new ProjectIntakeError("Committed intake response requires reconciliation", 409, undefined, "intake_reconciliation_required");
        const stable = receipt.stable_result as ProjectIntakeActionResult;
        cached = { status: stable.status, body: stable.payload as unknown as Record<string, unknown> };
      }
    }
    if (cached) {
      const payload = cached.body as ProjectIntakePayload;
      // Authorize the actual persisted target, including an omitted/default
      // target. A cache namespace is identity, never current permission.
      const projectId = payload.project?.id;
      if (!projectId) throw new ProjectIntakeError("Upload project is no longer accessible", 403);
      await authorizeReceiptProject(projectId, args.userId, args.orgId, args.apiKeyId);
      const [stableReceipt] = await sql`select stable_result from intake_request_receipts
        where idempotency_key = ${idempotencyKey} and route_key = ${args.routeKey}`;
      const stable = stableReceipt?.stable_result as ProjectIntakeActionResult | undefined;
      if (!stable || stable.status !== 201 || typeof stable.temporalDeferred !== "boolean" ||
          !stable.payload || stable.payload.project?.id !== projectId ||
          !stable.payload.run?.id || !Array.isArray(stable.payload.documents) || !Array.isArray(stable.payload.warnings)) {
        throw new ProjectIntakeError("Committed intake response requires reconciliation", 409, undefined, "intake_reconciliation_required");
      }
      return {
        payload: replayedPayload(args.routeKey, stable, args.urls),
        status: stable.status,
        temporalDeferred: stable.temporalDeferred,
        idempotencyReplayed: true,
      };
    }

    // Claim before work. Safe preparation can retry under this same lock; a crawl
    // durably marks its uncertain external-effect boundary before invocation.
    await sql`insert into intake_request_receipts (idempotency_key, route_key, request_hash, user_id, external_effect_started)
      values (${idempotencyKey}, ${args.routeKey}, ${args.requestHash}, ${args.userId}, false)`;
    const result = await intakeReceiptContext.run({ key: idempotencyKey, route: args.routeKey, hash: args.requestHash, userId: args.userId }, run);
    const [saved] = await sql`update intake_request_receipts set stable_result = ${sql.json(JSON.parse(JSON.stringify({ ...result, receiptVersion: INTAKE_RECEIPT_VERSION })))}
      where idempotency_key = ${idempotencyKey} and route_key = ${args.routeKey}
        and request_hash = ${args.requestHash} and user_id = ${args.userId}
      returning run_id`;
    if (!saved) throw new ProjectIntakeError("Intake response requires reconciliation", 409, undefined, "intake_reconciliation_required");
    await storeIdempotentResponse({
      idempotencyKey,
      routeKey: args.routeKey,
      requestHash: args.requestHash,
      userId: args.userId,
      status: result.status,
      body: result.payload as unknown as Record<string, unknown>,
    });
    return result;
  }, "A request with this Idempotency-Key is still being processed; retry shortly", "idempotency_in_flight",
  // Holds its Idempotency-Key lock for the whole request (crawl, fetch, storage writes, run creation) so a concurrent
  // repeat is refused rather than run twice: its own capped class, so it never takes a run-start slot.
  { lockClass: "intake", tenant: await principalLockTenant(args.userId, args.apiKeyId) });
}

/**
 * Upload pipelines are partial overrides: they merge onto the project
 * pipeline (and its template locks) instead of replacing it.
 */
export function parseProjectIntakePipeline(raw: unknown): PipelineFeatureOverrides {
  markDeprecatedFields(null, deprecatedPipelineFields(raw));
  const parsed = publicPipelineFeatureOverridesSchema.safeParse(raw === undefined || raw === null ? {} : raw);
  if (!parsed.success) {
    throw new ProjectIntakeError("Invalid pipeline payload", 422, parsed.error.issues.map((issue) => ({
      path: ["pipeline", ...issue.path].join("."),
      message: issue.message,
      code: issue.code,
    })));
  }
  const usedVisuals = !!raw && typeof raw === "object" && (raw as { visuals?: unknown }).visuals != null;
  assertIntakeChartExportTier((parsed.data as { chartExport?: { tier?: ChartExportTier } }).chartExport?.tier, "intake", usedVisuals);
  return parsed.data;
}

/**
 * Refuses an upload, URL ingest, extract or crawl override for a tier the deployment does not offer: 400
 * `chart_export_tier_unavailable`, the same code and status as reprocess, estimates and project changes.
 */
export function assertIntakeChartExportTier(tier: ChartExportTier | null | undefined, context: string, usedVisuals = false): void {
  const refused = chartExportOverrideError(tier, context);
  if (refused && usedVisuals) {
    throw new ProjectIntakeError(refused, 400, [{ path: "pipeline.visuals", message: refused, code: VISUALS_UNAVAILABLE_CODE }], VISUALS_UNAVAILABLE_CODE);
  }
  if (refused) {
    throw new ProjectIntakeError(refused, 400, [{ path: "pipeline.chartExport.tier", message: refused, code: CHART_EXPORT_TIER_UNAVAILABLE_CODE }], CHART_EXPORT_TIER_UNAVAILABLE_CODE);
  }
}

export function parseProjectIntakeTemplateKey(raw: unknown): ProjectTemplateKey | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  return projectTemplateKeySchema.safeParse(raw.trim()).data;
}

export function parseFormProjectIntakePipeline(raw: unknown): PipelineFeatureOverrides | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;

  try {
    return parseProjectIntakePipeline(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ProjectIntakeError) throw error;
    throw new ProjectIntakeError("Invalid pipeline payload", 422, [
      { path: "pipeline", message: "pipeline must be valid JSON", code: "custom" },
    ]);
  }
}

export async function confirmDirectUploadProjectIntake(
  /** `lockWaitMs`: how long to wait out a reconciler pass or another request holding the session (0: answer busy at once). */
  args: { sessionId: string; userId: string; audit?: ProjectIntakeAudit; lockWaitMs?: number },
  ports: ProjectIntakePorts = projectIntakePorts,
): Promise<ProjectIntakeActionResult> {
  // The organization a run start counts against is known before the lock (the row is scoped to this user).
  const owned = await loadDirectUploadSessionRow(args.sessionId, args.userId);
  if (!owned) throw new ProjectIntakeError("Upload session not found", 404);
  // Confirm is idempotent. A session already confirmed answers its stored result without the lock (re-authorized as in
  // the locked replay below), so a repeated confirm never waits on, or is refused by, a lock holder.
  if (owned.result) {
    const result = owned.result as ProjectIntakeActionResult;
    await authorizeReceiptProject(result.payload.project.id, args.userId, owned.org_id, owned.api_key_id);
    return result;
  }
  if (["aborted", "failed"].includes(owned.status)) throw new ProjectIntakeError("Upload session is closed", 409);
  return withDirectUploadLock(args.sessionId, async () => {
    const loaded = await loadDirectUploadSession(args.sessionId, args.userId);
    if (!loaded) throw new ProjectIntakeError("Upload session not found", 404);
    if (["aborted", "failed"].includes(loaded.session.status)) throw new ProjectIntakeError("Upload session is closed", 409);
    if (loaded.session.result) {
      const result = loaded.session.result as ProjectIntakeActionResult;
      await authorizeReceiptProject(result.payload.project.id, args.userId, loaded.session.org_id, loaded.session.api_key_id);
      return result;
    }
    if (!loaded.files.every(file => file.status === "completed")) throw new ProjectIntakeError("Upload session still has incomplete files", 409);

    // Run identity is chosen before intake. A process crash after publication can
    // recover the same manifest rather than creating a second billable run.
    const [existing] = await sql<Array<ProjectRunRow & { creation_ready_at?: string | null }>>`select * from project_runs where id = ${args.sessionId} and user_id = ${args.userId}`;
    if (existing && existing.creation_ready_at) {
      await authorizeReceiptProject(existing.project_id, args.userId, loaded.session.org_id, loaded.session.api_key_id);
      throw new ProjectIntakeError("Committed intake response requires reconciliation", 409, undefined, "intake_reconciliation_required");
    }
    if (existing) await discardUnstartedRun(args.sessionId);
    const { session, items } = await prepareDirectUploadProjectIntake(args.sessionId, args.userId);
    // Billable admission: whoever starts it (the client's confirm, the reconciler's sweep or kick), the run is admitted
    // only under the principal's rights as they are now, never as stored when the session was opened.
    const admission = await liveDirectUploadAdmission(session, args.userId);
    // An extract session lands only while its extract is live; its sources are already under the extract prefix.
    const extract = session.extract_id ? await loadIntakeExtract(session.extract_id, args.userId) : null;
    if (session.extract_id && !extract) throw new ProjectIntakeError("This extract expired before its files were confirmed.", 409);
    await sql`update upload_sessions set status = 'ingesting' where id = ${args.sessionId}`;
    const intakePorts: ProjectIntakePorts = { ...ports, records: {
      ...ports.records,
      async discardProject(projectId) {
        await ports.records.discardProject(projectId);
        await sql`update upload_sessions set project_id = null where id = ${args.sessionId} and project_id = ${projectId}`;
      },
      async createProject(input) {
        const project = await ports.records.createProject(input);
        await sql`update upload_sessions set project_id = ${project.id}, org_id = ${project.orgId} where id = ${args.sessionId}`;
        return project;
      },
    } };
    const sessionPipeline = session.pipeline ? sanitizeStoredPipeline(session.pipeline, `upload session ${args.sessionId}`) : undefined;
    // Re-checked at confirm: a session opened before the deployment stopped offering a tier (or before migration 0151
    // mapped enabled:true to models) is refused with the same code, not run at a tier no estimate showed.
    // A stored session pipeline is already converted; the deprecated tier code stays for it (the request named a tier then).
    assertIntakeChartExportTier((sessionPipeline as { chartExport?: { tier?: ChartExportTier } } | undefined)?.chartExport?.tier, `upload session ${args.sessionId}`);
    const intake = await requiredIntake({
      userId: args.userId,
      orgId: session.org_id,
      project: session.project_id ?? session.project_name,
      newProject: !session.project_id && !session.project_name,
      templateKey: session.template_key ? projectTemplateKeySchema.parse(session.template_key) : undefined,
      // Stored with the session; a session created before an extractor schema tightened is read leniently.
      speedBoost: session.pipeline?.speedBoost === true,
      pipeline: sessionPipeline,
      tags: session.tags ?? [],
      apiKeyId: session.api_key_id,
      // Recorded from the principal that opened the session (never a request field); older rows are machine.
      origin: session.origin === "app" ? "app" : "machine",
      allowedProjectIds: admission.allowedProjectIds,
      // The check above can go stale while admission waits on the organization's spend lock: repeat it there.
      principalAtAdmission: { scope: "ingest" },
      runId: args.sessionId,
      kind: "direct-upload",
      items,
      audit: args.audit,
      ...(extract ? { extract } : {}),
    }, intakePorts).catch(async (error: unknown) => {
      if (!(error instanceof RunAdmissionRefusedError)) throw error;
      // Refused inside admission (nothing reserved or created): leave the session as it was, so the refusal is final.
      await sql`update upload_sessions set status = ${session.status} where id = ${args.sessionId} and status = 'ingesting'`;
      throw new ProjectIntakeError("API key no longer permits this upload", 403);
    });
    const result = actionResult(intake);
    await persistDirectUploadResult(args.sessionId, result);
    return result;
  }, undefined, undefined, { waitMs: args.lockWaitMs ?? 0, lockClass: "start", tenant: await principalLockTenant(args.userId, owned.api_key_id) });
}

async function persistDirectUploadResult(sessionId: string, result: ProjectIntakeActionResult) {
  await sql`update upload_sessions set status = 'confirmed', result = ${sql.json(JSON.parse(JSON.stringify(result)))},
    project_id = ${result.payload.project.id}, org_id = ${result.payload.project.orgId}, last_error = null, updated_at = now()
    where id = ${sessionId}`;
}

export async function createBulkProjectIntake(
  args: IntakeTargetArgs & {
    files: BulkProjectIntakeFile[];
    /** Aligned with `files`. */
    canonicalIds?: Array<string | null>;
    /** Folder paths aligned with `files`. */
    paths?: string[];
    idempotencyKey?: string;
    contentLength?: string | null;
    audit?: ProjectIntakeAudit;
  },
  ports: ProjectIntakePorts = projectIntakePorts,
): Promise<ProjectIntakeActionResult> {
  try {
    enforceRequestContentLength(args.contentLength ?? null);
  } catch (error) {
    throw new ProjectIntakeError(error instanceof Error ? error.message : "Upload too large", 413);
  }
  if (args.files.length === 0) {
    throw new ProjectIntakeError("Attach at least one file using the files field.", 400);
  }

  const files = await Promise.all(
    args.files.map(async (file, index) => ({
      filename: file.name,
      mimeType: file.type,
      canonicalId: args.canonicalIds?.[index] ?? null,
      path: args.paths?.[index] ?? "",
      bytes: Buffer.from(await file.arrayBuffer()),
    })),
  );
  const { files: _files, canonicalIds: _canonicalIds, paths: _paths, idempotencyKey, contentLength: _length, audit, ...target } = args;
  // The extract is created per request, so it is not part of the request's identity.
  const { extract: _extract, ...hashedTarget } = target;
  const requestHash = hashIdempotencyPayload({
    ...hashedTarget,
    templateKey: target.templateKey ?? null,
    files: files.map((file) => ({
      filename: file.filename,
      mimeType: file.mimeType,
      canonicalId: file.canonicalId,
      path: file.path,
      size: file.bytes.byteLength,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    })),
  });

  return await idempotently(
    { idempotencyKey, routeKey: target.extract ? "extracts.bulk" : "uploads.bulk", requestHash, userId: args.userId, orgId: args.orgId, apiKeyId: args.apiKeyId, project: args.project },
    async () => {
      const guard = intakeCredentialGuard(args.apiKeyId, { orgId: args.orgId ?? null });
      await assertIntakeCredentialLive(guard);
      return actionResult(
        await admittedIntake(
          {
            ...target,
            kind: "bulk-upload",
            items: files.map(({ bytes, ...file }) => ({ ...file, content: { bytes } })),
            audit,
          },
          ports,
          guard,
        ),
      );
    },
  );
}

export async function createRemoteUrlProjectIntake(
  args: IntakeTargetArgs & {
    urls: string[];
    /** Aligned with `urls`; missing entries default to the URL itself. */
    canonicalIds?: Array<string | null>;
    idempotencyKey?: string;
    audit?: ProjectIntakeAudit;
  },
  ports: ProjectIntakePorts = projectIntakePorts,
): Promise<ProjectIntakeActionResult> {
  const { idempotencyKey, audit, canonicalIds, ...target } = args;
  const { extract: _extract, ...hashedTarget } = target;
  return await idempotently(
    {
      idempotencyKey,
      routeKey: target.extract ? "extracts.url" : "uploads.url",
      // A legacy receipt's replay re-derives its title from these (host only).
      urls: args.urls,
      requestHash: hashIdempotencyPayload({ ...hashedTarget, canonicalIds: canonicalIds ?? null, idempotencyKey }),
      userId: args.userId,
      orgId: args.orgId,
      apiKeyId: args.apiKeyId,
      project: args.project,
    },
    async () => {
      const guard = intakeCredentialGuard(args.apiKeyId, { orgId: args.orgId ?? null });
      await assertIntakeCredentialLive(guard);
      const intake = await admittedIntake(
        {
          ...target,
          kind: "url-ingest",
          // Each URL is fetched only while the credential still covers the resolved project (checked last before its request).
          items: remoteUrlIntakeItems(args.urls, { canonicalIds, beforeFetch: () => guard() }),
          urls: args.urls,
          audit,
        },
        ports,
        guard,
      );
      return actionResult(intake, {
        ingested: intake.documents.map((document) => ({
          filename: document.filename,
          mimeType: document.mimeType,
        })),
        pipeline: intake.pipeline,
      });
    },
  );
}

/**
 * A crawled page's document name: `<host>-<index>.md`, the rule every URL
 * source follows (never its path or query). A URL the crawler returned that
 * does not parse is named after the crawl's own host.
 */
function webPageFilename(rawUrl: string, index: number, startUrl: string): string {
  for (const candidate of [rawUrl, startUrl]) {
    try { return urlDerivedFilename(new URL(candidate), index, "text/markdown"); } catch { /* try the next */ }
  }
  return `page-${index}${extensionForMimeType("text/markdown")}`;
}

/**
 * Website ingestion: crawl a site through Web Capabilities, then ingest every
 * page as a Markdown document whose canonical ID is the page URL, so a re-crawl
 * supersedes the previous version. The crawl runs inside the idempotency
 * window, so a retried request neither re-crawls nor re-charges.
 */
export async function createWebsiteProjectIntake(
  args: IntakeTargetArgs & {
    startUrl: string;
    /**
     * Runs the crawl. `beforeProviderAttempt` is the credential check the crawl must run immediately before every
     * provider request, failovers and retries included (runWebCapability's `beforeProviderAttempt`).
     */
    crawl: (beforeProviderAttempt: () => Promise<void>) => Promise<{ pages: Array<{ url: string; title?: string; markdown?: string }>; credits: number }>;
    /**
     * The project the crawl is for, preflighted by the caller (null: a project the intake will create; omitted:
     * unknown). The credential check covers it until the intake resolves its target.
     */
    crawlProjectId?: string | null;
    /**
     * Every scope the route required of the caller's key (`ingest`, plus `web` for a CLI OAuth token): the credential
     * checks before each provider attempt and each write require them all, not just `ingest`.
     */
    requiredScopes?: readonly string[];
    crawlOptions: Record<string, unknown>;
    idempotencyKey?: string;
    audit?: ProjectIntakeAudit;
  },
  ports: ProjectIntakePorts = projectIntakePorts,
): Promise<ProjectIntakeActionResult> {
  const { idempotencyKey, audit, crawl, crawlOptions, startUrl, crawlProjectId, requiredScopes, ...target } = args;
  return await idempotently(
    {
      idempotencyKey,
      routeKey: "web.ingest",
      requestHash: hashIdempotencyPayload({ ...target, startUrl, crawlOptions, idempotencyKey }),
      userId: args.userId,
      orgId: args.orgId,
      apiKeyId: args.apiKeyId,
      project: args.project,
    },
    async () => {
      const receipt = intakeReceiptContext.getStore();
      if (receipt) await sql`update intake_request_receipts set external_effect_started = true
        where idempotency_key = ${receipt.key} and route_key = ${receipt.route}`;
      const guard = intakeCredentialGuard(args.apiKeyId, {
        orgId: args.orgId ?? null, ...(crawlProjectId !== undefined ? { projectId: crawlProjectId } : {}),
      }, requiredScopes ?? ["ingest"]);
      await assertIntakeCredentialLive(guard);
      const crawled = await crawl(() => guard()).catch(refusedAs403);
      const pages = crawled.pages.filter((page) => page.markdown?.trim());
      if (!pages.length) throw new ProjectIntakeError("The crawl found no readable pages at this URL.", 422);
      const intake = await admittedIntake(
        {
          ...target,
          kind: "url-ingest",
          items: pages.map((page, index) => {
            const body = page.title && !page.markdown!.trimStart().startsWith("#") ? `# ${page.title}\n\n${page.markdown}` : page.markdown!;
            return {
              filename: webPageFilename(page.url, index, startUrl),
              mimeType: "text/markdown",
              // The same opaque ID /v1/uploads/url gives the same URL, so either path supersedes the other.
              canonicalId: opaqueCanonicalIdForUrl(page.url),
              // Refusals name the page by its position in the crawl, never its URL.
              refusalRef: { name: `pages[${index}]`, index },
              metadata: { sourceUrl: page.url, source: "website-crawl", crawlStartUrl: startUrl },
              content: { bytes: Buffer.from(body, "utf8") },
            };
          }),
          urls: [startUrl],
          audit,
        },
        ports,
        guard,
      );
      return actionResult(intake, {
        ingested: intake.documents.map((document) => ({ filename: document.filename, mimeType: document.mimeType })),
        pipeline: intake.pipeline,
        crawl: { startUrl, pages: pages.length, credits: crawled.credits },
      });
    },
  );
}

/** Multipart encodes the same tag array as JSON. Validate before storing files. */
export function parseFormDocumentTags(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { throw new ProjectIntakeError("tags must be a JSON array of strings", 422); }
  const parsed = documentTagsSchema.safeParse(value);
  if (!parsed.success) throw new ProjectIntakeError("Invalid tags", 422, parsed.error.issues.map((issue) => ({
    path: ["tags", ...issue.path].join("."), message: issue.message, code: issue.code,
  })));
  return parsed.data;
}
