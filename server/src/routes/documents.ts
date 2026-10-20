import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { documentTagsSchema } from "@docslurp/shared";
import { zValidator } from "@hono/zod-validator";

import { getArtifactJson } from "../lib/artifacts.js";
import {
  apiKeyHasAnyScope,
  assertApiKeyWorkspaceScope
} from "../lib/api-key-authorization.js";
import { getRequestActor, resolveActorWorkspaceFilter } from "../lib/request-actor.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import {
  getCorrectionWorkbench,
  listLowConfidenceReviewQueue,
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
  listDocumentsWithFilters,
  removeDocumentTags,
  setDocumentTags
} from "../services/documents.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { indexingModeErrorResponse } from "../lib/indexing-mode-error.js";
import { validationHook } from "../lib/validation.js";
import { deferredProfilesEnabled } from "@docslurp/shared";
import { getRun } from "../services/runs.js";
import { runLifecycle } from "../services/run-lifecycle.js";
import { resolveMaterializationPolicy } from "../services/materialization-policy.js";
import { getWorkspace } from "../services/workspaces.js";
import { IndexingModeError, requestFullIndex } from "../services/workspace-indexing-mode.js";

const bulkSchema = z.object({
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
    assertApiKeyWorkspaceScope(apiKey, viewer.document);
  } catch {
    return { response: apiStatusError(c, 404, "Document not found") };
  }
  return { viewer };
}

