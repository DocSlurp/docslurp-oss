import { quoteStoredDocuments } from "../services/stored-quote.js";
import { requestDocumentPageRender } from "../services/document-page-render.js";
import { isSpendBlockedError, spendBlockedResponse } from "../services/billing/spend-guard.js";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { compilePipelinePlan, dataUnavailable, documentTagsSchema, parseStoredPipelineFeatures, UNKNOWN_INGEST_VERSION } from "@docslurp/shared";
import { zValidator } from "@hono/zod-validator";

import { getArtifactJson } from "../lib/artifacts.js";
import {
  apiKeyHasAnyScope,
  assertApiKeyProjectScope
} from "../lib/api-key-authorization.js";
import { getRequestActor, isPlatformAdminActor, resolveActorProjectFilter } from "../lib/request-actor.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import { requestDocumentFigureResume } from "../services/figure-resume.js";
import {
  getCorrectionWorkbench,
  reindexDocumentCorrection,
  saveDocumentCorrection
} from "../services/document-review.js";
import {
  addDocumentTags,
  bulkReprocessDocuments,
  deleteDocument,
  deleteDocuments,
  exportDocumentArtifacts,
  getDocumentVersionChangelog,
  getDocumentVersionsWithTags,
  getDocumentViewerPayload,
  listDocumentIndexEntries,
  listDocumentOwners,
  listDocumentsWithFilters,
  removeDocumentTags,
  setDocumentTags
} from "../services/documents.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { parseListLimit } from "../lib/list-cursor.js";
import { isReprocessRejectedError } from "../services/reprocess-errors.js";
import { reportPublicError } from "../lib/public-errors.js";
import { indexingModeErrorResponse } from "../lib/indexing-mode-error.js";
import { validationHook } from "../lib/validation.js";
import { deferredProfilesEnabled } from "@docslurp/shared";
import { getRun } from "../services/runs.js";
import { runLifecycle } from "../services/run-lifecycle.js";
import { resolveMaterializationPolicy } from "../services/materialization-policy.js";
import { getProject } from "../services/projects.js";
import { canEditProject, getProjectAccess } from "../services/organizations.js";
import { estimateFullIndex, IndexingModeError, requestFullIndex } from "../services/project-indexing-mode.js";
import { inlineEstimate, jobMetaFor, jobStatusForMutation, recordJobMeta } from "../services/jobs.js";
import { billingState } from "../services/config-change.js";
import { estimateDocumentReprocess, singleProjectOf } from "../services/work-estimates.js";
import { apiKeyCanUpdateContent, CONTENT_UPDATE_SCOPE_MESSAGE } from "../lib/content-update-access.js";
import { callerCanReprocess, denyReprocessOfVisible } from "../lib/reprocess-access.js";
import { sql } from "../db.js";
import { withheldArtifactUrisFromMetadata } from "../services/pii-artifact-guard.js";
import { apiKeyCanUseProject } from "../lib/api-key-project-scope.js";
import { DocumentAssetQueryError, getDocumentAssetLedger } from "../services/document-assets.js";
import { redactOperatorRun } from "../services/progress-snapshot.js";

const bulkSchema = z.object({
  speedBoost: z.boolean().optional(),
  action: z.enum(["reprocess", "export-artifacts", "apply-tags", "remove-tags", "delete"]),
  documentIds: z.array(z.string()).min(1),
  tags: documentTagsSchema.optional()
});

const setTagsSchema = z.object({
  tags: documentTagsSchema.default([])
});

const saveCorrectionSchema = z.object({
  markdown: z.string().nullable().optional(),
  structuredData: z.record(z.string(), z.unknown()).nullable().optional(),
  notes: z.string().nullable().optional(),
  tags: documentTagsSchema.optional()
});

const reindexCorrectionSchema = z.object({});

async function requireApiKeyDocumentScope(c: Context, docId: string, userId: string) {
  const apiKey = c.get("apiKey");
  const viewer = await getDocumentViewerPayload(docId, userId);
  if (!viewer) {
    return { response: apiStatusError(c, 404, "Document not found") };
  }
  try {
    assertApiKeyProjectScope(apiKey, viewer.document);
  } catch {
    return { response: apiStatusError(c, 404, "Document not found") };
  }
  return { viewer };
}

