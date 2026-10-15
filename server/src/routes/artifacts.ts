import { reportPublicError } from "../lib/public-errors.js";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { actorHasAnyApiKeyScope, getRequestActor } from "../lib/request-actor.js";
import { parseArtifactUri } from "../lib/artifacts.js";
import { fileUrlForArtifact } from "../lib/file-urls.js";
import { buildArtifactPreview } from "../services/artifact-security.js";
import { userCanAccessArtifactUri } from "../services/documents.js";
import { acceptApiKeys } from "../lib/route-auth.js";

const resolveArtifactSchema = z.object({
  uri: z.string().min(1)
});

const previewArtifactSchema = z.object({
  uri: z.string().min(1),
  kind: z.enum(["text", "markdown", "html", "json"]).default("text")
});

const resolveArtifactsSchema = z.object({
  uris: z.array(z.string().min(1)).min(1)
});

export const artifactsRoutes = new Hono()
  .use("*", async (c, next) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["artifacts"])) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  })
  .get("/preview", zValidator("query", previewArtifactSchema), async (c) => {
    const userId = c.get("sessionUser").id;
    const { uri, kind } = c.req.valid("query");
    if (!parseArtifactUri(uri)) {
      return c.json({ error: "Unsupported artifact URI" }, 400);
    }
    if (!(await userCanAccessArtifactUri(uri, userId, c.get("apiKey")?.orgId))) {
      return c.json({ error: "Artifact not found" }, 404);
    }

    try {
      const preview = await buildArtifactPreview(uri, kind);
      return c.json(preview);
    } catch (error) {
      const message = reportPublicError(error);
      return c.json({ error: message }, 400);
    }
  })
  .get("/resolve", zValidator("query", resolveArtifactSchema), async (c) => {
    const userId = c.get("sessionUser").id;
    const { uri } = c.req.valid("query");
    if (!parseArtifactUri(uri)) {
      return c.json({ error: "Unsupported artifact URI" }, 400);
    }
    if (!(await userCanAccessArtifactUri(uri, userId, c.get("apiKey")?.orgId))) {
      return c.json({ error: "Artifact not found" }, 404);
    }
    // A session/key-bound proxy URL, never a storage URL (lib/file-urls.ts).
    return c.json({ uri, ...fileUrlForArtifact(uri) });
  })
  .post("/resolve", zValidator("json", resolveArtifactsSchema), async (c) => {
    const userId = c.get("sessionUser").id;
    const { uris } = c.req.valid("json");
    if (uris.some((uri) => !parseArtifactUri(uri))) {
      return c.json({ error: "Unsupported artifact URI" }, 400);
    }
    const authorized = await Promise.all(uris.map(async (uri) => await userCanAccessArtifactUri(uri, userId, c.get("apiKey")?.orgId)));
    if (authorized.some((allowed) => !allowed)) {
      return c.json({ error: "Artifact not found" }, 404);
    }
    const resolved = uris.map((uri) => ({ uri, ...fileUrlForArtifact(uri) }));

    return c.json({ artifacts: resolved });
  });

acceptApiKeys(artifactsRoutes);
