import { describe, expect, it } from "vitest";

import { effectiveOcrLanguageSetting, ocrLanguageSettingFromEnv, ocrMaxAttempts, planOcrLanguages, recogniserForCode } from "../languages.js";

const env = (values: Record<string, string> = {}) => values as NodeJS.ProcessEnv;

describe("planOcrLanguages", () => {
  it("tries the widest families first under auto, bounded by DOCSLURP_OCR_MAX_ATTEMPTS (default 3)", () => {
    expect(planOcrLanguages("auto", env())).toEqual({ recognisers: ["multi", "eslav", "korean"], unsupportedScript: false, setting: "auto" });
    expect(planOcrLanguages(undefined, env()).recognisers).toEqual(["multi", "eslav", "korean"]);
    expect(planOcrLanguages("auto", env({ DOCSLURP_OCR_MAX_ATTEMPTS: "1" })).recognisers).toEqual(["multi"]);
    expect(planOcrLanguages("auto", env({ DOCSLURP_OCR_MAX_ATTEMPTS: "7" })).recognisers).toEqual(["multi", "eslav", "korean", "arabic", "devanagari", "greek", "thai"]);
    expect(planOcrLanguages("auto", env({ DOCSLURP_OCR_MAX_ATTEMPTS: "99" })).recognisers).toHaveLength(7);
    for (const bad of ["0", "-1", "2.5", "lots", ""]) expect(ocrMaxAttempts(env({ DOCSLURP_OCR_MAX_ATTEMPTS: bad })), bad).toBe(3);
  });

  it.each([
    ["eng", ["multi"]],
    ["deu", ["multi"]],
    ["chi_sim", ["multi"]],
    ["chi_sim_vert", ["multi"]],
    ["jpn", ["multi"]],
    ["kor", ["korean"]],
    ["rus", ["eslav"]],
    ["ukr", ["eslav"]],
    ["ara", ["arabic"]],
    ["fas", ["arabic"]],
    ["hin", ["devanagari"]],
    ["ell", ["greek"]],
    ["tha", ["thai"]],
  ])("maps %s to %j", (setting, recognisers) => {
    expect(planOcrLanguages(setting, env())).toEqual({ recognisers, unsupportedScript: false, setting });
  });

  it("reads a script no recogniser covers with multi and flags it for escalation", () => {
    expect(planOcrLanguages("heb", env())).toEqual({ recognisers: ["multi"], unsupportedScript: true, setting: "heb" });
    expect(recogniserForCode("heb")).toBeNull();
    expect(planOcrLanguages("eng+tam", env())).toMatchObject({ recognisers: ["multi"], unsupportedScript: true });
  });

  it("puts the script-specific family before multi in a mixed setting", () => {
    expect(planOcrLanguages("eng+kor", env()).recognisers).toEqual(["korean", "multi"]);
    expect(planOcrLanguages("eng+deu+rus", env()).recognisers).toEqual(["eslav", "multi"]);
    expect(planOcrLanguages("ara+fas", env()).recognisers).toEqual(["arabic"]);
  });

  it("throws on a malformed setting", () => {
    for (const bad of ["en", "ENG", "eng+", "../../etc/passwd", "eng;rm -rf /", "--psm 0", "eng deu"]) {
      expect(() => planOcrLanguages(bad, env()), bad).toThrow();
    }
  });

  it("falls back to DOCSLURP_OCR_LANGUAGE when the project says auto or nothing", () => {
    expect(planOcrLanguages("auto", env({ DOCSLURP_OCR_LANGUAGE: "kor" }))).toMatchObject({ recognisers: ["korean"], setting: "kor" });
    expect(planOcrLanguages(undefined, env({ DOCSLURP_OCR_LANGUAGE: "rus" })).recognisers).toEqual(["eslav"]);
    // A project's named language wins over the worker default.
    expect(planOcrLanguages("ara", env({ DOCSLURP_OCR_LANGUAGE: "kor" })).recognisers).toEqual(["arabic"]);
    expect(effectiveOcrLanguageSetting(" auto ", env({ DOCSLURP_OCR_LANGUAGE: "eng+deu" }))).toBe("eng+deu");
  });
});

describe("DOCSLURP_OCR_LANGUAGE", () => {
  it("accepts empty, auto and language codes", () => {
    expect(ocrLanguageSettingFromEnv(env())).toBe("auto");
    expect(ocrLanguageSettingFromEnv(env({ DOCSLURP_OCR_LANGUAGE: "  " }))).toBe("auto");
    expect(ocrLanguageSettingFromEnv(env({ DOCSLURP_OCR_LANGUAGE: "auto" }))).toBe("auto");
    expect(ocrLanguageSettingFromEnv(env({ DOCSLURP_OCR_LANGUAGE: "eng+deu" }))).toBe("eng+deu");
  });

  it("throws on anything else, so a typo stops the worker", () => {
    for (const bad of ["english", "EN", "eng,deu", "eng+", "$(id)"]) {
      expect(() => ocrLanguageSettingFromEnv(env({ DOCSLURP_OCR_LANGUAGE: bad })), bad).toThrow(/DOCSLURP_OCR_LANGUAGE/);
      expect(() => planOcrLanguages(undefined, env({ DOCSLURP_OCR_LANGUAGE: bad })), bad).toThrow(/DOCSLURP_OCR_LANGUAGE/);
    }
  });
});
