import { describe, expect, it } from "vitest";
import { formatLanceSessionLog, resolveLanceSessionConfig } from "../lancedb-session.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("resolveLanceSessionConfig", () => {
  it("derives cache sizes from available memory, capped at LanceDB's defaults", () => {
    const small = resolveLanceSessionConfig({}, 2 * GB);
    expect(small.indexCacheBytes).toBe(512 * MB);
    expect(small.metadataCacheBytes).toBe(Math.floor(2 * GB * 0.05));
    expect(small.indexCacheSource).toBe("auto");
    const big = resolveLanceSessionConfig({}, 64 * GB);
    expect(big.indexCacheBytes).toBe(6 * GB);
    expect(big.metadataCacheBytes).toBe(1 * GB);
  });

  it("floors the auto sizes on tiny machines", () => {
    const tiny = resolveLanceSessionConfig({}, 128 * MB);
    expect(tiny.indexCacheBytes).toBe(64 * MB);
    expect(tiny.metadataCacheBytes).toBe(32 * MB);
  });

  it("lets env override sizes, even above LanceDB's defaults", () => {
    const config = resolveLanceSessionConfig({ LANCEDB_INDEX_CACHE_MB: "8192", LANCEDB_METADATA_CACHE_MB: "256" }, 2 * GB);
    expect(config.indexCacheBytes).toBe(8 * GB);
    expect(config.metadataCacheBytes).toBe(256 * MB);
    expect(config.indexCacheSource).toBe("env");
    expect(config.metadataCacheSource).toBe("env");
  });

  it("defaults read consistency to 10 s and accepts 0", () => {
    expect(resolveLanceSessionConfig({}, GB).readConsistencySeconds).toBe(10);
    expect(resolveLanceSessionConfig({ LANCEDB_READ_CONSISTENCY_SECONDS: "60" }, GB).readConsistencySeconds).toBe(60);
    expect(resolveLanceSessionConfig({ LANCEDB_READ_CONSISTENCY_SECONDS: "0" }, GB).readConsistencySeconds).toBe(0);
  });

  it("prewarms the index by default, data only when asked", () => {
    const defaults = resolveLanceSessionConfig({}, GB);
    expect(defaults.prewarmRefreshSeconds).toBe(60);
    expect(resolveLanceSessionConfig({ LANCEDB_PREWARM_REFRESH_SECONDS: "0" }, GB).prewarmRefreshSeconds).toBe(0);
    expect([defaults.prewarmIndex, defaults.prewarmData, defaults.prewarmBlocking]).toEqual([true, false, false]);
    const custom = resolveLanceSessionConfig({ LANCEDB_PREWARM_INDEX: "false", LANCEDB_PREWARM_DATA: "1", LANCEDB_PREWARM_BLOCKING: "on" }, GB);
    expect([custom.prewarmIndex, custom.prewarmData, custom.prewarmBlocking]).toEqual([false, true, true]);
  });

  it("rejects invalid values instead of silently falling back", () => {
    expect(() => resolveLanceSessionConfig({ LANCEDB_INDEX_CACHE_MB: "0" }, GB)).toThrow(/LANCEDB_INDEX_CACHE_MB/);
    expect(() => resolveLanceSessionConfig({ LANCEDB_METADATA_CACHE_MB: "1.5" }, GB)).toThrow(/LANCEDB_METADATA_CACHE_MB/);
    expect(() => resolveLanceSessionConfig({ LANCEDB_READ_CONSISTENCY_SECONDS: "-1" }, GB)).toThrow(/LANCEDB_READ_CONSISTENCY_SECONDS/);
    expect(() => resolveLanceSessionConfig({ LANCEDB_PREWARM_DATA: "maybe" }, GB)).toThrow(/LANCEDB_PREWARM_DATA/);
  });
});

describe("formatLanceSessionLog", () => {
  it("reports configured and cached sizes", () => {
    const config = resolveLanceSessionConfig({ LANCEDB_INDEX_CACHE_MB: "100" }, 2 * GB);
    const line = formatLanceSessionLog("created", config, { sizeBytes: BigInt(5 * MB), approxNumItems: 3 });
    expect(line).toContain("[lancedb-session] created index_cache_mb=100(env)");
    expect(line).toContain("cached_mb=5.0 cached_items=3");
  });
});