/** Whether the project's current pipeline runs structured extraction (a non-empty `outputSchema`; compilePipelinePlan). */
async function projectExtractsStructured(projectId: string): Promise<boolean> {
  const [row] = await sql<{ pipeline: unknown }[]>`select pipeline from projects where id = ${projectId}`;
  if (!row) return false;
  return compilePipelinePlan(parseStoredPipelineFeatures(row.pipeline, `project ${projectId}`)).stageOrder.includes("structured-extract");
}

/** Whether the document's PII policy withheld this exact structured result (metadata.pii.withheldArtifactUris). */
async function structuredResultWithheld(documentId: string, uri: string): Promise<boolean> {
  const [row] = await sql<{ metadata: unknown }[]>`select metadata from documents where id = ${documentId}`;
  return !row || withheldArtifactUrisFromMetadata(row.metadata).has(uri);
}

/** Document changes a server key with `ingest` may make: delete, retag and bulk reprocess/retag/delete. */
function isContentUpdateRequest(method: string, path: string): boolean {
  if (method === "DELETE") return /\/documents\/[^/]+\/?$/.test(path);
  if (method === "PUT") return /\/documents\/[^/]+\/tags\/?$/.test(path);
  // Queueing a figure resume changes stored content (new figure files), like the other content updates.
  return method === "POST" && (/\/documents\/bulk\/?$/.test(path) || /\/documents\/[^/]+\/assets\/resume\/?$/.test(path));
}

/**
 * For an API key, every listed document must exist in a project the key can
 * use; anything else answers 404 like a missing document, before any change.
 */
async function denyOutOfScopeDocuments(c: Context, documentIds: string[], userId: string): Promise<Response | null> {
  const apiKey = c.get("apiKey");
  if (!apiKey) return null;
  const owners = await listDocumentOwners([...new Set(documentIds)], userId);
  const usable = new Set(owners.filter((owner) => apiKeyCanUseProject(apiKey, owner)).map((owner) => owner.id));
  return documentIds.every((id) => usable.has(id)) ? null : apiStatusError(c, 404, "Document not found");
}

