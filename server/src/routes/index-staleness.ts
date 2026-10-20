import { createHash, randomUUID } from "node:crypto";

import { pipelineVersionFeatures } from "@docslurp/shared";
import { Hono } from "hono";

import { sql } from "../db.js";
import { getRun, isReprocessRejectedError, isRunCreationBlockedError, reprocessRun } from "../services/runs.js";
import { apiStatusError } from "../lib/api-error.js";

export const indexStalenessRoutes = new Hono()
  .get("/:runId/index-staleness", async (c) => {
    const userId = c.get("sessionUser").id;
    const runId = c.req.param("runId");

    const run = await getRun(runId, userId, { cost: false });
    if (!run) {
      return apiStatusError(c, 404, "Run not found");
    }

    const currentVersion = createHash("sha256")
      .update(JSON.stringify(pipelineVersionFeatures(run.pipeline)))
      .digest("hex")
      .slice(0, 8);

    const staleChunks = await sql<{
      document_id: string;
      chunk_count: number;
      pipeline_version: string | null;
    }[]>`
      select document_id, count(*)::int as chunk_count, pipeline_version
      from document_chunks
      where run_id = ${runId} and user_id = ${userId}
        and (pipeline_version is null or pipeline_version != ${currentVersion})
      group by document_id, pipeline_version
    `;

    const totalChunksRows = await sql<{ count: number }[]>`
      select count(*)::int as count
      from document_chunks
      where run_id = ${runId} and user_id = ${userId}
    `;

    const totalChunks = totalChunksRows[0]?.count ?? 0;
    const staleDocuments = [...new Set(staleChunks.map((r) => r.document_id))];
    const staleChunkCount = staleChunks.reduce((sum, r) => sum + r.chunk_count, 0);

    for (const docId of staleDocuments) {
      const [existing] = await sql<{ id: string }[]>`
        select id from search_index_staleness
        where run_id = ${runId} and document_id = ${docId}
          and reindex_completed_at is null
        limit 1
      `;

      if (!existing) {
        await sql`
          insert into search_index_staleness (id, user_id, run_id, document_id, reason)
          values (
            ${randomUUID()},
            ${userId},
            ${runId},
            ${docId},
            ${"pipeline_version_mismatch: expected " + currentVersion}
          )
        `;
      }
    }

    return c.json({
      currentVersion,
      staleDocuments,
      totalChunks,
      staleChunks: staleChunkCount,
    });
  })
  .post("/:runId/reindex", async (c) => {
    const userId = c.get("sessionUser").id;
    const runId = c.req.param("runId");

    const run = await getRun(runId, userId, { cost: false });
    if (!run) {
      return apiStatusError(c, 404, "Run not found");
    }

    // Re-embed and re-index only: extraction is reused from the source run.
    let reprocessed: Awaited<ReturnType<typeof reprocessRun>>;
    try {
      reprocessed = await reprocessRun(runId, userId, { stages: ["embed", "index"] });
    } catch (error) {
      if (isReprocessRejectedError(error)) {
        return apiStatusError(c, error.statusCode, error.message, { code: error.code, details: error.details });
      }
      if (isRunCreationBlockedError(error)) {
        return apiStatusError(c, error.statusCode, error.message, { code: error.code });
      }
      throw error;
    }
    if (!reprocessed) {
      return apiStatusError(c, 500, "Failed to create reindex run");
    }
    const { run: newRun, deferredReason } = reprocessed;

    await sql`
      update search_index_staleness
      set reindex_queued_at = now()
      where run_id = ${runId} and user_id = ${userId}
        and reindex_queued_at is null
    `;

    if (deferredReason) {
      c.header("X-Temporal-Deferred", "true");
      return c.json({ runId: newRun.id, warnings: [deferredReason] }, 201);
    }

    return c.json({ runId: newRun.id }, 201);
  });