export const documentsRoutes = new Hono()
  .use("*", async (c, next) => {
    const apiKey = c.get("apiKey");
    if (!apiKey) {
      await next();
      return;
    }
    const fullIndexRequest = c.req.method === "POST" && /\/[^/]+\/full-index\/?$/.test(c.req.path);
    // Full index spends credits, so it needs ingest (like the workspace endpoint) instead of artifacts.
    if (!apiKeyHasAnyScope(apiKey, fullIndexRequest ? ["ingest"] : ["artifacts"])) {
      return apiStatusError(c, 403, "Forbidden");
    }
    if (c.req.method !== "GET" && !fullIndexRequest) {
      return apiStatusError(c, 403, "This endpoint requires a dashboard session or server-side document API");
    }
    await next();
  })
  .get("/", async (c) => {
    const userId = c.get("sessionUser").id;
    const apiKey = c.get("apiKey");
    const workspaceId = await resolveActorWorkspaceFilter(getRequestActor(c), c.req.query("workspaceId"), c.req.query("orgId"));
    const tagQuery = c.req.query("tags");
    const tags = tagQuery
      ? tagQuery.split(",").map((value) => value.trim()).filter(Boolean)
      : [];
    const documents = await listDocumentsWithFilters({
      userId,
      orgId: apiKey?.orgId ?? undefined,
      runId: c.req.query("runId") ?? undefined,
      workspaceId,
      tags
    });
    return c.json({ documents });
  })
  .post("/:documentId/full-index", async (c) => {
    if (!deferredProfilesEnabled()) return apiErrorResponse(c, 404, "not_found", "Not found");
    const userId = c.get("sessionUser").id;
    const viewer = await getDocumentViewerPayload(c.req.param("documentId"), userId);
    const workspace = viewer ? await getWorkspace(viewer.document.workspaceId, userId) : null;
    const apiKey = c.get("apiKey");
    if (!viewer || !workspace) return apiErrorResponse(c, 404, "not_found", "Document not found");
    if (apiKey) {
      try {
        assertApiKeyWorkspaceScope(apiKey, viewer.document);
      } catch {
        return apiErrorResponse(c, 404, "not_found", "Document not found");
      }
    }
    const resolved = await resolveMaterializationPolicy({
      workspacePipeline: workspace.pipeline,
      apiKey,
      capabilityHeader: c.req.header("X-DocSlurp-Capability"),
      origin: c.req.header("Origin"),
      workspaceId: workspace.id,
    });
    if ("error" in resolved) return apiErrorResponse(c, 403, "forbidden", "Invalid capability", { category: resolved.error });
    try {
      const result = await requestFullIndex({
        orgId: workspace.orgId,
        workspaceId: workspace.id,
        documentIds: [viewer.document.id],
        actor: getRequestActor(c),
        policy: resolved.policy,
      });
      const run = await getRun(result.runId, userId);
      if (run) await runLifecycle.start(run);
      return c.json({ runId: result.runId, pages: result.pages, estimatedCredits: result.estimatedCredits, billing: result.billing }, 202);
    } catch (error) {
      if (error instanceof IndexingModeError) return indexingModeErrorResponse(c, error);
      throw error;
    }
  })
  .get("/index", async (c) => {
    const userId = c.get("sessionUser").id;
    const apiKey = c.get("apiKey");
    const workspaceId = await resolveActorWorkspaceFilter(getRequestActor(c), c.req.query("workspaceId"), c.req.query("orgId"));
    const tagQuery = c.req.query("tags");
    const tags = tagQuery
      ? tagQuery.split(",").map((value) => value.trim()).filter(Boolean)
      : [];
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const result = await listDocumentIndexEntries({
      userId,
      orgId: apiKey?.orgId ?? c.req.query("orgId") ?? undefined,
      workspaceId,
      q: c.req.query("q") ?? undefined,
      tags,
      limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
      includeSuperseded: ["1", "true"].includes(c.req.query("includeSuperseded") ?? "")
    });
    return c.json(result);
  })
  .get("/review-queue", async (c) => {
    const userId = c.get("sessionUser").id;
    const sort = c.req.query("sort");
    const queue = await listLowConfidenceReviewQueue({
      userId,
      orgId: c.get("apiKey")?.orgId ?? undefined,
      runId: c.req.query("runId") ?? undefined,
      workspaceId: await resolveActorWorkspaceFilter(getRequestActor(c), c.req.query("workspaceId"), c.req.query("orgId")),
      sort:
        sort === "cost" || sort === "org" || sort === "failure-mode" || sort === "severity"
          ? sort
          : undefined
    });
    return c.json({ queue });
  })
  .delete("/:docId", async (c) => {
    const userId = c.get("sessionUser").id;
    const deleted = await deleteDocument(c.req.param("docId"), userId);

    if (!deleted) {
      return apiStatusError(c, 404, "Document not found");
    }

    await appendAuditLog({
      userId,
      action: "document.deleted",
      resourceType: "document",
      resourceId: deleted.documentId,
      ipAddress: requestIp(c),
      metadata: {
        filename: deleted.filename,
        workspaceId: deleted.workspaceId,
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

    return c.json(scoped.viewer);
  })
  .get("/:docId/structured", async (c) => {
    const userId = c.get("sessionUser").id;
    const scoped = await requireApiKeyDocumentScope(c, c.req.param("docId"), userId);
    if (scoped.response) return scoped.response;
    const viewer = scoped.viewer;
    const structuredUri = viewer.stages.find((stage) => stage.stage_name === "structured-extract")?.artifact_uri;
    if (!structuredUri) {
      return apiStatusError(c, 404, "No structured artifact for this document");
    }
    try {
      const json = await getArtifactJson<Record<string, unknown>>(structuredUri);
      return c.json({ structured: json, uri: structuredUri });
    } catch {
      return apiStatusError(c, 500, "Unable to read structured artifact");
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
    const changelog = await getDocumentVersionChangelog(c.req.param("docId"), userId);

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
    const tags = await setDocumentTags(c.req.param("docId"), userId, body.tags);

    if (tags === null) {
      return apiStatusError(c, 404, "Document not found");
    }

    await appendAuditLog({
      userId,
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

    if (body.action === "apply-tags") {
      const updated = await addDocumentTags(body.documentIds, userId, body.tags ?? []);
      await appendAuditLog({
        userId,
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

    const { runs, failed, warnings } = await bulkReprocessDocuments(body.documentIds, userId);
    await appendAuditLog({
      userId,
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
    return c.json({ runs, failed, warnings }, 201);
  });

// Reads only, plus full-index (policy-gated): the router guard above rejects other non-GET API key requests.
acceptApiKeys(documentsRoutes, [
  "POST /:documentId/full-index",
  "GET /",
  "GET /index",
  "GET /review-queue",
  "GET /:docId",
  "GET /:docId/structured",
  "GET /:docId/versions",
  "GET /:docId/changelog",
  "GET /:docId/correction-workbench",
]);
