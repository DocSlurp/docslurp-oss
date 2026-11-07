import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { documentExportRequestSchema } from "@docslurp/shared";

import { apiKeyCanUseProject, actorHasAnyApiKeyScope, getRequestActor, resolveActorProjectId } from "../lib/request-actor.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { validationHook } from "../lib/validation.js";
import { getProject } from "../services/projects.js";
import {
  DocumentExportError,
  findExportableDocument,
  getDocumentExport,
  listDocumentExports,
  requestDocumentExport,
  signDocumentExportDownload
} from "../services/document-exports.js";

/** Zip exports: queue, poll and download. The worker builds them (worker/src/exports). */
export const exportsRoutes = new Hono()
  .use("*", async (c, next) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["artifacts"]))) {
      return apiStatusError(c, 403, "Forbidden");
    }
    await next();
  })
  .post("/", zValidator("json", documentExportRequestSchema, validationHook), async (c) => {
    const actor = getRequestActor(c);
    const body = c.req.valid("json");
    try {
      if (body.documentId) {
        const document = await findExportableDocument(body.documentId, actor.userId);
        if (!document || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, { id: document.projectId, orgId: document.orgId }))) {
          return apiErrorResponse(c, 404, "not_found", "Document not found");
        }
        return c.json({ export: await requestDocumentExport({ userId: actor.userId, content: body.content, document }) }, 202);
      }
      const projectId = await resolveActorProjectId(actor, body.projectId ?? null).catch(() => null);
      const project = projectId ? await getProject(projectId, actor.userId) : null;
      if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) {
        return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      }
      return c.json({ export: await requestDocumentExport({ userId: actor.userId, content: body.content, project }) }, 202);
    } catch (error) {
      if (error instanceof DocumentExportError) return apiErrorResponse(c, error.status, error.code, error.message);
      throw error;
    }
  })
  .get("/", async (c) => {
    const actor = getRequestActor(c);
    const exports = await listDocumentExports(actor.userId, {
      allowProject: actor.type === "apiKey" ? (project) => apiKeyCanUseProject(actor.apiKey, project) : undefined,
    });
    return c.json({ exports });
  })
  .get("/:exportId", async (c) => {
    const actor = getRequestActor(c);
    const record = await getDocumentExport(c.req.param("exportId"), actor.userId);
    if (!record || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, { id: record.projectId, orgId: record.orgId }))) {
      return apiErrorResponse(c, 404, "not_found", "Export not found");
    }
    const { orgId: _orgId, ...exported } = record;
    return c.json({ export: exported });
  })
  .get("/:exportId/download", async (c) => {
    const actor = getRequestActor(c);
    const record = await getDocumentExport(c.req.param("exportId"), actor.userId);
    if (!record || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, { id: record.projectId, orgId: record.orgId }))) {
      return apiErrorResponse(c, 404, "not_found", "Export not found");
    }
    const url = record.status === "ready" ? await signDocumentExportDownload(record.id, actor.userId) : null;
    if (!url) {
      return record.status === "expired"
        ? apiErrorResponse(c, 404, "not_found", "This export's 7-day link has expired and the file was deleted. Export again to get a new link.")
        : apiErrorResponse(c, 409, "conflict", record.status === "failed" ? (record.error ?? "This export failed. Try again.") : "This export is still being prepared.");
    }
    c.header("cache-control", "private, no-store");
    // The signed link must not leak to the storage host's logs through a Referer.
    c.header("referrer-policy", "no-referrer");
    return c.redirect(url, 302);
  });

acceptApiKeys(exportsRoutes);
