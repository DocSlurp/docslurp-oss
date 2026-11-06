import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNativePdfEngineAtStartup, loadNativePdfEngine, loadNativePdfModule, setNativePdfEngineForTesting } from "./loader.js";

const PROD = { NODE_ENV: "production" };
afterEach(() => { setNativePdfEngineForTesting(null); vi.unstubAllEnvs(); });

describe("production native PDF isolation", () => {
  it("refuses module loading before discovery or a cached module can be returned", () => {
    const result = loadNativePdfModule(PROD);
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/VM boundary/) });
  });
  it("cannot bypass an actual production process with a partial environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(loadNativePdfModule({})).toMatchObject({ ok: false, reason: expect.stringMatching(/VM boundary/) });
    expect(await loadNativePdfEngine({})).toMatchObject({ ok: false, reason: expect.stringMatching(/VM boundary/) });
  });
  it("cannot bypass the refusal through the engine override", async () => {
    setNativePdfEngineForTesting({} as never);
    expect(await loadNativePdfEngine(PROD)).toEqual({ ok: false, reason: expect.stringMatching(/VM boundary/) });
  });
  it.each([
    { DOCSLURP_NATIVE_PDF_INSTALLED: "1" },
    { DOCSLURP_PDF_ENGINE: "shadow" },
    { DOCSLURP_PDF_ENGINE: "native-pdf" },
    { DOCSLURP_NATIVE_PDF_POPPLER: "1", DOCSLURP_PDF_ENGINE: "shadow" },
  ])("fails startup for an in-process engine configuration %o", async (settings) => {
    await expect(assertNativePdfEngineAtStartup({ ...PROD, ...settings })).rejects.toThrow(/VM boundary/);
  });
  it("allows startup with the in-process engine disabled", async () => {
    expect(await assertNativePdfEngineAtStartup({ ...PROD, DOCSLURP_PDF_ENGINE: "off" }))
      .toEqual({ ok: false, reason: expect.stringMatching(/VM boundary/) });
  });
});
