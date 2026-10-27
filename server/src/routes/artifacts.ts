import { reportPublicError } from "../lib/public-errors.js";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { actorHasAnyApiKeyScope, getRequestActor } from "../lib/request-actor.js";
import { parseArtifactUri } from "../lib/artifacts.js";
import { buildArtifactPreview } from "../services/artifact-security.js";
import { userCanAccessArtifactUri } from "../services/documents.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";

const previewArtifactSchema = z.object({
  uri: z.string().min(1),
  kind: z.enum(["text", "markdown", "html", "json"]).default("text")
});

export const artifactsRoutes = new Hono()
  .use("*", async (c, next) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["artifacts"])) {
      return apiStatusError(c, 403, "Forbidden");
    }
    await next();
  })
  .get("/preview", zValidator("query", previewArtifactSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const { uri, kind } = c.req.valid("query");
    if (!parseArtifactUri(uri)) {
      return apiStatusError(c, 400, "Unsupported artifact URI");
    }
    if (!(await userCanAccessArtifactUri(uri, userId, c.get("apiKey")?.orgId))) {
      return apiStatusError(c, 404, "Artifact not found");
    }

    try {
      const preview = await buildArtifactPreview(uri, kind);
      return c.json(preview);
    } catch (error) {
      const message = reportPublicError(error);
      return apiStatusError(c, 400, message);
    }
  });

acceptApiKeys(artifactsRoutes);
