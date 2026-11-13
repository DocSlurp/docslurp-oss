import { describe, expect, it, vi } from "vitest";

import {
  FIGURE_RESUME_BUDGET_ENV, FIGURE_RESUME_HARD, figureResumeLaunchPages, figureResumeBudgetConfig, figureResumeConcurrency, figureResumeGlobalMax, figureResumeProgressed, figureResumeExpectedPasses, figureResumeLaunchCap, figureResumeOrgDailyVmMs,
  figureResumeUnitCap, figureResumeVmBudgetMs, isFigureResumeBudgetBlock,
} from "../figure-resume-limits.js";

// The resume caps scale with pages (docs/extraction/doppler-figures.md, "Caps"): a small document gets a few launches and
// minutes, a 20,000-page one enough passes for its whole figure allowance at one VM's 64 MiB / 2,048 files per pass.
describe("figure resume limits", () => {
  const defaults = figureResumeBudgetConfig({});

  it("expected passes follow the document's allowance over one VM's output", () => {
    expect(figureResumeExpectedPasses(10)).toBe(1);
    expect(figureResumeExpectedPasses(100)).toBe(2);
    expect(figureResumeExpectedPasses(1_000)).toBe(20);
    // 4 GiB allowance (the manifest cap) over 64 MiB a pass, after the first pass.
    expect(figureResumeExpectedPasses(20_000)).toBe(63);
    expect(figureResumeExpectedPasses(0)).toBe(1);
  });

  it("small documents: 3 launches, 180 s, 3 resumes per unit; huge documents: 95 launches, 4,316 s, 15 per 625-page shard", () => {
    expect(figureResumeLaunchCap({ pageCount: 10 }, defaults)).toBe(3);
    expect(figureResumeVmBudgetMs({ pageCount: 10 }, defaults)).toBe(180_000);
    expect(figureResumeUnitCap({ unitPages: 10, whole: true })).toBe(3);
    expect(figureResumeLaunchCap({ pageCount: 1_000 }, defaults)).toBe(30);
    // Unsharded: every resume converts all 1,000 pages (3 s + 50 s), 20 passes, 2x headroom.
    expect(figureResumeVmBudgetMs({ pageCount: 1_000 }, defaults)).toBe(2_120_000);
    expect(figureResumeLaunchCap({ pageCount: 20_000, units: 32 }, defaults)).toBe(95);
    // 32 shards of 625 pages: each resume is one shard (3 s + 31.25 s), 63 passes, 2x headroom.
    expect(figureResumeVmBudgetMs({ pageCount: 20_000, shards: 32 }, defaults)).toBe(4_315_500);
    // The same document unsharded would need 63 full passes: the ceiling (4 h) bounds it.
    expect(figureResumeVmBudgetMs({ pageCount: 20_000 }, defaults)).toBe(4 * 3_600_000);
    expect(figureResumeUnitCap({ unitPages: 625, documentPages: 20_000 })).toBe(15);
    expect(figureResumeUnitCap({ unitPages: 32, documentPages: 20_000 })).toBe(3);
    // At least one launch per open unit, up to the ceiling.
    expect(figureResumeLaunchCap({ pageCount: 10, units: 40 }, defaults)).toBe(40);
    expect(figureResumeLaunchCap({ pageCount: 10, units: 4_000 }, defaults)).toBe(128);
  });

  it("M1: a unit's cap follows the passes its share needs: a 3,000-page unsharded document gets its 59 passes, a 2,000-page shard its 40", () => {
    expect(figureResumeExpectedPasses(3_000)).toBe(59);
    expect(figureResumeUnitCap({ unitPages: 3_000, documentPages: 3_000, whole: true })).toBe(61);
    expect(figureResumeUnitCap({ unitPages: 2_000, documentPages: 20_000 })).toBe(42);
    // A shard never gets more than the document's whole allowance: 4 GiB over 64 MiB.
    expect(figureResumeUnitCap({ unitPages: 20_000, documentPages: 20_000 })).toBe(66);
    expect(figureResumeLaunchCap({ pageCount: 3_000 }, defaults)).toBe(89);
  });

  it("M2: an unsharded document's launch converts every page, gaps or not; a sharded one, one shard", () => {
    expect(figureResumeLaunchPages({ pageCount: 1_000 })).toBe(1_000);
    expect(figureResumeLaunchPages({ pageCount: 20_000, shards: 32 })).toBe(625);
    // 1,000 pages unsharded with gaps: still 20 passes of 53 s, 2x headroom (the gaps never divide it).
    expect(figureResumeVmBudgetMs({ pageCount: 1_000, shards: 0 }, defaults)).toBe(2_120_000);
  });

  it("grants add half the base again (at least the floors), bounded by the hard ceilings", () => {
    expect(figureResumeLaunchCap({ pageCount: 10, grants: 1 }, defaults)).toBe(6);
    expect(figureResumeLaunchCap({ pageCount: 20_000, grants: 2 }, defaults)).toBe(95 + 2 * 48);
    expect(figureResumeVmBudgetMs({ pageCount: 10, grants: 1 }, defaults)).toBe(360_000);
    expect(figureResumeVmBudgetMs({ pageCount: 20_000, shards: 32, grants: 1 }, defaults)).toBe(4_315_500 + 2_157_750);
    expect(figureResumeUnitCap({ unitPages: 10, whole: true, grants: 1 })).toBe(6);
    expect(figureResumeLaunchCap({ pageCount: 20_000, grants: 100 }, { ...defaults, launchCeiling: 512 })).toBe(FIGURE_RESUME_HARD.documentLaunches);
    expect(figureResumeUnitCap({ unitPages: 100_000, whole: true, grants: 100 })).toBe(FIGURE_RESUME_HARD.unitResumes);
  });

  it("L3: an override outside its bounds or unparsable keeps the default and warns once; floors never exceed ceilings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_LAUNCH_CEILING: "99999" }).launchCeiling).toBe(128);
    expect(figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_LAUNCH_FLOOR: "0" }).launchFloor).toBe(3);
    expect(figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_NO_PROGRESS: "two" }).noProgressLimit).toBe(3);
    expect(figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_NO_PROGRESS: "2.5" }).noProgressLimit).toBe(3);
    expect(figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_MAX_GRANTS: "-1" }).maxGrants).toBe(2);
    // The kill switch is in range.
    expect(figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_MAX_GRANTS: "0" }).maxGrants).toBe(0);
    // A typo on an org or fleet cost knob is the default, never the bound.
    expect(figureResumeOrgDailyVmMs({ DOCSLURP_FIGURE_RESUME_ORG_DAILY_VM_MINUTES: "12000" })).toBe(120 * 60_000);
    expect(figureResumeGlobalMax({ DOCSLURP_FIGURE_RESUME_GLOBAL_MAX: "800" })).toBe(8);
    expect(figureResumeConcurrency({ DOCSLURP_FIGURE_RESUME_CONCURRENCY: "0" })).toBe(2);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("DOCSLURP_FIGURE_RESUME_ORG_DAILY_VM_MINUTES") && line.includes("default 120"))).toBe(true);
    // One warning per variable and value.
    const before = warn.mock.calls.length;
    figureResumeGlobalMax({ DOCSLURP_FIGURE_RESUME_GLOBAL_MAX: "800" });
    expect(warn.mock.calls.length).toBe(before);
    warn.mockRestore();
    const inverted = figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_LAUNCH_FLOOR: "20", DOCSLURP_FIGURE_RESUME_LAUNCH_CEILING: "5",
      DOCSLURP_FIGURE_RESUME_DOC_VM_SECONDS_FLOOR: "600", DOCSLURP_FIGURE_RESUME_DOC_VM_SECONDS_CEILING: "120" });
    expect([inverted.launchFloor, inverted.launchCeiling, inverted.docVmSecondsFloor, inverted.docVmSecondsCeiling]).toEqual([20, 20, 600, 600]);
    const tuned = figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_VM_MS_PER_PAGE: "150", DOCSLURP_FIGURE_RESUME_VM_HEADROOM: "1", DOCSLURP_FIGURE_RESUME_VM_MS_PER_LAUNCH: "0" });
    expect(figureResumeVmBudgetMs({ pageCount: 20_000, shards: 32 }, tuned)).toBe(63 * 625 * 150);
    expect(figureResumeOrgDailyVmMs({})).toBe(120 * 60_000);
    expect(figureResumeOrgDailyVmMs({ DOCSLURP_FIGURE_RESUME_ORG_DAILY_VM_MINUTES: "1440" })).toBe(24 * 60 * 60_000);
  });

  it("M1: with every override at its maximum and any grant count, the hard ceilings hold", () => {
    const max = Object.fromEntries(Object.values(FIGURE_RESUME_BUDGET_ENV).map((spec) => [spec.name, String(spec.max)]));
    const config = figureResumeBudgetConfig(max);
    expect(config).toMatchObject({ launchCeiling: 512, docVmSecondsCeiling: 12 * 3_600, maxGrants: 10 });
    for (const pageCount of [1, 10, 1_000, 20_000, 100_000]) {
      for (const units of [0, 1, 32, 256]) {
        for (const grants of [0, 1, 10, 100, 1_000_000]) {
          expect(figureResumeVmBudgetMs({ pageCount, shards: units, grants }, config)).toBeLessThanOrEqual(FIGURE_RESUME_HARD.documentVmMs);
          expect(figureResumeLaunchCap({ pageCount, units, grants }, config)).toBeLessThanOrEqual(FIGURE_RESUME_HARD.documentLaunches);
          expect(figureResumeUnitCap({ unitPages: pageCount, whole: true, grants })).toBeLessThanOrEqual(FIGURE_RESUME_HARD.unitResumes);
          expect(figureResumeUnitCap({ unitPages: Math.ceil(pageCount / Math.max(1, units)), documentPages: pageCount, grants })).toBeLessThanOrEqual(FIGURE_RESUME_HARD.unitResumes);
        }
      }
    }
    expect(figureResumeVmBudgetMs({ pageCount: 20_000, grants: 10 }, config)).toBe(FIGURE_RESUME_HARD.documentVmMs);
    expect(FIGURE_RESUME_BUDGET_ENV.maxGrants.max).toBe(FIGURE_RESUME_HARD.grants);
    expect(FIGURE_RESUME_BUDGET_ENV.docVmSecondsCeiling.max * 1000).toBeLessThanOrEqual(FIGURE_RESUME_HARD.documentVmMs);
  });

  it("L1: progress needs a minimum gain: 5% of one unit's share of the work left (at least one item), and real bytes for files", () => {
    // Closing work counts as is.
    expect(figureResumeProgressed({ before: 1, after: 0, added: 0, addedBytes: 0 }, defaults)).toBe(true);
    expect(figureResumeProgressed({ before: 1_000, after: 950, added: 0, addedBytes: 0 }, defaults)).toBe(true);
    expect(figureResumeProgressed({ before: 1_000, after: 951, added: 0, addedBytes: 0 }, defaults)).toBe(false);
    // One tiny figure a pass is no progress; one real one on a small document is.
    expect(figureResumeProgressed({ before: 5, after: 5, added: 1, addedBytes: 40 }, defaults)).toBe(false);
    expect(figureResumeProgressed({ before: 5, after: 5, added: 1, addedBytes: 50_000 }, defaults)).toBe(true);
    // A 128-shard document: one shard's honest resume (under 1% of the whole backlog) is progress; one file a pass is not.
    expect(figureResumeProgressed({ before: 30_000, after: 29_766, added: 234, addedBytes: 20_000_000, units: 128 }, defaults)).toBe(true);
    expect(figureResumeProgressed({ before: 30_000, after: 30_000, added: 1, addedBytes: 500_000, units: 128 }, defaults)).toBe(false);
    expect(figureResumeProgressed({ before: 30_000, after: 30_000, added: 1, addedBytes: 500_000, units: 1 }, defaults)).toBe(false);
    expect(figureResumeProgressed({ before: 0, after: 0, added: 0, addedBytes: 0 }, defaults)).toBe(false);
  });

  it("only the three budget stops are grantable", () => {
    expect(["attempts", "vm-budget", "no-progress"].every(isFigureResumeBudgetBlock)).toBe(true);
    expect(["unscanned", "refused", "stale", "resume-off", "figures-off", null].some(isFigureResumeBudgetBlock)).toBe(false);
  });
});
