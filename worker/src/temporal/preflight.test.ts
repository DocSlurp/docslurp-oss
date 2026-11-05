import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

// Anything that would act on the world: Temporal connections and workers, the store, raw Postgres pools and the price
// refresh loop. Preflight must start none of them.
const started = vi.hoisted(() => ({
  temporalConnect: vi.fn(),
  temporalWorkerCreate: vi.fn(),
  store: vi.fn(),
  postgres: vi.fn(),
  priceRefresh: vi.fn(),
}));

vi.mock("@temporalio/worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@temporalio/worker")>();
  return {
    ...actual,
    NativeConnection: { connect: started.temporalConnect },
    Worker: { create: started.temporalWorkerCreate },
  };
});
vi.mock("../db/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/store.js")>();
  return { ...actual, Store: started.store };
});
vi.mock("postgres", () => ({ default: started.postgres }));
vi.mock("@docslurp/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@docslurp/shared")>();
  return { ...actual, startLiveModelPriceRefresh: started.priceRefresh };
});

import { resetExtractorPluginsForTest } from "../extractors/plugins.js";
import { PREFLIGHT_SKIPPED_DATABASE_CHECKS, runWorkerPreflight, WorkerPreflightError, type WorkerPreflightDeps } from "./preflight.js";

const stubs: Partial<WorkerPreflightDeps> = {
  initializeParserSandbox: async () => ({ provider: { id: "test" } as never, config: {}, isolation: {} as never }),
  assertNativePdfEngineAtStartup: async () => ({ ok: false }),
};

function expectNothingStarted() {
  for (const [name, spy] of Object.entries(started)) expect(spy, `${name} must not start in preflight`).not.toHaveBeenCalled();
}

afterEach(() => {
  resetExtractorPluginsForTest();
  vi.clearAllMocks();
});

