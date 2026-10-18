import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { env } from "../config.js";
import { requireApiKey, resolveActorWorkspaceFilter } from "../lib/request-actor.js";
import type { ValidatedKey } from "../services/api-keys.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import {
  approveAutomationOperation,
  getAutomationCapabilityManifest,
  getAutomationOperation,
  getAutomationOperationEvents,
  getAutomationUsage
} from "../services/automation.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiStatusError } from "../lib/api-error.js";

function routeBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return env.apiUrl;
  }
}

async function streamOperation(c: Parameters<typeof streamSSE>[0], args: { operationId: string; userId: string; apiKey: ValidatedKey }) {
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    let afterSequence = 0;

    while (!stream.aborted) {
      const events = await getAutomationOperationEvents({
        operationId: args.operationId,
        afterSequence
      });

      for (const event of events) {
        afterSequence = event.sequence;
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event)
        });
      }

      const operation = await getAutomationOperation({
        operationId: args.operationId,
        userId: args.userId,
        apiKey: args.apiKey
      });

      if (!operation) {
        await stream.writeSSE({
          event: "failed",
          data: JSON.stringify({ error: "Operation not found." })
        });
        break;
      }

      if (operation.status === "completed" || operation.status === "failed" || operation.status === "cancelled") {
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ operation })
        });
        break;
      }

      if (!stream.aborted) {
        await stream.sleep(env.aiOperationPollIntervalMs);
      }
    }
  });
}

export const aiRoutes = new Hono()
  .use("*", apiKeyAuth)
  .get("/capabilities", async (c) => {
    const manifest = getAutomationCapabilityManifest(routeBaseUrl(c.req.url));
    const apiKey = requireApiKey(c);
    const visibleTools = manifest.capabilities.filter((capability) =>
      capability.auth.scopes.length === 0 || capability.auth.scopes.some((scope) => apiKey.scopes.includes(scope))
    );

    return c.json({
      ...manifest,
      capabilities: visibleTools
    });
  })
  .get("/usage", async (c) => {
    const apiKey = requireApiKey(c);
    const workspaceId = await resolveActorWorkspaceFilter(
      { type: "apiKey", userId: apiKey.userId, apiKey },
      c.req.query("workspaceId"),
    );
    const usage = await getAutomationUsage({
      userId: apiKey.userId,
      workspaceId,
      orgId: apiKey.orgId ?? undefined
    });

    return c.json({ usage });
  })
  .get("/operations/:id", async (c) => {
    const apiKey = requireApiKey(c);
    const operation = await getAutomationOperation({
      operationId: c.req.param("id"),
      userId: apiKey.userId,
      apiKey
    });

    if (!operation) {
      return apiStatusError(c, 404, "Operation not found");
    }

    const events = await getAutomationOperationEvents({
      operationId: operation.id
    });

    return c.json({ operation, events });
  })
  .get("/operations/:id/stream", async (c) => {
    const apiKey = requireApiKey(c);
    const operation = await getAutomationOperation({
      operationId: c.req.param("id"),
      userId: apiKey.userId,
      apiKey
    });

    if (!operation) {
      return apiStatusError(c, 404, "Operation not found");
    }

    return await streamOperation(c, {
      operationId: operation.id,
      userId: apiKey.userId,
      apiKey
    });
  })
  .post("/operations/:id/approve", async (c) => {
    const apiKey = requireApiKey(c);
    const operation = await approveAutomationOperation({
      operationId: c.req.param("id"),
      userId: apiKey.userId,
      apiKey
    });

    if (!operation) {
      return apiStatusError(c, 404, "Operation not found");
    }

    return c.json({ operation });
  });

acceptApiKeys(aiRoutes);
