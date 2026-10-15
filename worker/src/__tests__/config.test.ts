import { afterEach, describe, expect, it } from "vitest";

import { fromEnv } from "../config.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  QUARANTINE_ENABLED: process.env.QUARANTINE_ENABLED,
  PLAUSIBILITY_WARNING_THRESHOLD: process.env.PLAUSIBILITY_WARNING_THRESHOLD,
  INFERENCE_LANE: process.env.INFERENCE_LANE,
  DEFAULT_INFERENCE_LANE: process.env.DEFAULT_INFERENCE_LANE,
  WORKER_ACTIVITY_CONCURRENCY: process.env.WORKER_ACTIVITY_CONCURRENCY,
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
    expect(fromEnv().workerActivityConcurrency).toBe(1);

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
