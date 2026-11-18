import { afterEach, describe, expect, it, vi } from "vitest";

import { RUN_BACKLOG_CACHE_MS, runBacklogHint, setExtractorRunBacklog } from "../extractors/plugins.js";

const scope = { orgId: "org-a", runId: "run-1" };

describe("run backlog hint", () => {
  afterEach(() => { setExtractorRunBacklog(undefined); vi.restoreAllMocks(); });

  it("is undefined when no lookup is bound or the scope is incomplete", async () => {
    expect(await runBacklogHint(scope)).toBeUndefined();
    setExtractorRunBacklog(async () => 5);
    expect(await runBacklogHint({ orgId: "", runId: "run-1" })).toBeUndefined();
    expect(await runBacklogHint({ orgId: "org-a", runId: "" })).toBeUndefined();
  });

  it("stamps the observation time and shares one read per run within the cache window", async () => {
    let now = 1_000_000;
    const lookup = vi.fn(async () => 12);
    setExtractorRunBacklog(lookup);
    const [a, b] = await Promise.all([runBacklogHint(scope, () => now), runBacklogHint(scope, () => now)]);
    expect(a).toEqual({ queuedPages: 12, observedAt: 1_000_000 });
    expect(b).toBe(a);
    now += RUN_BACKLOG_CACHE_MS - 1;
    await runBacklogHint(scope, () => now);
    expect(lookup).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await runBacklogHint(scope, () => now)).toEqual({ queuedPages: 12, observedAt: now });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("keys the cache by organization and run, so one run's count never answers another's", async () => {
    const lookup = vi.fn(async (s: { orgId: string; runId: string }) => (s.orgId === "org-a" && s.runId === "run-1" ? 7 : 0));
    setExtractorRunBacklog(lookup);
    expect((await runBacklogHint(scope))?.queuedPages).toBe(7);
    expect((await runBacklogHint({ orgId: "org-b", runId: "run-1" }))?.queuedPages).toBe(0);
    expect((await runBacklogHint({ orgId: "org-a", runId: "run-2" }))?.queuedPages).toBe(0);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("resolves undefined (logged) on a failed read and retries on the next call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lookup = vi.fn().mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce(3);
    setExtractorRunBacklog(lookup);
    expect(await runBacklogHint(scope)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("status=lookup-failed"));
    expect((await runBacklogHint(scope))?.queuedPages).toBe(3);
  });

  it("resolves undefined for an invalid count", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of [-1, 1.5, Number.NaN]) {
      setExtractorRunBacklog(async () => bad);
      expect(await runBacklogHint(scope)).toBeUndefined();
    }
  });
});
