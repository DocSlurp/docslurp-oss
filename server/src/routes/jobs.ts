import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";

import { apiErrorResponse } from "../lib/api-error.js";
import { actorHasAnyApiKeyScope, getRequestActor } from "../lib/request-actor.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { getJobStatus, isJobTerminal, type JobStatusWithProgress } from "../services/jobs.js";

const JOB_STREAM_POLL_MS = 1_000;
const JOB_STREAM_MAX_MS = 10 * 60_000;

async function readJob(c: Context): Promise<JobStatusWithProgress | Response> {
  const actor = getRequestActor(c);
  if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts", "workspaces:manage"])) {
    return apiErrorResponse(c, 403, "forbidden", "Forbidden");
  }
  const job = await getJobStatus(c.req.param("jobId") ?? "", c.get("sessionUser").id, {
    apiKey: actor.type === "apiKey" ? actor.apiKey : null,
  });
  return job ?? apiErrorResponse(c, 404, "not_found", "Job not found");
}

/**
 * Shared job resource over `workspace_runs` and `graph_jobs`. `GET /:jobId` is the polling endpoint; `/events`
 * streams `status` (full job, on change), `progress` (counts, on change) and a final `done`. Streams end after
 * 10 minutes: reconnect or poll.
 */
export const jobsRoutes = new Hono()
  .get("/:jobId", async (c) => {
    const job = await readJob(c);
    return job instanceof Response ? job : c.json(job);
  })
  .get("/:jobId/events", async (c) => {
    const first = await readJob(c);
    if (first instanceof Response) return first;
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    const apiKey = actor.type === "apiKey" ? actor.apiKey : null;
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const deadline = Date.now() + JOB_STREAM_MAX_MS;
      let job = first;
      let lastStatus = "";
      let lastProgress = "";
      while (!stream.aborted) {
        const { progress, ...status } = job;
        const statusJson = JSON.stringify(status);
        if (statusJson !== lastStatus) {
          await stream.writeSSE({ event: "status", data: statusJson });
          lastStatus = statusJson;
        }
        const progressJson = JSON.stringify({ id: job.id, ...progress });
        if (progressJson !== lastProgress) {
          await stream.writeSSE({ event: "progress", data: progressJson });
          lastProgress = progressJson;
        }
        if (isJobTerminal(job)) {
          await stream.writeSSE({ event: "done", data: JSON.stringify(job) });
          return;
        }
        if (Date.now() >= deadline) return;
        await stream.sleep(JOB_STREAM_POLL_MS);
        const next = await getJobStatus(job.id, userId, { apiKey });
        if (!next) return;
        job = next;
      }
    });
  });

acceptApiKeys(jobsRoutes);
