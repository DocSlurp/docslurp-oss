import { Hono } from "hono";
import { workspaceIngestVersion } from "@docslurp/shared";
import { acceptApiKeys } from "../lib/route-auth.js";

/**
 * GET /v1/ingest-version: the ingest version and capabilities this deployment produces (packages/shared/src/ingest-version.ts).
 * A build constant, the same for every organization; compare a document's `ingestVersion` with it to offer an update.
 */
export const ingestVersionRoutes = new Hono().get("/", (c) => {
  c.header("Cache-Control", "private, max-age=300");
  return c.json(workspaceIngestVersion());
});

acceptApiKeys(ingestVersionRoutes);
