import { afterEach, describe, expect, it } from "vitest";

import { defaultDocConcurrency, fromEnv } from "../config.js";
import { resolveActivityConcurrency } from "../concurrency.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  QUARANTINE_ENABLED: process.env.QUARANTINE_ENABLED,
  PLAUSIBILITY_WARNING_THRESHOLD: process.env.PLAUSIBILITY_WARNING_THRESHOLD,
  INFERENCE_LANE: process.env.INFERENCE_LANE,
  DEFAULT_INFERENCE_LANE: process.env.DEFAULT_INFERENCE_LANE,
  WORKER_ACTIVITY_CONCURRENCY: process.env.WORKER_ACTIVITY_CONCURRENCY,
  WORKER_DOC_CONCURRENCY: process.env.WORKER_DOC_CONCURRENCY,
  WORKER_ADAPTIVE_TUNING: process.env.WORKER_ADAPTIVE_TUNING,
  HIGH_QUALITY_EMBEDDING: process.env.HIGH_QUALITY_EMBEDDING,
  EMBEDDING_PROFILE: process.env.EMBEDDING_PROFILE,
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
  QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING: process.env.QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING,
  QUARANTINE_MAX_ARCHIVE_ENTRIES: process.env.QUARANTINE_MAX_ARCHIVE_ENTRIES
};

describe("fromEnv", () => {
  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }
  });

  it("reads the quality warning threshold override", () => {
    process.env.PLAUSIBILITY_WARNING_THRESHOLD = "0.42";

    expect(fromEnv().plausibilityWarningThreshold).toBeCloseTo(0.42);
  });

  it("does not accept process-wide embedding model overrides", () => {
    process.env.HIGH_QUALITY_EMBEDDING = "true";
    process.env.EMBEDDING_PROFILE = "cheapest-hosted";
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";

    const config = fromEnv();
    expect(config).not.toHaveProperty("embeddingProfile");
    expect(config).not.toHaveProperty("embeddingProvider");
    expect(config).not.toHaveProperty("embeddingModel");
    expect(config).not.toHaveProperty("embeddingRuntime");
    expect(config).not.toHaveProperty("embeddingDimensions");
    expect(config).not.toHaveProperty("embeddingBatchSize");
  });

  it("allows an inference lane override without changing the workspace model", () => {
    process.env.DEFAULT_INFERENCE_LANE = "backfill";

    const config = fromEnv();
    expect(config.defaultInferenceLane).toBe("backfill");
  });

  it("enables adaptive worker tuning by default and allows disabling it", () => {
    delete process.env.WORKER_ADAPTIVE_TUNING;
    expect(fromEnv().workerAdaptiveTuning).toBe(true);

    process.env.WORKER_ADAPTIVE_TUNING = "false";
    expect(fromEnv().workerAdaptiveTuning).toBe(false);
  });

  it("reads the worker activity concurrency override", () => {
    delete process.env.WORKER_ACTIVITY_CONCURRENCY;
    expect(fromEnv().workerActivityConcurrency).toBe(defaultDocConcurrency() * 2);

    process.env.WORKER_ACTIVITY_CONCURRENCY = "3";
    expect(fromEnv().workerActivityConcurrency).toBe(3);
  });

  it("reads quarantine overrides", () => {
    process.env.NODE_ENV = "production";
    process.env.QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING = "false";
    process.env.QUARANTINE_MAX_ARCHIVE_ENTRIES = "512";

    const config = fromEnv();
    expect(config.quarantineFailOpenOnToolMissing).toBe(false);
    expect(config.quarantineMaxArchiveEntries).toBe(512);
  });

  it("does not allow production quarantine to be disabled or fail open", () => {
    process.env.NODE_ENV = "production";
    process.env.QUARANTINE_ENABLED = "false";
    process.env.QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING = "true";
    expect(fromEnv().quarantineEnabled).toBe(true);
    expect(fromEnv().quarantineFailOpenOnToolMissing).toBe(false);
  });

  it("fails closed by default in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING;

    expect(fromEnv().quarantineFailOpenOnToolMissing).toBe(false);
  });

  it("fails open by default in local development unless explicitly overridden", () => {
    process.env.NODE_ENV = "development";
    delete process.env.QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING;

    expect(fromEnv().quarantineFailOpenOnToolMissing).toBe(true);
  });
});

describe("worker parallelism defaults", () => {
  it("scales documents with cores, one per two cores, between 1 and 4", () => {
    expect([1, 2, 4, 6, 8, 16, 64].map(defaultDocConcurrency)).toEqual([1, 1, 2, 3, 4, 4, 4]);
  });

  it("resolves activity slots from the CPU count unless WORKER_ACTIVITY_CONCURRENCY is set", () => {
    expect([1, 2, 4, 8, 64].map((cpus) => resolveActivityConcurrency({}, cpus))).toEqual([2, 2, 4, 8, 8]);
    expect(resolveActivityConcurrency({ WORKER_ACTIVITY_CONCURRENCY: "" }, 8)).toBe(8);
    expect(resolveActivityConcurrency({ WORKER_ACTIVITY_CONCURRENCY: "3" }, 8)).toBe(3);
    expect(resolveActivityConcurrency({ WORKER_ACTIVITY_CONCURRENCY: "0" }, 8)).toBe(1);
    expect(resolveActivityConcurrency({ WORKER_ACTIVITY_CONCURRENCY: "junk" }, 8)).toBe(8);
  });

  it("uses the host-derived defaults unless WORKER_*_CONCURRENCY is set, treating empty as unset", () => {
    const original = { doc: process.env.WORKER_DOC_CONCURRENCY, activity: process.env.WORKER_ACTIVITY_CONCURRENCY };
    try {
      process.env.WORKER_DOC_CONCURRENCY = "";
      delete process.env.WORKER_ACTIVITY_CONCURRENCY;
      const config = fromEnv();
      expect(config.workerDocConcurrency).toBe(defaultDocConcurrency());
      expect(config.workerActivityConcurrency).toBe(defaultDocConcurrency() * 2);

      process.env.WORKER_DOC_CONCURRENCY = "2";
      expect(fromEnv().workerDocConcurrency).toBe(2);
    } finally {
      for (const [key, value] of [["WORKER_DOC_CONCURRENCY", original.doc], ["WORKER_ACTIVITY_CONCURRENCY", original.activity]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
