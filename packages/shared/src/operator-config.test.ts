import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { visionModelCatalogByUri } from "./embedding.js";

import {
  applyOperatorConfigEnvironment,
  assessOperatorConfigSkew,
  initializeOperatorConfig,
  loadOperatorConfig,
  OPERATOR_CONFIG_ENV,
  OPERATOR_CONFIG_KNOBS,
  operatorConfigDigest,
  operatorConfigEnvironment,
  operatorConfigSchema,
  OperatorConfigError,
  duplicateJsonKey,
  operatorModelOverrideProblem,
  parseOperatorConfig,
  resetOperatorConfigState,
} from "./operator-config.js";

const PRODUCTION = { NODE_ENV: "production" };
const DEVELOPMENT = { NODE_ENV: "development" };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "operator-config-"));
  resetOperatorConfigState();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetOperatorConfigState();
});

function file(contents: unknown): string {
  const path = join(dir, `operator-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("loadOperatorConfig", () => {
  it("is null when the variable is unset or empty (code defaults)", () => {
    expect(loadOperatorConfig({})).toBeNull();
    expect(loadOperatorConfig({ [OPERATOR_CONFIG_ENV]: "  " })).toBeNull();
  });

  it("refuses a set but missing file", () => {
    expect(() => loadOperatorConfig({ ...PRODUCTION, [OPERATOR_CONFIG_ENV]: join(dir, "missing.json") })).toThrow(/cannot be read \(ENOENT\)/);
  });

  it("refuses an unreadable file (permission error)", () => {
    const path = file({ version: 1 });
    const denied = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    expect(() => loadOperatorConfig({ ...PRODUCTION, [OPERATOR_CONFIG_ENV]: path }, denied)).toThrow(/cannot be read \(EACCES\)/);
  });

  it("refuses a directory, a relative path, invalid JSON and an oversized file", () => {
    expect(() => loadOperatorConfig({ ...PRODUCTION, [OPERATOR_CONFIG_ENV]: dir })).toThrow(OperatorConfigError);
    expect(() => loadOperatorConfig({ ...PRODUCTION, [OPERATOR_CONFIG_ENV]: "ops/operator.json" })).toThrow(/absolute path/);
    expect(() => loadOperatorConfig({ ...PRODUCTION, [OPERATOR_CONFIG_ENV]: file("{ not json") })).toThrow(/not valid JSON/);
    expect(() => loadOperatorConfig({ ...PRODUCTION, [OPERATOR_CONFIG_ENV]: file(" ".repeat(300 * 1024)) })).toThrow(/ETOOBIG|larger than/);
  });

  it("refuses a repeated key, which JSON.parse would silently resolve to the last value", () => {
    const text = `{"version":1,"ocr":{"pageReader":{"mode":"all","orgDailyMaxCostCents":2000,"orgDailyMaxCostCents":10000000}}}`;
    expect(() => loadOperatorConfig({ ...PRODUCTION, [OPERATOR_CONFIG_ENV]: file(text) })).toThrow(/repeats the key "orgDailyMaxCostCents"/);
    expect(duplicateJsonKey(`{"a":{"b":1},"c":{"b":2},"s":"x\\"y","l":[{"b":1},{"b":2}]}`)).toBeNull();
    expect(duplicateJsonKey(`{"a":1,"b":{"x":1},"a":2}`)).toBe("a");
    expect(duplicateJsonKey(`{"a\\u0062":1,"ab":2}`)).toBe("ab");
  });

  it("loads a valid file and digests it independently of formatting and key order", () => {
    const a = loadOperatorConfig({ ...PRODUCTION, [OPERATOR_CONFIG_ENV]: file({ version: 1, ocr: { maxConcurrent: 2, maxAttempts: 3 } }) });
    const b = loadOperatorConfig({ ...PRODUCTION, [OPERATOR_CONFIG_ENV]: file(`{"ocr":{"maxAttempts":3,  "maxConcurrent":2},"version":1}`) });
    expect(a?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a?.digest).toBe(b?.digest);
    const c = loadOperatorConfig({ ...PRODUCTION, [OPERATOR_CONFIG_ENV]: file({ version: 1, ocr: { maxConcurrent: 3, maxAttempts: 3 } }) });
    expect(c?.digest).not.toBe(a?.digest);
  });
});

