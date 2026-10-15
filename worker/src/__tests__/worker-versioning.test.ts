import { describe, expect, it } from "vitest";

import { resolveWorkerVersioning } from "../temporal/worker-versioning.js";

describe("resolveWorkerVersioning", () => {
  it("leaves the SDK default build ID and routing alone when nothing is set", () => {
    expect(resolveWorkerVersioning({})).toEqual({ mode: "off", buildId: undefined, deploymentVersion: undefined, options: {} });
  });

  it("tags workers with the image git SHA without opting into versioned routing", () => {
    const resolved = resolveWorkerVersioning({ DOCSLURP_GIT_SHA: "abc123" });
    expect(resolved.options).toEqual({ buildId: "abc123" });
    expect(resolved.options.workerDeploymentOptions).toBeUndefined();
  });

  it("prefers an explicit TEMPORAL_WORKER_BUILD_ID", () => {
    expect(resolveWorkerVersioning({ DOCSLURP_GIT_SHA: "abc", TEMPORAL_WORKER_BUILD_ID: "override" }).buildId).toBe("override");
  });

  it("builds Worker Deployment options when opted in", () => {
    const resolved = resolveWorkerVersioning({ DOCSLURP_GIT_SHA: "abc123", TEMPORAL_WORKER_VERSIONING: "deployment" });
    expect(resolved.deploymentVersion).toBe("docslurp-worker.abc123");
    expect(resolved.options).toEqual({
      workerDeploymentOptions: {
        version: { deploymentName: "docslurp-worker", buildId: "abc123" },
        useWorkerVersioning: true,
        defaultVersioningBehavior: "AUTO_UPGRADE",
      },
    });
  });

  it("refuses deployment versioning without a build ID or with a bad mode", () => {
    expect(() => resolveWorkerVersioning({ TEMPORAL_WORKER_VERSIONING: "deployment" })).toThrow(/build ID/);
    expect(() => resolveWorkerVersioning({ TEMPORAL_WORKER_VERSIONING: "yes" })).toThrow(/off" or "deployment/);
    expect(() => resolveWorkerVersioning({ DOCSLURP_GIT_SHA: "a", TEMPORAL_WORKER_VERSIONING: "deployment", TEMPORAL_WORKER_VERSIONING_BEHAVIOR: "sometimes" })).toThrow(/AUTO_UPGRADE or PINNED/);
  });
});
