import { describe, expect, it } from "vitest";

import { chartExportSwitch } from "../chart-export.js";
import {
  applyKillSwitchesToPipeline,
  DISABLE_TOKENS,
  disabledSwitches,
  type DisableToken,
  parseDisableList,
  postureFingerprint,
  resolveDeploymentProfile,
  serviceProfileFromEnv,
} from "../deployment-profile.js";
import { dopplerImageExtractEnabled } from "../doppler-figures.js";
import { extractionPolicyFromEnv, resolveExtractionSettings } from "../extraction-config.js";
import { figureResumeDeployEnabled } from "../figure-resume.js";
import { isDevelopmentEnvironment } from "../runtime-environment.js";

// The process env under vitest is NODE_ENV=test (development); each case passes its own env.
const PROD = { NODE_ENV: "production" };

describe("resolveDeploymentProfile: refusals (fail closed)", () => {
  it("refuses dev under a non-development NODE_ENV", () => {
    for (const nodeEnv of ["production", "staging", "preview", "Production", " development"]) {
      expect(() => resolveDeploymentProfile({ NODE_ENV: nodeEnv, DOCSLURP_PROFILE: "dev" }), nodeEnv).toThrow(/DOCSLURP_PROFILE=dev is only for development/);
    }
  });

  it("refuses service under a development NODE_ENV (and anything but production)", () => {
    for (const nodeEnv of ["development", "test", "", "staging"]) {
      expect(() => resolveDeploymentProfile({ NODE_ENV: nodeEnv, DOCSLURP_PROFILE: "service" }), nodeEnv).toThrow(/service requires NODE_ENV=production/);
      expect(() => resolveDeploymentProfile({ NODE_ENV: nodeEnv, DOCSLURP_PROFILE: "service" }), nodeEnv).toThrow(/service requires NODE_ENV=production/);
    }
  });

  it("refuses an unset profile outside development", () => {
    expect(() => resolveDeploymentProfile(PROD)).toThrow(/DOCSLURP_PROFILE is required outside development/);
    expect(() => resolveDeploymentProfile({ NODE_ENV: "staging" })).toThrow(/required outside development/);
    expect(() => resolveDeploymentProfile({ NODE_ENV: "production", DOCSLURP_PROFILE: "  " })).toThrow(/required/);
  });

  it("warns that selfhost with NODE_ENV unset is development", () => {
    const posture = resolveDeploymentProfile({ NODE_ENV: "", DOCSLURP_PROFILE: "selfhost" });
    expect(posture.vmOnlyParsing).toBe(false);
    expect(posture.warnings.join(" ")).toMatch(/selfhost with NODE_ENV unset counts as development/);
  });

  it("defaults to dev with a warning in development", () => {
    const posture = resolveDeploymentProfile({ NODE_ENV: "development" });
    expect(posture.profile).toBe("dev");
    expect(posture.profileSource).toBe("default");
    expect(posture.vmOnlyParsing).toBe(false);
    expect(posture.warnings.join(" ")).toMatch(/unset; running as dev/);
  });

  it("refuses unknown profile values on either name", () => {
    expect(() => resolveDeploymentProfile({ ...PROD, DOCSLURP_PROFILE: "self-hosted" })).toThrow(/must be one of service, selfhost, dev/);
    expect(() => resolveDeploymentProfile({ ...PROD, DOCSLURP_PROFILE: "services" })).toThrow(/must be one of/);
  });

  it("refuses the retired DOCSLURP_SERVICE_PROFILE whatever its value (R1 tombstone), even when it agrees", () => {
    for (const value of ["service", "self-hosted", "x", " "]) {
      const env = { ...PROD, DOCSLURP_PROFILE: "service", DOCSLURP_SERVICE_PROFILE: value };
      if (value.trim()) expect(() => resolveDeploymentProfile(env), value).toThrow(/retired environment variable.*DOCSLURP_SERVICE_PROFILE.*use DOCSLURP_PROFILE/);
      else expect(resolveDeploymentProfile(env).profile).toBe("service");
    }
    expect(() => resolveDeploymentProfile({ NODE_ENV: "development", DOCSLURP_SERVICE_PROFILE: "self-hosted" })).toThrow(/retired/);
  });

  it("refuses a typo in DOCSLURP_DISABLE", () => {
    for (const value of ["ocr,carts", "AI, page_reader", "figures,figure-resumes", "all", "ai;ocr"]) {
      expect(() => resolveDeploymentProfile({ ...PROD, DOCSLURP_PROFILE: "service", DOCSLURP_DISABLE: value }), value).toThrow(/DOCSLURP_DISABLE has unknown token/);
    }
  });

  it("accepts the whole vocabulary, trimmed and lower-cased, with implications", () => {
    const posture = resolveDeploymentProfile({ ...PROD, DOCSLURP_PROFILE: "service", DOCSLURP_DISABLE: ` ${DISABLE_TOKENS.join(" , ").toUpperCase()} ,, ` });
    expect([...posture.disable]).toEqual([...DISABLE_TOKENS]);
    const ai = resolveDeploymentProfile({ ...PROD, DOCSLURP_PROFILE: "selfhost", DOCSLURP_DISABLE: "ai" });
    expect([...ai.disabled]).toEqual(["ai", "ai-rescue", "ai-escalation", "page-reader", "router", "charts-ai"]);
    expect(Object.isFrozen(ai)).toBe(true);
    expect(Object.isFrozen(ai.disabled)).toBe(true);
  });

  it("warns when a legacy variable repeats a switch, and never refuses a switch that lowers further", () => {
    const posture = resolveDeploymentProfile({ ...PROD, DOCSLURP_PROFILE: "service", DOCSLURP_DISABLE: "ocr,charts", DOCSLURP_OCR_MODE: "off", DOCSLURP_CHART_EXPORT: "off" });
    expect(posture.warnings.filter((warning) => /repeats DOCSLURP_DISABLE/.test(warning))).toHaveLength(2);
    // A switch beside a legacy value that is "more on" is not a conflict: the switch lowers it.
    expect(() => resolveDeploymentProfile({ ...PROD, DOCSLURP_PROFILE: "service", DOCSLURP_DISABLE: "ocr,charts-ai", DOCSLURP_OCR_MODE: "vm", DOCSLURP_CHART_EXPORT: "on" })).not.toThrow();
  });
});

