/**
 * Worker build identity and (opt-in) Temporal Worker Deployment Versioning.
 * Rollout and contributor rules: docs/temporal-workflow-changes.md.
 *
 * Build ID: TEMPORAL_WORKER_BUILD_ID, else DOCSLURP_GIT_SHA (baked into the
 * worker image by the Fly deploy path), else the SDK default (package
 * version + workflow bundle checksum).
 *
 * TEMPORAL_WORKER_VERSIONING:
 * - "off" (default): the Build ID only tags pollers and workflow task
 *   completions, so the Temporal UI/CLI shows which image ran each task.
 *   Task routing is unchanged, which keeps rolling Fly deploys working.
 *   Replay safety comes from patched() plus the CI replay test.
 * - "deployment": the worker joins Worker Deployment
 *   TEMPORAL_WORKER_DEPLOYMENT_NAME (default "docslurp-worker") as version
 *   <name>.<buildId>, with TEMPORAL_WORKER_VERSIONING_BEHAVIOR (default
 *   AUTO_UPGRADE). Versioned workers only get tasks once an operator (or the
 *   deploy) makes their version Current or Ramping, so do not turn this on
 *   without that step.
 */

import type { WorkerOptions } from "@temporalio/worker";

export type WorkerVersioningMode = "off" | "deployment";

export interface WorkerVersioning {
  mode: WorkerVersioningMode;
  buildId: string | undefined;
  /** `<deploymentName>.<buildId>` when deployment versioning is on. */
  deploymentVersion: string | undefined;
  options: Pick<WorkerOptions, "buildId" | "workerDeploymentOptions">;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function resolveWorkerVersioning(env: NodeJS.ProcessEnv = process.env): WorkerVersioning {
  const buildId = read(env, "TEMPORAL_WORKER_BUILD_ID") ?? read(env, "DOCSLURP_GIT_SHA");
  const rawMode = (read(env, "TEMPORAL_WORKER_VERSIONING") ?? "off").toLowerCase();
  if (rawMode !== "off" && rawMode !== "deployment") {
    throw new Error(`TEMPORAL_WORKER_VERSIONING must be "off" or "deployment", got "${rawMode}"`);
  }
  if (rawMode === "off") {
    return { mode: "off", buildId, deploymentVersion: undefined, options: buildId ? { buildId } : {} };
  }
  if (!buildId) {
    throw new Error("TEMPORAL_WORKER_VERSIONING=deployment needs a build ID (TEMPORAL_WORKER_BUILD_ID or DOCSLURP_GIT_SHA)");
  }
  const deploymentName = read(env, "TEMPORAL_WORKER_DEPLOYMENT_NAME") ?? "docslurp-worker";
  const behavior = (read(env, "TEMPORAL_WORKER_VERSIONING_BEHAVIOR") ?? "AUTO_UPGRADE").toUpperCase();
  if (behavior !== "AUTO_UPGRADE" && behavior !== "PINNED") {
    throw new Error(`TEMPORAL_WORKER_VERSIONING_BEHAVIOR must be AUTO_UPGRADE or PINNED, got "${behavior}"`);
  }
  return {
    mode: "deployment",
    buildId,
    deploymentVersion: `${deploymentName}.${buildId}`,
    options: {
      workerDeploymentOptions: {
        version: { deploymentName, buildId },
        useWorkerVersioning: true,
        defaultVersioningBehavior: behavior,
      },
    },
  };
}