describe("schema", () => {
  it("refuses unknown keys at every level", () => {
    expect(() => parseOperatorConfig({ version: 1, extra: true }, PRODUCTION)).toThrow(/Unrecognized key/);
    expect(() => parseOperatorConfig({ version: 1, ocr: { maxConcurent: 2 } }, PRODUCTION)).toThrow(/ocr/);
    expect(() => parseOperatorConfig({ version: 1, ocr: { pageReader: { mode: "all", orgDailyMaxCostCents: 10, unlimited: true } } }, PRODUCTION)).toThrow(/Unrecognized key/);
  });

  it("refuses an unknown version", () => {
    expect(() => parseOperatorConfig({ version: 2 }, PRODUCTION)).toThrow(/version/);
    expect(() => parseOperatorConfig({}, PRODUCTION)).toThrow(/version/);
  });

  it("refuses out-of-range values, including every spend cap above its bound", () => {
    for (const bad of [
      { ocr: { maxConcurrent: 0 } },
      { ocr: { maxConcurrent: 33 } },
      { ocr: { pageReader: { mode: "all", orgDailyMaxCostCents: 10_000_001 } } },
      { ocr: { pageReader: { mode: "all", orgDailyMaxCostCents: -1 } } },
      { ocr: { pageReader: { mode: "all", orgDailyMaxCostCents: 1.5 } } },
      { ocr: { pageReader: { mode: "all", maxPagesPerDocument: 20_001, orgDailyMaxCostCents: 10 } } },
      { ai: { escalation: { maxPagesPerDocument: 10_001 } } },
      { ai: { escalation: { maxAttemptsPerDocument: 20_001 } } },
      { vision: { guards: { orgUnchargedLimitCents: 1_000_001 } } },
      { vision: { guards: { breakerFailureRate: 0 } } },
      { charts: { freeVmBudget: { runsPerOrgHour: 10_001 } } },
      { figureResume: { orgDailyVmMinutes: 1_441 } },
      { figureResume: { maxGrants: 11 } },
      { figureResume: { docVmSecondsCeiling: 12 * 3600 + 1 } },
      { ocr: { maxConcurrent: "2" } },
    ]) {
      expect(() => parseOperatorConfig({ version: 1, ...bad }, PRODUCTION), JSON.stringify(bad)).toThrow(OperatorConfigError);
    }
  });

  it("requires the page reader's daily cost cap whenever the reader is on", () => {
    expect(() => parseOperatorConfig({ version: 1, ocr: { pageReader: { mode: "all" } } }, PRODUCTION)).toThrow(/orgDailyMaxCostCents is required/);
    expect(() => parseOperatorConfig({ version: 1, ocr: { pageReader: { mode: "balanced" } } }, PRODUCTION)).toThrow(/orgDailyMaxCostCents is required/);
    expect(() => parseOperatorConfig({ version: 1, vision: { pageReader: { mode: "all" } } }, PRODUCTION)).toThrow(/orgDailyMaxCostCents is required/);
    expect(parseOperatorConfig({ version: 1, ocr: { pageReader: { mode: "off" } } }, PRODUCTION).ocr?.pageReader?.mode).toBe("off");
    expect(parseOperatorConfig({ version: 1, ocr: { pageReader: { mode: "all", orgDailyMaxCostCents: 0 } } }, PRODUCTION).ocr?.pageReader?.orgDailyMaxCostCents).toBe(0);
  });

  it("requires an owner and a removal ticket on every rollout flag", () => {
    expect(() => parseOperatorConfig({ version: 1, rollout: { layoutSource: { value: "selective" } } }, PRODUCTION)).toThrow(OperatorConfigError);
    expect(() => parseOperatorConfig({ version: 1, rollout: { layoutSource: { value: "selective", owner: "x", removalTicket: "soon" } } }, PRODUCTION)).toThrow(/removalTicket/);
    expect(() => parseOperatorConfig({ version: 1, rollout: { layoutSource: { value: "selective", owner: " ", removalTicket: "#1" } } }, PRODUCTION)).toThrow(/owner/);
    for (const ticket of ["#504", "acme/docslurp#12", "https://github.com/acme/docslurp/issues/12"]) {
      expect(parseOperatorConfig({ version: 1, rollout: { layoutSource: { value: "selective", owner: "platform", removalTicket: ticket } } }, PRODUCTION).rollout?.layoutSource?.value).toBe("selective");
    }
  });
});

