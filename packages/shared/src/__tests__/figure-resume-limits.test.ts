import { describe, expect, it } from "vitest";

import {
  FIGURE_RESUME_HARD, figureResumeBudgetConfig, figureResumeExpectedPasses, figureResumeLaunchCap, figureResumeOrgDailyVmMs,
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
    expect(figureResumeUnitCap(10)).toBe(3);
    expect(figureResumeLaunchCap({ pageCount: 1_000 }, defaults)).toBe(30);
    // Unsharded: every resume converts all 1,000 pages (3 s + 50 s), 20 passes, 2x headroom.
    expect(figureResumeVmBudgetMs({ pageCount: 1_000 }, defaults)).toBe(2_120_000);
    expect(figureResumeLaunchCap({ pageCount: 20_000, units: 32 }, defaults)).toBe(95);
    // 32 shards of 625 pages: each resume is one shard (3 s + 31.25 s), 63 passes, 2x headroom.
    expect(figureResumeVmBudgetMs({ pageCount: 20_000, units: 32 }, defaults)).toBe(4_315_500);
    // The same document unsharded would need 63 full passes: the ceiling (4 h) bounds it.
    expect(figureResumeVmBudgetMs({ pageCount: 20_000 }, defaults)).toBe(4 * 3_600_000);
    expect(figureResumeUnitCap(625)).toBe(15);
    expect(figureResumeUnitCap(100_000)).toBe(32);
    // At least one launch per open unit, up to the ceiling.
    expect(figureResumeLaunchCap({ pageCount: 10, units: 40 }, defaults)).toBe(40);
    expect(figureResumeLaunchCap({ pageCount: 10, units: 4_000 }, defaults)).toBe(128);
  });

  it("grants add half the base again (at least the floors), bounded by the hard ceilings", () => {
    expect(figureResumeLaunchCap({ pageCount: 10, grants: 1 }, defaults)).toBe(6);
    expect(figureResumeLaunchCap({ pageCount: 20_000, grants: 2 }, defaults)).toBe(95 + 2 * 48);
    expect(figureResumeVmBudgetMs({ pageCount: 10, grants: 1 }, defaults)).toBe(360_000);
    expect(figureResumeVmBudgetMs({ pageCount: 20_000, units: 32, grants: 1 }, defaults)).toBe(4_315_500 + 2_157_750);
    expect(figureResumeUnitCap(10, 1)).toBe(6);
    expect(figureResumeLaunchCap({ pageCount: 20_000, grants: 100 }, { ...defaults, launchCeiling: 512 })).toBe(FIGURE_RESUME_HARD.documentLaunches);
    expect(figureResumeUnitCap(100_000, 100)).toBe(FIGURE_RESUME_HARD.unitResumes);
  });

  it("env overrides are clamped to their bounds; garbage keeps the default; floors never exceed ceilings", () => {
    expect(figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_LAUNCH_CEILING: "99999" }).launchCeiling).toBe(FIGURE_RESUME_HARD.documentLaunches);
    expect(figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_LAUNCH_FLOOR: "0" }).launchFloor).toBe(1);
    expect(figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_NO_PROGRESS: "two" }).noProgressLimit).toBe(3);
    expect(figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_NO_PROGRESS: "2.5" }).noProgressLimit).toBe(3);
    expect(figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_MAX_GRANTS: "-1" }).maxGrants).toBe(0);
    const inverted = figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_LAUNCH_FLOOR: "20", DOCSLURP_FIGURE_RESUME_LAUNCH_CEILING: "5",
      DOCSLURP_FIGURE_RESUME_DOC_VM_SECONDS_FLOOR: "600", DOCSLURP_FIGURE_RESUME_DOC_VM_SECONDS_CEILING: "120" });
    expect([inverted.launchFloor, inverted.launchCeiling, inverted.docVmSecondsFloor, inverted.docVmSecondsCeiling]).toEqual([20, 20, 600, 600]);
    const tuned = figureResumeBudgetConfig({ DOCSLURP_FIGURE_RESUME_VM_MS_PER_PAGE: "150", DOCSLURP_FIGURE_RESUME_VM_HEADROOM: "1", DOCSLURP_FIGURE_RESUME_VM_MS_PER_LAUNCH: "0" });
    expect(figureResumeVmBudgetMs({ pageCount: 20_000, units: 32 }, tuned)).toBe(63 * 625 * 150);
    expect(figureResumeOrgDailyVmMs({})).toBe(120 * 60_000);
    expect(figureResumeOrgDailyVmMs({ DOCSLURP_FIGURE_RESUME_ORG_DAILY_VM_MINUTES: "5000" })).toBe(24 * 60 * 60_000);
  });

  it("only the three budget stops are grantable", () => {
    expect(["attempts", "vm-budget", "no-progress"].every(isFigureResumeBudgetBlock)).toBe(true);
    expect(["unscanned", "refused", "stale", "resume-off", "figures-off", null].some(isFigureResumeBudgetBlock)).toBe(false);
  });
});
