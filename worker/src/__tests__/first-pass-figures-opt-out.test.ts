import { describe, expect, it, vi } from "vitest";

// A provider that can produce figures, so only the project and the deploy flag decide.
vi.mock("../extractors/plugins.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extractors/plugins.js")>()),
  sandboxedPdfProvider: () => ({ figures: true }),
}));

const { firstPassBatchOptions } = await import("../pipeline/first-pass.js");
const { figuresEnabled } = await import("@docslurp/shared");

const ON = { DOCSLURP_DOPPLER_IMAGE_EXTRACT: "on" };

describe("figures opt-out (pipeline.figures: false) skips the worker figure pass", () => {
  it("the first-pass batch asks the VM for no figures when the project opted out", () => {
    expect(firstPassBatchOptions({ figures: false } as never, ON).figures).toBe(false);
    expect(firstPassBatchOptions({ figures: true } as never, ON).figures).toBe(true);
    // Unset is the schema default (on); the deploy flag stays the ceiling.
    expect(firstPassBatchOptions({} as never, ON).figures).toBe(true);
    expect(firstPassBatchOptions({ figures: true } as never, {}).figures).toBe(false);
  });

  it("figuresEnabled is the one rule extract-markdown, the asset ledger and resume share", () => {
    expect(figuresEnabled({ figures: false }, ON)).toBe(false);
    expect(figuresEnabled({ figures: true }, ON)).toBe(true);
    expect(figuresEnabled(null, ON)).toBe(true);
    expect(figuresEnabled({ figures: true }, { DOCSLURP_DOPPLER_IMAGE_EXTRACT: "off" })).toBe(false);
  });
});