describe("isolation floor", () => {
  it("refuses parsing.local outside development, whatever its value", () => {
    for (const env of [PRODUCTION, { NODE_ENV: "staging" }, { NODE_ENV: "development", DOCSLURP_SERVICE_PROFILE: "service" }]) {
      expect(() => parseOperatorConfig({ version: 1, parsing: { local: { nativeEngine: "native-pdf" } } }, env)).toThrow(/parsing.local is refused/);
      expect(() => parseOperatorConfig({ version: 1, parsing: { local: { nativeEngine: "off" } } }, env)).toThrow(/parsing.local is refused/);
      expect(() => parseOperatorConfig({ version: 1, parsing: { local: {} } }, env)).toThrow(/parsing.local is refused/);
      expect(() => parseOperatorConfig({ version: 1, router: { preferNativeMarkdown: true } }, env)).toThrow(/preferNativeMarkdown/);
    }
  });

  it("refuses parsing.local when the process environment is not development, even if the passed env is", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => parseOperatorConfig({ version: 1, parsing: { local: { nativeEngine: "native-pdf" } } }, DEVELOPMENT)).toThrow(/parsing.local is refused/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("allows parsing.local in development", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      expect(parseOperatorConfig({ version: 1, parsing: { local: { nativeEngine: "shadow" } } }, { NODE_ENV: "test" }).parsing?.local?.nativeEngine).toBe("shadow");
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("no field outside parsing.local and the router sets a parser placement variable", () => {
    const placement = new Set(["DOCSLURP_PDF_ENGINE", "PDF_RASTER_ENGINE", "PAGE_ROUTER_PREFER_NATIVE_MARKDOWN"]);
    for (const knob of OPERATOR_CONFIG_KNOBS) {
      if (placement.has(knob.env)) expect(knob.path).toMatch(/^(parsing\.local\.|router\.preferNativeMarkdown$)/);
    }
    const forbidden = ["DOCSLURP_OCR_MODE", "DOCSLURP_PDF_MODE", "DOCSLURP_PDF_EXTRACTOR", "DOCSLURP_PARSER_SANDBOX", "DOCSLURP_SERVICE_PROFILE", "NODE_ENV", "QUARANTINE_ENABLED", "DOCSLURP_OPERATOR_CONFIG"];
    for (const knob of OPERATOR_CONFIG_KNOBS) expect(forbidden).not.toContain(knob.env);
  });
});

describe("model overrides", () => {
  it("accepts reviewed, priced catalog models", () => {
    expect(operatorModelOverrideProblem("ocrEscalation", "llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct")).toBeNull();
    expect(operatorModelOverrideProblem("vision", "llm://openrouter/google/gemini-3.1-flash-lite")).toBeNull();
    expect(operatorModelOverrideProblem("chartGenerator", "llm://openrouter/openai/gpt-6-luna")).toBeNull();
  });

  it("refuses OpenAI Pro/Ultra models, encoded or with a query, for every override", () => {
    for (const field of ["vision", "ocrEscalation", "chartGenerator"] as const) {
      for (const model of ["llm://openrouter/openai/gpt-6-sol-pro", "openai/gpt-6-sol-pro", "llm://openrouter/openai/gpt-6-ultra", "llm://openrouter/openai/gpt-6-sol-pro?reasoning=high", "llm://openrouter/openai/gpt-6-sol%2Dpro"]) {
        expect(operatorModelOverrideProblem(field, model), `${field} ${model}`).not.toBeNull();
      }
      expect(() => parseOperatorConfig({ version: 1, models: { overrides: { [field]: "llm://openrouter/openai/gpt-6-sol-pro" } } }, PRODUCTION)).toThrow(/refused/);
    }
  });

  it("refuses uncataloged, local, unpriced and catalog-refused models", () => {
    expect(operatorModelOverrideProblem("vision", "llm://openrouter/acme/unknown-vl")).toMatch(/not a reviewed vision model/);
    expect(operatorModelOverrideProblem("vision", "llm://local-cli/microsoft/Florence-2-small-ft")).toMatch(/not a hosted model/);
    expect(operatorModelOverrideProblem("vision", "llm://openrouter/xiaomi/mimo-v2.6-flash")).toMatch(/refused/);
    expect(operatorModelOverrideProblem("chartGenerator", "llm://openrouter/acme/unpriced-model")).toMatch(/not a reviewed vision model/);
    expect(operatorModelOverrideProblem("chartGenerator", "openai/gpt-6-luna")).toMatch(/llm:\/\/openrouter/);
    expect(operatorModelOverrideProblem("chartGenerator", "llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct")).toMatch(/llm:\/\/openrouter/);
    expect(operatorModelOverrideProblem("ocrEscalation", "llm://vllm/Qwen/Qwen2-VL-2B-Instruct")).not.toBeNull();
  });

  it("refuses a model at or above the $50 per 1M output-token cap", () => {
    const uri = "llm://openrouter/acme/expensive-vl";
    const catalog = visionModelCatalogByUri as Record<string, unknown>;
    catalog[uri] = { id: "acme/expensive-vl", uri, target: "hosted", tokenPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 50, checked: "2026-11-16" } };
    try {
      expect(operatorModelOverrideProblem("vision", uri)).toMatch(/at or above the cap/);
      catalog[uri] = { ...(catalog[uri] as object), tokenPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 49.99, checked: "2026-11-16" } };
      expect(operatorModelOverrideProblem("vision", uri)).toBeNull();
      catalog[uri] = { ...(catalog[uri] as object), tokenPricing: null };
      expect(operatorModelOverrideProblem("vision", uri)).toMatch(/no verified price/);
    } finally {
      delete catalog[uri];
    }
  });
});

