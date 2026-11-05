import { afterEach, describe, expect, it, vi } from "vitest";

import { documentExtractionConfigSchema } from "../extraction.js";
import {
  canonicalExtractorId,
  configureExtractorIdAliases,
  installExtractorIdAliases,
  normalizeDocumentExtractionAliases,
  parseExtractorIdAliases,
  resetExtractorIdAliasesForTest,
} from "../extractor-aliases.js";
import { builtInDocumentExtractorDescriptors } from "../extractors.js";
import { normalizeStoredPipelineFeatures, pipelineFeatureOverridesSchema, sanitizeStoredPipeline } from "../pipeline.js";

// A made-up legacy id: what a deployment used before renaming its extractor.
const LEGACY = "legacy-pdf";
const served = builtInDocumentExtractorDescriptors.map((entry) => entry.id);
const legacyConfig = () => ({
  order: { pdf: [LEGACY, "kreuzberg"] },
  options: { [LEGACY]: { images: { enabled: true, minWidth: 20, minHeight: 30 } } },
  voting: { enabled: true, secondary: LEGACY },
});

afterEach(() => resetExtractorIdAliasesForTest());

describe("parseExtractorIdAliases", () => {
  it("reads <old>:<new> pairs that map onto a served id", () => {
    expect(parseExtractorIdAliases(undefined, served)).toEqual(new Map());
    expect(parseExtractorIdAliases("  ", served)).toEqual(new Map());
    expect(parseExtractorIdAliases(` ${LEGACY}:vm-pdf , older-pdf:kreuzberg`, served)).toEqual(new Map([[LEGACY, "vm-pdf"], ["older-pdf", "kreuzberg"]]));
  });

  it("refuses an alias to an unknown or unserved id", () => {
    expect(() => parseExtractorIdAliases(`${LEGACY}:no-such-extractor`, served)).toThrow(/does not serve/);
    // vm-pdf is built in, but a process without a provider does not serve it.
    expect(() => parseExtractorIdAliases(`${LEGACY}:vm-pdf`, served.filter((id) => id !== "vm-pdf"))).toThrow(/does not serve/);
    // A served id that is not a built-in is not a valid target either.
    expect(() => parseExtractorIdAliases(`${LEGACY}:custom-thing`, [...served, "custom-thing"])).toThrow(/does not serve/);
  });

  it("refuses to shadow a built-in or served id, to chain, and to map an id to itself", () => {
    expect(() => parseExtractorIdAliases("kreuzberg:vm-pdf", served)).toThrow(/may not override/);
    expect(() => parseExtractorIdAliases("vm-pdf:kreuzberg", served)).toThrow(/may not override/);
    expect(() => parseExtractorIdAliases(`${LEGACY}:vm-pdf`, [...served, LEGACY])).toThrow(/may not override/);
    expect(() => parseExtractorIdAliases(`older-pdf:${LEGACY},${LEGACY}:vm-pdf`, served)).toThrow();
    expect(() => parseExtractorIdAliases(`${LEGACY}:${LEGACY}`, served)).toThrow(/itself/);
  });

  it("refuses malformed and duplicate entries", () => {
    for (const raw of [LEGACY, `${LEGACY}:`, `:vm-pdf`, `${LEGACY}:vm-pdf:x`, `Legacy:vm-pdf`, `${LEGACY}:vm pdf`, "a:vm-pdf"]) {
      expect(() => parseExtractorIdAliases(raw, served), raw).toThrow(/entries must be/);
    }
    expect(() => parseExtractorIdAliases(`${LEGACY}:vm-pdf,${LEGACY}:kreuzberg`, served)).toThrow(/twice/);
    expect(() => parseExtractorIdAliases(Array.from({ length: 17 }, (_, i) => `old-${i}:vm-pdf`).join(","), served)).toThrow(/at most/);
  });

  it("configureExtractorIdAliases reads the env, installs, and installs nothing on error", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => configureExtractorIdAliases(served, { DOCSLURP_EXTRACTOR_ID_ALIASES: `${LEGACY}:nope` })).toThrow();
    expect(canonicalExtractorId(LEGACY)).toBe(LEGACY);
    configureExtractorIdAliases(served, { DOCSLURP_EXTRACTOR_ID_ALIASES: `${LEGACY}:vm-pdf` });
    expect(canonicalExtractorId(LEGACY)).toBe("vm-pdf");
    expect(canonicalExtractorId("kreuzberg")).toBe("kreuzberg");
  });

  it("installExtractorIdAliases re-checks the built-in rules on a hand-built map", () => {
    expect(() => installExtractorIdAliases(new Map([["kreuzberg", "vm-pdf"]]))).toThrow();
    expect(() => installExtractorIdAliases(new Map([[LEGACY, "not-built-in"]]))).toThrow();
    expect(canonicalExtractorId("kreuzberg")).toBe("kreuzberg");
  });
});