describe("worker preflight", () => {
  it("passes a valid configuration through the real checks and starts nothing", async () => {
    const results = await runWorkerPreflight({ DOCSLURP_OCR_MODE: "off" }, stubs);
    expect(results.map((r) => r.step)).toEqual([
      "parser sandbox", "extractor plugins", "extractor id aliases", "ocr configuration", "ocr model pins", "native pdf engine",
      ...PREFLIGHT_SKIPPED_DATABASE_CHECKS,
    ]);
    expect(results.find((r) => r.step === PREFLIGHT_SKIPPED_DATABASE_CHECKS[0])?.status).toBe("skipped");
    expectNothingStarted();
  });

  it("refuses an unknown extractor setting at the plugin step", async () => {
    const error = await runWorkerPreflight({ DOCSLURP_OCR_MODE: "off", DOCSLURP_PDF_EXTRACTOR: "no-such-extractor" }, stubs).catch((e) => e);
    expect(error).toBeInstanceOf(WorkerPreflightError);
    expect(error.step).toBe("extractor plugins");
    expectNothingStarted();
  });

  it("refuses a VM PDF selection without a provider", async () => {
    const error = await runWorkerPreflight({ DOCSLURP_OCR_MODE: "off", DOCSLURP_PDF_EXTRACTOR: "vm-pdf" }, stubs).catch((e) => e);
    expect(error.step).toBe("extractor plugins");
    expectNothingStarted();
  });

  it("refuses a plugin that cannot load", async () => {
    const error = await runWorkerPreflight({ DOCSLURP_OCR_MODE: "off", DOCSLURP_EXTRACTOR_PLUGINS: "/nonexistent/plugin.mjs" }, stubs).catch((e) => e);
    expect(error.step).toBe("extractor plugins");
    expect(error.message).toMatch(/failed to load/);
  });

  it("refuses an alias to an extractor this worker cannot serve", async () => {
    const error = await runWorkerPreflight({ DOCSLURP_OCR_MODE: "off", DOCSLURP_EXTRACTOR_ID_ALIASES: "legacy:vm-pdf" }, stubs).catch((e) => e);
    expect(error.step).toBe("extractor id aliases");
  });

  it("refuses VM OCR without an OCR provider, and local OCR on a service profile", async () => {
    expect((await runWorkerPreflight({ DOCSLURP_OCR_MODE: "vm" }, stubs).catch((e) => e)).step).toBe("ocr configuration");
    resetExtractorPluginsForTest();
    // The plugin step passes here (as with a VM PDF provider loaded) so the OCR step is the one under test.
    expect((await runWorkerPreflight({ DOCSLURP_OCR_MODE: "local", DOCSLURP_SERVICE_PROFILE: "service" }, { ...stubs, loadExtractorPlugins: async () => [] }).catch((e) => e)).step).toBe("ocr configuration");
    expectNothingStarted();
  });

  it("refuses a loaded VM PDF provider plugin with DOCSLURP_PDF_EXTRACTOR unset at the plugin step (council A M1)", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "preflight-plugin-"));
    try {
      const file = path.join(dir, "plugin.mjs");
      await writeFile(file, `export function register() {
        return { apiVersion: 1, name: "vm-plugin", sandboxedPdf: { id: "test-vm", maxSourceBytes: 10, assertConfigured() {}, timeoutMs: () => 1, async run() { throw new Error("never"); } } };
      }\n`);
      const error = await runWorkerPreflight({ DOCSLURP_OCR_MODE: "off", DOCSLURP_PDF_MODE: "", DOCSLURP_EXTRACTOR_PLUGINS: file }, stubs).catch((e) => e);
      expect(error).toBeInstanceOf(WorkerPreflightError);
      expect(error.step).toBe("extractor plugins");
      expect(error.message).toMatch(/vm-pdf is not selected/);
      expectNothingStarted();
      // The same plugin with vm-pdf selected passes the plugin step.
      resetExtractorPluginsForTest();
      const results = await runWorkerPreflight({ DOCSLURP_OCR_MODE: "off", DOCSLURP_PDF_MODE: "", DOCSLURP_EXTRACTOR_PLUGINS: file, DOCSLURP_PDF_EXTRACTOR: "vm-pdf" }, stubs);
      expect(results.find((result) => result.step === "extractor plugins")?.status).not.toBe("failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a service profile without a VM PDF provider at the plugin step: PDFs never fall back to the worker host", async () => {
    const error = await runWorkerPreflight({ DOCSLURP_OCR_MODE: "off", DOCSLURP_SERVICE_PROFILE: "service" }, stubs).catch((e) => e);
    expect(error).toBeInstanceOf(WorkerPreflightError);
    expect(error.step).toBe("extractor plugins");
    expect(error.message).toMatch(/DOCSLURP_SERVICE_PROFILE=service needs a sandboxed PDF provider/);
    expectNothingStarted();
  });

  it("refuses an OCR mode whose model manifest is missing", async () => {
    const error = await runWorkerPreflight({ DOCSLURP_OCR_MODE: "local", DOCSLURP_SERVICE_PROFILE: "self-hosted" }, {
      ...stubs, assertOcrConfiguration: () => "local", pinnedOcrModels: () => { throw new Error("OCR model manifest is malformed"); },
    }).catch((e) => e);
    expect(error.step).toBe("ocr model pins");
  });

  it("stops at a failing sandbox or native engine check", async () => {
    expect((await runWorkerPreflight({}, { ...stubs, initializeParserSandbox: async () => { throw new Error("no isolation"); } }).catch((e) => e)).step).toBe("parser sandbox");
    expect((await runWorkerPreflight({ DOCSLURP_OCR_MODE: "off" }, { ...stubs, assertNativePdfEngineAtStartup: async () => { throw new Error("engine missing"); } }).catch((e) => e)).step).toBe("native pdf engine");
  });

  it("imports no store, Temporal, migration or scheduler module", () => {
    for (const file of ["preflight.ts", "preflight-main.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const imports = [...source.matchAll(/^import[^"]*"([^"]+)"/gm)].map((m) => m[1]);
      for (const specifier of imports) {
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/@temporalio|\/db\/|postgres|migrat|lancedb|webhook|outbox|scheduler|activities|worker-supervisor/);
      }
    }
  });
});