describe("environment overlay", () => {
  const config = parseOperatorConfig({
    version: 1,
    ocr: { maxConcurrent: 2, pageReader: { mode: "all", orgDailyMaxCostCents: 2000 } },
    ai: { escalation: { enabled: true, maxPagesPerDocument: 25 } },
    charts: { originDefaults: { app: "figures", machine: "figures" }, explicitFree: "auto", inline: true, freeVmBudget: { runsPerOrgHour: 200 } },
  }, PRODUCTION);

  it("sets unset variables and leaves agreeing ones alone", () => {
    const env: Record<string, string | undefined> = { DOCSLURP_OCR_ESCALATION: "1", DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off" };
    const result = applyOperatorConfigEnvironment(config, env, "worker");
    expect(env).toMatchObject({
      DOCSLURP_OCR_MAX_CONCURRENT: "2",
      DOCSLURP_OCR_PAGE_READER: "all",
      DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS: "2000",
      DOCSLURP_OCR_ESCALATION: "1",
      DOCSLURP_OCR_ESCALATION_MAX_PAGES: "25",
      DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off",
      DOCSLURP_CHART_EXPORT_API_DEFAULT: "off",
      DOCSLURP_CHART_EXPORT_INLINE: "1",
      DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR: "200",
    });
    expect(env.DOCSLURP_CHART_EXPORT_FREE_EXPLICIT).toBeUndefined();
    expect(result.agreed.sort()).toEqual(["DOCSLURP_CHART_EXPORT_APP_DEFAULT", "DOCSLURP_OCR_ESCALATION"]);
  });

  it("refuses a conflict and changes nothing", () => {
    for (const conflicting of [
      { DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS: "50000" },
      { DOCSLURP_OCR_ESCALATION: "off" },
      { DOCSLURP_OCR_ESCALATION: "maybe" },
      { DOCSLURP_CHART_EXPORT_FREE_EXPLICIT: "on" },
      { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "free" },
      // Non-canonical number spellings: some readers reject them and fall back to their default.
      { DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS: "02000" },
      { DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS: "2e3" },
      { DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS: "2000.0" },
      // An empty value means something to some readers (Number("") is 0): never overwritten.
      { DOCSLURP_OCR_ESCALATION_MAX_PAGES: "" },
      { DOCSLURP_OCR_ESCALATION_MAX_PAGES: "  " },
    ]) {
      const env: Record<string, string | undefined> = { ...conflicting };
      expect(() => applyOperatorConfigEnvironment(config, env, "worker"), JSON.stringify(conflicting)).toThrow(/disagree/);
      expect(env).toEqual(conflicting);
    }
  });

  it("applies only the variables the API reads for the server role", () => {
    const env: Record<string, string | undefined> = {};
    applyOperatorConfigEnvironment(config, env, "server");
    expect(Object.keys(env).sort()).toEqual([
      "DOCSLURP_CHART_EXPORT_API_DEFAULT",
      "DOCSLURP_CHART_EXPORT_APP_DEFAULT",
      "DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR",
      "DOCSLURP_CHART_EXPORT_INLINE",
    ]);
  });

  it("maps every knob to a distinct variable and every schema leaf to a knob", () => {
    const names = OPERATOR_CONFIG_KNOBS.map((knob) => knob.env);
    expect(new Set(names).size).toBe(names.length);
    const leaves: string[] = [];
    const walk = (schema: unknown, path: string[]) => {
      let inner = schema as { def?: { type?: string; innerType?: unknown; shape?: Record<string, unknown> }; shape?: Record<string, unknown> };
      while (inner.def?.type === "optional") inner = inner.def.innerType as typeof inner;
      const shape = inner.def?.type === "object" ? (inner.shape ?? inner.def.shape) : undefined;
      if (!shape) { leaves.push(path.join(".")); return; }
      // A rollout flag is one leaf: its value; owner and removalTicket are metadata.
      if (path[0] === "rollout" && path.length === 2) { leaves.push(path.join(".")); return; }
      for (const [key, value] of Object.entries(shape)) walk(value, [...path, key]);
    };
    walk(operatorConfigSchema, []);
    const knobPaths = new Set(OPERATOR_CONFIG_KNOBS.map((knob) => knob.path));
    expect(leaves.filter((leaf) => leaf !== "version" && !knobPaths.has(leaf))).toEqual([]);
  });

  it("the overlay round-trips: a config's own environment agrees with it", () => {
    const env: Record<string, string | undefined> = {};
    for (const [name, { value }] of operatorConfigEnvironment(config, "worker")) if (value !== null) env[name] = value;
    expect(applyOperatorConfigEnvironment(config, env, "worker").applied).toEqual([]);
  });
});

describe("initializeOperatorConfig", () => {
  it("is a no-op without the variable", () => {
    const env: Record<string, string | undefined> = {};
    expect(initializeOperatorConfig("worker", env, () => {}).digest).toBeNull();
    expect(env).toEqual({});
  });

  it("applies into every env it is given, even after the first call", () => {
    const path = file({ version: 1, ocr: { maxConcurrent: 2 } });
    const first: Record<string, string | undefined> = { ...PRODUCTION, [OPERATOR_CONFIG_ENV]: path };
    initializeOperatorConfig("worker", first, () => {});
    const second: Record<string, string | undefined> = { ...PRODUCTION, [OPERATOR_CONFIG_ENV]: path };
    initializeOperatorConfig("worker", second, () => {});
    expect(second.DOCSLURP_OCR_MAX_CONCURRENT).toBe("2");
    expect(() => initializeOperatorConfig("worker", { ...PRODUCTION, [OPERATOR_CONFIG_ENV]: path, DOCSLURP_OCR_MAX_CONCURRENT: "3" }, () => {})).toThrow(/disagree/);
  });

  it("an auto field agrees with an empty variable", () => {
    const config = parseOperatorConfig({ version: 1, charts: { explicitFree: "auto" } }, PRODUCTION);
    expect(applyOperatorConfigEnvironment(config, { DOCSLURP_CHART_EXPORT_FREE_EXPLICIT: "" }, "server").agreed).toEqual(["DOCSLURP_CHART_EXPORT_FREE_EXPLICIT"]);
  });

  it("applies once per role and reports the digest", () => {
    const path = file({ version: 1, ocr: { maxConcurrent: 2 }, charts: { inline: true } });
    const env: Record<string, string | undefined> = { ...PRODUCTION, [OPERATOR_CONFIG_ENV]: path };
    const lines: string[] = [];
    const server = initializeOperatorConfig("server", env, (line) => lines.push(line));
    expect(env.DOCSLURP_OCR_MAX_CONCURRENT).toBeUndefined();
    expect(env.DOCSLURP_CHART_EXPORT_INLINE).toBe("1");
    const worker = initializeOperatorConfig("worker", env, (line) => lines.push(line));
    expect(env.DOCSLURP_OCR_MAX_CONCURRENT).toBe("2");
    expect(worker.digest).toBe(server.digest);
    expect(worker.roles.sort()).toEqual(["server", "worker"]);
    expect(lines.some((line) => line.includes(server.digest!))).toBe(true);
  });
});

describe("digest skew", () => {
  it("is ok only when every live worker reports the API's digest", () => {
    expect(assessOperatorConfigSkew("sha256:a", [{ identity: "w1", digest: "sha256:a" }]).status).toBe("ok");
    expect(assessOperatorConfigSkew(null, [{ identity: "w1", digest: null }]).status).toBe("ok");
    expect(assessOperatorConfigSkew("sha256:a", [{ identity: "w1", digest: "sha256:a" }, { identity: "w2", digest: "sha256:b" }]).status).toBe("skew");
    expect(assessOperatorConfigSkew("sha256:a", [{ identity: "w1", digest: null }]).status).toBe("skew");
    expect(assessOperatorConfigSkew(null, [{ identity: "w1", digest: "sha256:a" }]).status).toBe("skew");
    // An older build that reports no digest at all is skew, never a match.
    expect(assessOperatorConfigSkew(null, [{ identity: "w1", digest: undefined }]).status).toBe("skew");
    expect(assessOperatorConfigSkew("sha256:a", []).status).toBe("unknown");
  });

  it("digests the validated config", () => {
    const config = parseOperatorConfig({ version: 1 }, PRODUCTION);
    expect(operatorConfigDigest(config)).toBe(operatorConfigDigest(parseOperatorConfig(JSON.parse('{"version":1}'), PRODUCTION)));
  });
});
