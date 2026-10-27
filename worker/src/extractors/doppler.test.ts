import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRunner } from "../tools/runner.js";
import { ExtractorRegistry } from "./registry.js";

afterEach(() => vi.unstubAllEnvs());
describe("Doppler PDF selection", () => {
  it("selects only the VM default, even when the older native mode is enabled", () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "doppler");
    vi.stubEnv("DOCSLURP_PDF_ENGINE", "native-pdf");
    const registry = new ExtractorRegistry();
    expect(registry.resolve("pdf")).toEqual(["doppler"]);
    expect(registry.resolve("pdf", ["poppler-text"])).toEqual(["poppler-text"]);
    expect(() => registry.resolve("image", ["doppler"])).toThrow("does not support");
  });
  it("refuses a missing or mutable VM image instead of advertising a local fallback", async () => {
    const runner = new CommandRunner();
    for (const image of ["", "registry/doppler:latest"]) {
      vi.stubEnv("DOCSLURP_DOPPLER_VM_IMAGE", image);
      await expect(runner.dopplerMarkdown("/job/input.pdf", "/job/output.md")).rejects.toThrow("digest-pinned");
    }
  });
  it("does not probe local executables and preserves request-local paths in the plan", async () => {
    vi.stubEnv("DOCSLURP_DOPPLER_VM_IMAGE", `registry/doppler@sha256:${"a".repeat(64)}`);
    const runner = new CommandRunner();
    const prepared = await new ExtractorRegistry().prepare("doppler", runner, "/tenant-a/job/input.pdf");
    expect(prepared.plan).toMatchObject({ available: true, dopplerVm: {
      operation: "doppler-markdown", input: "/tenant-a/job/input.pdf", output: "/tenant-a/job/input.pdf.doppler.md",
    } });
    expect(prepared.tableAware).toBe(true);
    await expect(runner.dopplerMarkdown("relative.pdf", "/output")).rejects.toThrow("absolute");
    await expect(runner.dopplerMarkdown("/same", "/same")).rejects.toThrow("distinct");
  });
});