describe("isolation floor: VM-only in every non-development environment, whatever the profile", () => {
  const cases: Array<[Record<string, string>, boolean]> = [
    [{ NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost" }, true],
    [{ NODE_ENV: "staging", DOCSLURP_PROFILE: "selfhost" }, true],
    [{ NODE_ENV: "production", DOCSLURP_PROFILE: "service" }, true],
    [{ NODE_ENV: "development", DOCSLURP_PROFILE: "selfhost" }, false],
    [{ NODE_ENV: "test", DOCSLURP_PROFILE: "dev" }, false],
  ];
  it.each(cases)("%j -> vmOnlyParsing=%s", (env, vmOnly) => {
    const posture = resolveDeploymentProfile(env);
    expect(posture.vmOnlyParsing).toBe(vmOnly);
    expect(posture.hostSandboxAllowed).toBe(!vmOnly);
    expect(posture.inProcessReadersAllowed).toBe(!vmOnly);
  });

  it("selfhost never gets host sandboxing outside development", () => {
    for (const nodeEnv of ["production", "staging", "preview", "Production"]) {
      const posture = resolveDeploymentProfile({ NODE_ENV: nodeEnv, DOCSLURP_PROFILE: "selfhost" });
      expect(posture.hostSandboxAllowed, nodeEnv).toBe(false);
      expect(posture.vmOnlyParsing, nodeEnv).toBe(true);
    }
  });

  it("DOCSLURP_PROFILE=service is never development, even with a development NODE_ENV (the floor holds before startup refuses)", () => {
    expect(isDevelopmentEnvironment({ NODE_ENV: "development", DOCSLURP_PROFILE: "service" })).toBe(false);
    expect(isDevelopmentEnvironment({ NODE_ENV: "test", DOCSLURP_PROFILE: " SERVICE " })).toBe(false);
    expect(isDevelopmentEnvironment({ NODE_ENV: "", DOCSLURP_PROFILE: "service", DOCSLURP_SERVICE_PROFILE: "" })).toBe(false);
  });

  it("no profile value makes a non-development NODE_ENV development", () => {
    for (const profile of ["dev", "selfhost", "DEV", "", "service"]) {
      expect(isDevelopmentEnvironment({ NODE_ENV: "production", DOCSLURP_PROFILE: profile }), profile).toBe(false);
    }
  });
});

describe("serviceProfileFromEnv: the legacy view every pre-R0 reader uses", () => {
  it("maps DOCSLURP_PROFILE to the legacy vocabulary and reads any service value as service", () => {
    expect(serviceProfileFromEnv({ DOCSLURP_PROFILE: "service" })).toBe("service");
    expect(serviceProfileFromEnv({ DOCSLURP_PROFILE: "selfhost" })).toBe("self-hosted");
    expect(serviceProfileFromEnv({ DOCSLURP_PROFILE: "dev" })).toBeNull();
    expect(serviceProfileFromEnv({})).toBeNull();
    expect(serviceProfileFromEnv({ DOCSLURP_PROFILE: " services " })).toBe("service");
    // The retired name is not read (startup refuses it).
    expect(serviceProfileFromEnv({ DOCSLURP_SERVICE_PROFILE: "service" })).toBeNull();
  });
});

describe("DOCSLURP_DISABLE readers never throw and fail closed", () => {
  it("reads an unparseable value as every switch off", () => {
    expect([...disabledSwitches({ DOCSLURP_DISABLE: "ocr,carts" })].sort()).toEqual([...DISABLE_TOKENS].sort());
    expect(parseDisableList("ocr,carts")).toEqual({ tokens: ["ocr"], unknown: ["carts"] });
  });
});

describe("kill switches only lower: no env or request path raises a rung", () => {
  // Every subset of a few switches, under every legacy chart value: each reader's answer with switches is at or below
  // its answer without them.
  const SUBSETS: DisableToken[][] = [[], ...DISABLE_TOKENS.map((token) => [token]), ["ai", "charts"], ["charts-ai", "figures"], [...DISABLE_TOKENS]];
  const CHART_RANK = { off: 0, free: 1, on: 2 } as const;
  const QUALITY_RANK: Record<string, number> = { fast: 0, auto: 1, good: 2 };
  const TIER_RANK: Record<string, number> = { off: 0, free: 1, models: 2 };

  it.each(["off", "free", "on", undefined, "garbage"])("chartExportSwitch with DOCSLURP_CHART_EXPORT=%s", (chart) => {
    const base = chart === undefined ? {} : { DOCSLURP_CHART_EXPORT: chart };
    const without = chartExportSwitch(base);
    for (const subset of SUBSETS) {
      const value = chartExportSwitch({ ...base, DOCSLURP_DISABLE: subset.join(",") });
      expect(CHART_RANK[value], subset.join(",")).toBeLessThanOrEqual(CHART_RANK[without]);
    }
    expect(chartExportSwitch({ ...base, DOCSLURP_DISABLE: "charts" })).toBe("off");
    if (without === "on") expect(chartExportSwitch({ ...base, DOCSLURP_DISABLE: "ai" })).toBe("free");
  });

  it("figures and figure resume switches only turn things off", () => {
    for (const flag of ["0", "1", "off", "on", ""]) {
      for (const subset of SUBSETS) {
        const env = { DOCSLURP_DOPPLER_IMAGE_EXTRACT: flag, DOCSLURP_FIGURE_RESUME: flag, DOCSLURP_DISABLE: subset.join(",") };
        if (!dopplerImageExtractEnabled({ DOCSLURP_DOPPLER_IMAGE_EXTRACT: flag })) expect(dopplerImageExtractEnabled(env)).toBe(false);
        if (!figureResumeDeployEnabled({ DOCSLURP_FIGURE_RESUME: flag })) expect(figureResumeDeployEnabled(env)).toBe(false);
      }
    }
    expect(dopplerImageExtractEnabled({ DOCSLURP_DOPPLER_IMAGE_EXTRACT: "1", DOCSLURP_DISABLE: "figures" })).toBe(false);
    expect(figureResumeDeployEnabled({ DOCSLURP_FIGURE_RESUME: "on", DOCSLURP_DISABLE: "figure-resume" })).toBe(false);
    expect(dopplerImageExtractEnabled({ DOCSLURP_DOPPLER_IMAGE_EXTRACT: "1", DOCSLURP_DISABLE: "charts,ai" })).toBe(true);
  });

  it("applyKillSwitchesToPipeline never raises quality, rescue reads or the chart tier", () => {
    const pipelines = [];
    for (const quality of ["fast", "auto", "good", undefined]) {
      for (const visionFallback of [true, false, undefined]) {
        for (const tier of ["off", "free", "models", undefined]) {
          pipelines.push({ quality, visionFallback, chartExport: tier === undefined ? undefined : { tier }, vision: { forceAllPages: quality === "good" } });
        }
      }
    }
    for (const pipeline of pipelines) {
      for (const subset of SUBSETS) {
        const next = applyKillSwitchesToPipeline(pipeline, { DOCSLURP_DISABLE: subset.join(",") });
        const label = `${JSON.stringify(pipeline)} ${subset.join(",")}`;
        expect(QUALITY_RANK[next.quality ?? "auto"], label).toBeLessThanOrEqual(QUALITY_RANK[pipeline.quality ?? "auto"]);
        if (pipeline.visionFallback === false) expect(next.visionFallback, label).toBe(false);
        if (pipeline.visionFallback === undefined && !subset.length) expect(next.visionFallback, label).toBeUndefined();
        expect(TIER_RANK[next.chartExport?.tier ?? "off"], label).toBeLessThanOrEqual(TIER_RANK[pipeline.chartExport?.tier ?? "off"]);
        if (!pipeline.vision.forceAllPages) expect((next.vision as { forceAllPages?: boolean } | undefined)?.forceAllPages, label).toBeFalsy();
      }
    }
    expect(applyKillSwitchesToPipeline({ quality: "good", visionFallback: true }, { DOCSLURP_DISABLE: "ai" })).toEqual({ quality: "auto", visionFallback: false });
    expect(applyKillSwitchesToPipeline({ quality: "auto", visionFallback: true }, { DOCSLURP_DISABLE: "ai-rescue" })).toEqual({ quality: "auto", visionFallback: false });
    // ai-rescue alone leaves smart's every-page reads alone (they are not rescue reads); ai lowers smart first.
    expect(applyKillSwitchesToPipeline({ quality: "good", visionFallback: true }, { DOCSLURP_DISABLE: "ai-rescue" })).toEqual({ quality: "good", visionFallback: true });
    const untouched = { quality: "good", visionFallback: true };
    expect(applyKillSwitchesToPipeline(untouched, {})).toBe(untouched);
  });

  it("the resolution never grants a rung a switch blocks, for any caller or request", () => {
    const callers = [{ canEdit: true }, { canEdit: true, apiKey: { scopes: ["pipeline:billed-features"] } }, { canEdit: false }];
    for (const subset of SUBSETS) {
      const policy = extractionPolicyFromEnv({ DOCSLURP_CHART_EXPORT: "on", DOCSLURP_CHART_EXPORT_FREE_EXPLICIT: "on", DOCSLURP_DISABLE: subset.join(",") });
      for (const caller of callers) {
        for (const quality of ["fastest", "balanced", "smart"] as const) {
          for (const visuals of ["none", "figures", "charts", "charts-ai"] as const) {
            const result = resolveExtractionSettings({
              request: { quality, visuals },
              project: { quality: "smart", visuals: "charts-ai" },
              origin: "app",
              caller,
              constraints: {},
              policy,
            });
            if (!result.ok) continue;
            const off = new Set(subset.flatMap((token) => (token === "ai" ? ["ai", "charts-ai"] : token === "charts" ? ["charts", "charts-ai"] : [token])));
            if (off.has("ai")) expect(result.quality, subset.join(",")).not.toBe("smart");
            if (off.has("charts-ai")) expect(result.visuals).not.toBe("charts-ai");
            if (off.has("charts")) expect(["none", "figures"]).toContain(result.visuals);
            if (off.has("figures")) expect(result.visuals).not.toBe("figures");
          }
        }
      }
    }
  });
});

describe("posture fingerprint", () => {
  it("is stable for equal postures and changes with the switches", () => {
    const a = resolveDeploymentProfile({ ...PROD, DOCSLURP_PROFILE: "service", DOCSLURP_DISABLE: "ocr,ai" });
    const b = resolveDeploymentProfile({ ...PROD, DOCSLURP_PROFILE: "service", DOCSLURP_DISABLE: "AI, ocr" });
    expect(postureFingerprint(a)).toBe(postureFingerprint(b));
    const c = resolveDeploymentProfile({ ...PROD, DOCSLURP_PROFILE: "service", DOCSLURP_DISABLE: "ocr" });
    expect(postureFingerprint(c)).not.toBe(postureFingerprint(a));
  });
});