export const documentsRoutes = new Hono()
  .use("*", async (c, next) => {
    const apiKey = c.get("apiKey");
    if (!apiKey) {
      await next();
      return;
    }
    const fullIndexRequest = c.req.method === "POST" && /\/[^/]+\/full-index(\/estimate)?\/?$/.test(c.req.path);
    if (isContentUpdateRequest(c.req.method, c.req.path)) {
      // Bulk artifact export is a read; the other bulk actions change content.
      const body = c.req.method === "POST" ? await c.req.raw.clone().json().catch(() => null) as { action?: unknown } | null : null;
      const allowed = body?.action === "export-artifacts"
        ? apiKeyHasAnyScope(apiKey, ["artifacts"])
        : apiKeyCanUpdateContent(apiKey);
      if (!allowed) return apiStatusError(c, 403, body?.action === "export-artifacts" ? "Forbidden" : CONTENT_UPDATE_SCOPE_MESSAGE);
      await next();
      return;
    }
    // Full index spends credits, so it needs ingest (like the project endpoint) instead of artifacts.
    if (!apiKeyHasAnyScope(apiKey, fullIndexRequest ? ["ingest"] : ["artifacts"])) {
      return apiStatusError(c, 403, "Forbidden");
    }
    if (c.req.method !== "GET" && !fullIndexRequest) {
      return apiStatusError(c, 403, "This endpoint requires a dashboard session or a server API key with the ingest scope");
    }
    await next();
  })
  .on(["GET", "POST"],"/:documentId/pages/:pageNumber/image", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const quality = c.req.query("quality") ?? "reader";
    if (quality !== "reader" && quality !== "export") return apiStatusError(c, 400, "Invalid image quality");
    const raw = c.req.param("pageNumber");
    if (!/^[1-9][0-9]{0,5}$/.test(raw)) return apiStatusError(c, 404, "Document page not found");
    try {
      const result = await requestDocumentPageRender(c.req.param("documentId"), Number(raw), c.get("sessionUser").id, c.req.method === "POST",
        document => assertApiKeyProjectScope(c.get("apiKey"), document), quality);
      if (result.status === "busy") { c.header("Retry-After", "5"); return apiStatusError(c, 429, "Page image queue is busy"); }
      if (result.status === "missing") return apiStatusError(c, 404, "Document page not found");
      // An expected partial-data state, not an error: a typed 200 the client shows calmly (ingest-version.ts). The
      // refusal itself is unchanged; a document without a current parse decision is never rendered.
      if (result.status === "unavailable" || result.status === "rescan-required") {
        const reason = result.status === "rescan-required" ? "needs-reprocess" : result.reason;
        console.info(`[page-render] status=unavailable reason=${reason} metric=page_render_unavailable document=${result.document.id} page=${raw}`);
        return c.json(dataUnavailable(reason, {
          canEdit: await callerCanReprocess(c, result.document),
          ingestVersion: result.document.ingestVersion ?? UNKNOWN_INGEST_VERSION,
        }));
      }
      if (result.status === "pending") { c.header("Retry-After", "2"); return c.json(result, 202); }
      return c.json(result);
    } catch (error) {
      if (isSpendBlockedError(error)) return spendBlockedResponse(c, error);
      // Scoped keys get the same response as a nonexistent document.
      if (c.get("apiKey")) return apiStatusError(c, 404, "Document page not found");
      throw error;
    }
  })
  .get("/", async (c) => {
    const userId = c.get("sessionUser").id;
    const apiKey = c.get("apiKey");
    const projectId = await resolveActorProjectFilter(getRequestActor(c), c.req.query("project"), c.req.query("orgId"));
    const tagQuery = c.req.query("tags");
    const tags = tagQuery
      ? tagQuery.split(",").map((value) => value.trim()).filter(Boolean)
      : [];
    // `limit` (1-250, default 250) and the `cursor` from the previous page's nextCursor page the list.
    const page = await listDocumentsWithFilters({
      userId,
      orgId: apiKey?.orgId ?? undefined,
      runId: c.req.query("runId") ?? undefined,
      projectId,
      tags,
      limit: parseListLimit(c.req.query("limit"), 250, 250),
      cursor: c.req.query("cursor") || undefined,
    });
    return c.json(page);
  })
  .post("/:documentId/full-index", zValidator("json", z.object({ speedBoost: z.boolean().optional() }).default({}), validationHook), async (c) => {
    if (!deferredProfilesEnabled()) return apiErrorResponse(c, 404, "not_found", "Not found");
    const userId = c.get("sessionUser").id;
    const viewer = await getDocumentViewerPayload(c.req.param("documentId"), userId);
    const project = viewer ? await getProject(viewer.document.projectId, userId) : null;
    const apiKey = c.get("apiKey");
    if (!viewer || !project) return apiErrorResponse(c, 404, "not_found", "Document not found");
    if (apiKey) {
      try {
        assertApiKeyProjectScope(apiKey, viewer.document);
      } catch {
        return apiErrorResponse(c, 404, "not_found", "Document not found");
      }
    }
    // Spends credits: editors only (callerCanReprocess); a document the caller sees but may not edit is a 403.
    const deniedFullIndex = await denyReprocessOfVisible(c, [viewer.document]);
    if (deniedFullIndex) return deniedFullIndex;
    const resolved = await resolveMaterializationPolicy({
      projectPipeline: project.pipeline,
      apiKey,
      capabilityHeader: c.req.header("X-DocSlurp-Capability"),
      origin: c.req.header("Origin"),
      projectId: project.id,
    });
    if ("error" in resolved) return apiErrorResponse(c, 403, "forbidden", "Invalid capability", { category: resolved.error });
    try {
      const inline = await inlineEstimate(
        () => estimateFullIndex({ speedBoost: c.req.valid("json").speedBoost === true, projectId: project.id, orgId: project.orgId, documentIds: [viewer.document.id] }),
        `/v1/documents/${viewer.document.id}/full-index/estimate`,
      );
      const result = await requestFullIndex({
        speedBoost: c.req.valid("json").speedBoost === true,
        orgId: project.orgId,
        projectId: project.id,
        documentIds: [viewer.document.id],
        actor: getRequestActor(c),
        policy: resolved.policy,
      });
      const meta = jobMetaFor(result.runId, "full-index", inline);
      await recordJobMeta([result.runId], meta);
      const run = await getRun(result.runId, userId);
      if (run) await runLifecycle.start(run);
      const job = await jobStatusForMutation(meta, [result.runId], userId);
      return c.json({ runId: result.runId, pages: result.pages, estimatedCredits: result.estimatedCredits, billing: result.billing, job }, 202);
    } catch (error) {
      if (error instanceof IndexingModeError) return indexingModeErrorResponse(c, error);
      throw error;
    }
  })
  .post("/:documentId/full-index/estimate", zValidator("json", z.object({ speedBoost: z.boolean().optional() }).default({}), validationHook), async (c) => {
    if (!deferredProfilesEnabled()) return apiErrorResponse(c, 404, "not_found", "Not found");
    const userId = c.get("sessionUser").id;
    const viewer = await getDocumentViewerPayload(c.req.param("documentId"), userId);
    const project = viewer ? await getProject(viewer.document.projectId, userId) : null;
    const apiKey = c.get("apiKey");
    if (!viewer || !project) return apiErrorResponse(c, 404, "not_found", "Document not found");
    if (apiKey) {
      try {
        assertApiKeyProjectScope(apiKey, viewer.document);
      } catch {
        return apiErrorResponse(c, 404, "not_found", "Document not found");
      }
    }
    const resolved = await resolveMaterializationPolicy({
      projectPipeline: project.pipeline,
      apiKey,
      capabilityHeader: c.req.header("X-DocSlurp-Capability"),
      origin: c.req.header("Origin"),
      projectId: project.id,
    });
    if ("error" in resolved) return apiErrorResponse(c, 403, "forbidden", "Invalid capability", { category: resolved.error });
    if (!resolved.policy.allowFullIndexRequest) {
      return apiErrorResponse(c, 403, "forbidden", "This key or capability may not request a full index.", { category: "full_index_not_allowed" });
    }
    const deniedEstimate = await denyReprocessOfVisible(c, [viewer.document]);
    if (deniedEstimate) return deniedEstimate;
    const estimate = await estimateFullIndex({ speedBoost: c.req.valid("json").speedBoost === true, projectId: project.id, orgId: project.orgId, documentIds: [viewer.document.id] });
    const quote = estimate
      ? await quoteStoredDocuments({ scope: { orgId: project.orgId, projectId: project.id, documentIds: [viewer.document.id] }, pipeline: project.pipeline, estimate, settings: { indexing: "full" } })
      : null;
    return c.json({ estimate, quote, billing: billingState() });
  })
  .get("/index", async (c) => {
    const userId = c.get("sessionUser").id;
    const apiKey = c.get("apiKey");
    const projectId = await resolveActorProjectFilter(getRequestActor(c), c.req.query("project"), c.req.query("orgId"));
    const tagQuery = c.req.query("tags");
    const tags = tagQuery
      ? tagQuery.split(",").map((value) => value.trim()).filter(Boolean)
      : [];
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const result = await listDocumentIndexEntries({
      userId,
      orgId: apiKey?.orgId ?? c.req.query("orgId") ?? undefined,
      projectId,
      q: c.req.query("q") ?? undefined,
      tags,
      limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
      includeSuperseded: ["1", "true"].includes(c.req.query("includeSuperseded") ?? "")
    });
    return c.json(result);
  })
  .delete("/:docId", async (c) => {
    const userId = c.get("sessionUser").id;
    const denied = await denyOutOfScopeDocuments(c, [c.req.param("docId")], userId);
    if (denied) return denied;
    let deleted;
    try {
      deleted = await deleteDocument(c.req.param("docId"), userId);
    } catch (error) {
      // Deleting a document whose run is still processing races the pipeline and
      // hits a foreign-key violation (the run's rows still reference it). Answer
      // 409 so clients retry; every other failure keeps its 500 contract.
      // Security finding SEC-2026-10-PROD-06 (regressed in the merge).
      if ((error as { code?: string } | null)?.code === "23503") {
        reportPublicError(error, { surface: "documents.delete" });
        return apiErrorResponse(c, 409, "conflict", "The document is still being processed by a run. Try again shortly.");
      }
      throw error;
    }

    if (!deleted) {
      return apiStatusError(c, 404, "Document not found");
    }

    await appendAuditLog({
      userId,
      apiKeyId: c.get("apiKey")?.keyId ?? null,
      action: "document.deleted",
      resourceType: "document",
      resourceId: deleted.documentId,
      ipAddress: requestIp(c),
      metadata: {
        filename: deleted.filename,
        projectId: deleted.projectId,
        runId: deleted.runId,
        sourceKey: deleted.sourceKey,
        userAgent: requestUserAgent(c)
      }
    });

    return c.json(deleted);
  })
  .get("/:docId", async (c) => {
    const userId = c.get("sessionUser").id;
    const scoped = await requireApiKeyDocumentScope(c, c.req.param("docId"), userId);
    if (scoped.response) return scoped.response;
    const viewer = scoped.viewer;
    // Whether this caller may act on "update available" (an editor session, or a server key with ingest for the project).
    const canReprocess = (viewer.ingest.updateAvailable || viewer.ingest.updateRecommended) && await callerCanReprocess(c, viewer.document);
    return c.json({ ...viewer, ingest: { ...viewer.ingest, canReprocess } });
  })
  // The asset ledger: every image Doppler reported (extracted, not extracted with why, unlinked) and the extraction level,
  // one keyset page at a time (`limit`, `after`, `pageFrom`, `pageTo`). Same gate as the document detail: the caller must
  // reach the document's project; an API key also needs `artifacts` (middleware above) and a project it may use. A
  // document the viewer is not shown (not completed, purged) or any other miss is the same 404 as a missing document.
  .get("/:docId/assets", async (c) => {
    const userId = c.get("sessionUser").id;
    const docId = c.req.param("docId");
    const apiKey = c.get("apiKey");
    const integer = (name: string): number | undefined | null => {
      const raw = c.req.query(name);
      if (raw === undefined) return undefined;
      return /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : null;
    };
    const limit = integer("limit");
    const pageFrom = integer("pageFrom");
    const pageTo = integer("pageTo");
    const after = c.req.query("after");
    if (limit === null || pageFrom === null || pageTo === null) return apiStatusError(c, 400, "Invalid asset page parameters");
    const [owner] = await listDocumentOwners([docId], userId);
    if (!owner || (apiKey && !apiKeyCanUseProject(apiKey, owner))) return apiStatusError(c, 404, "Document not found");
    let ledger;
    try {
      ledger = await getDocumentAssetLedger({ orgId: owner.orgId, projectId: owner.projectId, documentId: docId }, {
        ...(limit === undefined ? {} : { limit }), ...(after === undefined ? {} : { after }),
        ...(pageFrom === undefined ? {} : { pageFrom }), ...(pageTo === undefined ? {} : { pageTo }),
      }, { canEdit: await callerCanReprocess(c, owner) });
    } catch (error) {
      if (error instanceof DocumentAssetQueryError) return apiStatusError(c, 400, "Invalid asset page parameters");
      throw error;
    }
    if (!ledger) return apiStatusError(c, 404, "Document not found");
    return c.json(ledger);
  })
  // Finish the figures a pass left resumable (figure-resume.ts): only queues, under the runner's own caps. Server keys
  // with `ingest` or a session that may edit the project; anything outside the caller's scope is the same 404.
  .post("/:docId/assets/resume", async (c) => {
    const userId = c.get("sessionUser").id;
    const docId = c.req.param("docId");
    const apiKey = c.get("apiKey");
    if (apiKey && !apiKeyCanUpdateContent(apiKey)) return apiStatusError(c, 403, CONTENT_UPDATE_SCOPE_MESSAGE);
    const [owner] = await listDocumentOwners([docId], userId);
    if (!owner || (apiKey && !apiKeyCanUseProject(apiKey, owner))) return apiStatusError(c, 404, "Document not found");
    const deniedResume = await denyReprocessOfVisible(c, [owner]);
    if (deniedResume) return deniedResume;
    const status = await requestDocumentFigureResume({ orgId: owner.orgId, projectId: owner.projectId, documentId: docId });
    await appendAuditLog({
      orgId: owner.orgId, userId, projectId: owner.projectId, documentId: docId, apiKeyId: apiKey?.keyId ?? null,
      action: "document.figures.resume_requested", resourceType: "document", resourceId: docId, ipAddress: requestIp(c),
      metadata: { status, userAgent: requestUserAgent(c) },
    });
    return c.json({ documentId: docId, status }, status === "queued" || status === "already-queued" ? 202 : 200);
  })
  .get("/:docId/structured", async (c) => {
    const userId = c.get("sessionUser").id;
    const scoped = await requireApiKeyDocumentScope(c, c.req.param("docId"), userId);
    if (scoped.response) return scoped.response;
    const viewer = scoped.viewer;
    const structuredUri = viewer.stages.find((stage) => stage.stage_name === "structured-extract")?.artifact_uri;
    const ingestVersion = viewer.document.ingestVersion ?? UNKNOWN_INGEST_VERSION;
    // PII: a blocked document's fields, or a result its policy withheld, are never served, whatever the stage recorded.
    if (viewer.document.status === "pii_blocked" || (structuredUri && await structuredResultWithheld(viewer.document.id, structuredUri))) {
      return c.json({ structured: null, uri: null, availability: dataUnavailable("withheld", { ingestVersion }) });
    }
    if (!structuredUri) {
      const finished = viewer.document.status === "completed" || viewer.document.status === "failed" || viewer.document.status === "cancelled";
      // Nothing recorded and the project has no schema: the feature is off, and a reprocess would not produce fields.
      const reason = !(await projectExtractsStructured(viewer.document.projectId)) ? "disabled"
        : finished ? "not-extracted" : "processing";
      const canEdit = reason === "not-extracted" && await callerCanReprocess(c, viewer.document);
      return c.json({ structured: null, uri: null, availability: dataUnavailable(reason, { canEdit, ingestVersion }) });
    }
    try {
      const json = await getArtifactJson<Record<string, unknown>>(structuredUri);
      return c.json({ structured: json, uri: structuredUri });
    } catch (error) {
      // Raw storage errors go to telemetry only; the caller gets a stable, retryable state.
      console.warn(`[documents] status=structured-unreadable metric=structured_artifact_unreadable document=${viewer.document.id} error=${JSON.stringify(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      return c.json({ structured: null, uri: null, availability: dataUnavailable("temporarily-unavailable", { ingestVersion }) });
    }
  })
  .get("/:docId/versions", async (c) => {
    const userId = c.get("sessionUser").id;
    const scoped = await requireApiKeyDocumentScope(c, c.req.param("docId"), userId);
    if (scoped.response) return scoped.response;
    const versions = await getDocumentVersionsWithTags(c.req.param("docId"), userId);

    if (versions.length === 0) {
      return apiStatusError(c, 404, "Document not found");
    }

    return c.json({ versions });
  })
  .get("/:docId/changelog", async (c) => {
    const userId = c.get("sessionUser").id;
    const scoped = await requireApiKeyDocumentScope(c, c.req.param("docId"), userId);
    if (scoped.response) return scoped.response;
    const changelog = await getDocumentVersionChangelog(c.req.param("docId"), userId, c.req.query("baseline") ?? null);

    if (!changelog) {
      return apiStatusError(c, 404, "Document not found");
    }

    return c.json({
      documentId: c.req.param("docId"),
      changelog
    });
  })
  .get("/:docId/correction-workbench", async (c) => {
    const userId = c.get("sessionUser").id;
    const scoped = await requireApiKeyDocumentScope(c, c.req.param("docId"), userId);
    if (scoped.response) return scoped.response;
    const payload = await getCorrectionWorkbench(c.req.param("docId"), userId);

    if (!payload) {
      return apiStatusError(c, 404, "Document not found");
    }

    return c.json(payload);
  })
  .put("/:docId/correction-workbench", zValidator("json", saveCorrectionSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    const payload = await saveDocumentCorrection({
      docId: c.req.param("docId"),
      userId,
      markdown: body.markdown,
      structuredData: body.structuredData,
      notes: body.notes,
      tags: body.tags
    });

    if (!payload) {
      return apiStatusError(c, 404, "Document not found");
    }

    await appendAuditLog({
      userId,
      documentId: c.req.param("docId"),
      action: "document.correction.saved",
      resourceType: "document",
      resourceId: c.req.param("docId"),
      ipAddress: requestIp(c),
      metadata: {
        hasMarkdown: typeof body.markdown === "string",
        hasStructuredData: body.structuredData !== null && body.structuredData !== undefined,
        profileKey: payload.profile.profileKey,
        profileExampleCount: payload.profile.examples.length,
        profileSignalCount: payload.profile.correctionPatterns.length,
        tagCount: body.tags?.length ?? 0,
        userAgent: requestUserAgent(c)
      }
    });

    return c.json(payload);
  })
  .post("/:docId/correction-workbench/reindex", zValidator("json", reindexCorrectionSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    // Re-embeds the document (paid): editors only. A document outside the caller's reach is the same 404 as a missing one.
    const [correctionOwner] = await listDocumentOwners([c.req.param("docId")], userId);
    if (!correctionOwner || (c.get("apiKey") && !apiKeyCanUseProject(c.get("apiKey"), correctionOwner))) return apiStatusError(c, 404, "Correction not found");
    const deniedReindex = await denyReprocessOfVisible(c, [correctionOwner]);
    if (deniedReindex) return deniedReindex;
    const result = await reindexDocumentCorrection({
      docId: c.req.param("docId"),
      userId
    });

    if (!result) {
      return apiStatusError(c, 404, "Correction not found");
    }

    await appendAuditLog({
      userId,
      documentId: c.req.param("docId"),
      action: "document.correction.reindexed",
      resourceType: "document",
      resourceId: c.req.param("docId"),
      ipAddress: requestIp(c),
      metadata: {
        pageCount: result.pageCount,
        chunkCount: result.chunkCount,
        profileKey: result.profileKey,
        signalKeys: result.signalKeys,
        userAgent: requestUserAgent(c)
      }
    });

    return c.json(result);
  })
  .put("/:docId/tags", zValidator("json", setTagsSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    const denied = await denyOutOfScopeDocuments(c, [c.req.param("docId")], userId);
    if (denied) return denied;
    const tags = await setDocumentTags(c.req.param("docId"), userId, body.tags);

    if (tags === null) {
      return apiStatusError(c, 404, "Document not found");
    }

    await appendAuditLog({
      userId,
      apiKeyId: c.get("apiKey")?.keyId ?? null,
      documentId: c.req.param("docId"),
      action: "document.tags.updated",
      resourceType: "document",
      resourceId: c.req.param("docId"),
      ipAddress: requestIp(c),
      metadata: {
        tags,
        userAgent: requestUserAgent(c)
      }
    });

    return c.json({ documentId: c.req.param("docId"), tags });
  })
  .post("/bulk", zValidator("json", bulkSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    const denied = await denyOutOfScopeDocuments(c, body.documentIds, userId);
    if (denied) return denied;
    const apiKeyId = c.get("apiKey")?.keyId ?? null;

    if (body.action === "apply-tags") {
      const updated = await addDocumentTags(body.documentIds, userId, body.tags ?? []);
      await appendAuditLog({
        userId,
        apiKeyId,
        action: "documents.tags.bulk_applied",
        resourceType: "document-bulk",
        resourceId: body.documentIds.join(","),
        ipAddress: requestIp(c),
        metadata: {
          count: body.documentIds.length,
          tags: body.tags ?? [],
          userAgent: requestUserAgent(c)
        }
      });
      return c.json({ updated, documentIds: body.documentIds });
    }

    if (body.action === "remove-tags") {
      const updated = await removeDocumentTags(body.documentIds, userId, body.tags ?? []);
      await appendAuditLog({
        userId,
        apiKeyId,
        action: "documents.tags.bulk_removed",
        resourceType: "document-bulk",
        resourceId: body.documentIds.join(","),
        ipAddress: requestIp(c),
        metadata: {
          count: body.documentIds.length,
          tags: body.tags ?? [],
          userAgent: requestUserAgent(c)
        }
      });
      return c.json({ updated, documentIds: body.documentIds });
    }

    if (body.action === "delete") {
      const deleted = await deleteDocuments(body.documentIds, userId);
      await appendAuditLog({
        userId,
        apiKeyId,
        action: "documents.deleted",
        resourceType: "document-bulk",
        resourceId: body.documentIds.join(","),
        ipAddress: requestIp(c),
        metadata: {
          count: deleted,
          userAgent: requestUserAgent(c)
        }
      });
      return c.json({ deleted, documentIds: body.documentIds });
    }

    if (body.action === "export-artifacts") {
      const artifacts = await exportDocumentArtifacts(body.documentIds, userId);
      return c.json({ artifacts });
    }

    // Reprocess spends credits: every document must be reachable (else the same 404 as a missing one) and the caller must
    // be allowed to reprocess each one's project (else 403), before any estimate or run.
    const reprocessIds = [...new Set(body.documentIds)];
    const reprocessOwners = (await listDocumentOwners(reprocessIds, userId))
      .filter((owner) => !apiKeyId || apiKeyCanUseProject(c.get("apiKey"), owner));
    if (reprocessOwners.length !== reprocessIds.length) return apiStatusError(c, 404, "Document not found");
    const deniedBulk = await denyReprocessOfVisible(c, reprocessOwners);
    if (deniedBulk) return deniedBulk;

    // Same selection as the project-scoped twin when the documents live in one project.
    const bulkProjectId = await singleProjectOf(body.documentIds, userId);
    const bulkInline = await inlineEstimate(
      () => estimateDocumentReprocess({ documentIds: body.documentIds, userId, speedBoost: body.speedBoost === true, ...(bulkProjectId ? { projectId: bulkProjectId } : {}) }),
      `/v1/projects/${bulkProjectId ?? "{projectId}"}/documents/bulk/estimate`,
    );
    let bulk: Awaited<ReturnType<typeof bulkReprocessDocuments>>;
    try {
      bulk = await bulkReprocessDocuments(body.documentIds, userId, { speedBoost: body.speedBoost === true });
    } catch (error) {
      if (isReprocessRejectedError(error)) return apiStatusError(c, error.statusCode, error.message, { code: error.code, details: error.details });
      // Every group refused (for example Fast with visual indexing); a partial refusal is reported in `failed`.
      if (error instanceof IndexingModeError) return indexingModeErrorResponse(c, error);
      throw error;
    }
    const { runs, failed, warnings } = bulk;
    await appendAuditLog({
      userId,
      apiKeyId,
      action: "documents.bulk_reprocessed",
      resourceType: "document-bulk",
      resourceId: body.documentIds.join(","),
      ipAddress: requestIp(c),
      metadata: {
        count: body.documentIds.length,
        runs: runs.map((run) => run.id),
        failedDocuments: failed.reduce((total, group) => total + group.documentIds.length, 0),
        userAgent: requestUserAgent(c)
      }
    });
    const job = runs.length > 0
      ? await (async () => {
          const meta = jobMetaFor(runs[0]!.id, "reprocess", bulkInline);
          await recordJobMeta(runs.map((run) => run.id), meta);
          return await jobStatusForMutation(meta, runs.map((run) => run.id), userId);
        })()
      : null;
    // Created runs as customers read them (no managed model fields or model keys), as on GET /v1/runs.
    const operator = await isPlatformAdminActor(getRequestActor(c));
    return c.json({ runs: operator ? runs : runs.map((run) => redactOperatorRun(run)), failed, warnings, ...(job ? { job } : {}) }, 201);
  });

// Reads, full-index (policy-gated) and content updates (server keys with ingest); the router guard above rejects other API key writes.
acceptApiKeys(documentsRoutes, [
  "DELETE /:docId",
  "PUT /:docId/tags",
  "POST /bulk",
  "POST /:documentId/full-index",
  "POST /:documentId/full-index/estimate",
  "GET /",
  "GET /index",
  "GET /:docId",
  "GET /:docId/structured",
  "GET /:docId/versions",
  "GET /:docId/changelog",
  "GET /:docId/correction-workbench",
]);