describe("document extraction configs under an alias", () => {
  const install = () => installExtractorIdAliases(new Map([[LEGACY, "vm-pdf"]]));

  it("without an alias, the legacy id's options fail strict parsing as before", () => {
    expect(documentExtractionConfigSchema.safeParse(legacyConfig()).success).toBe(false);
  });

  it("rewrites ids everywhere a config names an extractor, deduping order lists", () => {
    install();
    const parsed = documentExtractionConfigSchema.parse({
      ...legacyConfig(), order: { pdf: [LEGACY, "vm-pdf", "kreuzberg"] }, components: { tables: [LEGACY], formulas: [], images: [LEGACY] }, pages: [LEGACY], enrich: [LEGACY],
    });
    expect(parsed).toMatchObject({
      order: { pdf: ["vm-pdf", "kreuzberg"] }, components: { tables: ["vm-pdf"], images: ["vm-pdf"] }, pages: ["vm-pdf"], enrich: ["vm-pdf"],
      voting: { enabled: true, secondary: "vm-pdf" }, options: { "vm-pdf": { images: { enabled: true, minWidth: 20, minHeight: 30 } } },
    });
    expect(Object.keys(parsed.options)).toEqual(["vm-pdf"]);
  });

  it("leaves unknown ids and keys alone, so they still fail where they did", () => {
    install();
    expect(documentExtractionConfigSchema.safeParse({ options: { mystery: {} } }).success).toBe(false);
    expect(documentExtractionConfigSchema.parse({ order: { pdf: ["mystery"] } }).order.pdf).toEqual(["mystery"]);
    const untouched = { order: { pdf: ["kreuzberg"] } };
    expect(normalizeDocumentExtractionAliases(untouched)).toBe(untouched);
  });

  it("never merges two option sets: alias and target keys together stay invalid", () => {
    install();
    const both = { options: { [LEGACY]: { images: { enabled: true } }, "vm-pdf": { images: { enabled: false } } } };
    expect(documentExtractionConfigSchema.safeParse(both).success).toBe(false);
    // A stored row with both keeps the target's options and drops the alias key loudly.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stored = sanitizeStoredPipeline({ documentExtraction: both }, "project w1") as { documentExtraction: { options: Record<string, unknown> } };
    expect(stored.documentExtraction.options).toEqual({ "vm-pdf": { images: { enabled: false } } });
    expect(error.mock.calls[0]![0]).toContain(`documentExtraction.options.${LEGACY}`);
  });

  it("incoming overrides are written back with the canonical id", () => {
    install();
    const overrides = pipelineFeatureOverridesSchema.parse({ documentExtraction: legacyConfig() }) as { documentExtraction: Record<string, unknown> };
    expect(JSON.stringify(overrides)).not.toContain(LEGACY);
    expect(overrides.documentExtraction).toMatchObject({ order: { pdf: ["vm-pdf", "kreuzberg"] }, voting: { secondary: "vm-pdf" } });
  });

  it("stored project and run pipelines keep the renamed extractor's options instead of dropping them", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    install();
    const stored = { documentExtraction: legacyConfig(), instructions: `keep "${LEGACY}" in free text` };
    const sanitized = sanitizeStoredPipeline(stored, "run r1") as typeof stored;
    expect(sanitized.documentExtraction.options).toEqual({ "vm-pdf": { images: { enabled: true, minWidth: 20, minHeight: 30 } } });
    expect(sanitized.instructions).toBe(`keep "${LEGACY}" in free text`);
    const features = normalizeStoredPipelineFeatures(stored as never, "run r1");
    expect(features.documentExtraction).toMatchObject({ order: { pdf: ["vm-pdf", "kreuzberg"] }, voting: { secondary: "vm-pdf" }, options: { "vm-pdf": { images: { enabled: true } } } });
    expect(error).not.toHaveBeenCalled();
    // The stored row object itself is not mutated.
    expect(stored.documentExtraction.order.pdf).toEqual([LEGACY, "kreuzberg"]);
  });
});
