import { describe, expect, it } from "vitest";
import { hasCurrentParseDecision, PARSE_SOURCE_SCAN_VERSION, parseSourceRescanRequired, quarantineRequired } from "../parse-source-decision.js";

const a = "a".repeat(64);
const c = "c".repeat(64);
const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

describe("parse source decision (PR #339)", () => {
  it("a current decision bound to the bytes parsers read is current; anything else needs a rescan in production", () => {
    expect(hasCurrentParseDecision({ parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION, parse_source_sha256: a, source_sha256: a })).toBe(true);
    expect(hasCurrentParseDecision({ parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION, parse_source_sha256: a, source_sha256: null })).toBe(true);
    expect(hasCurrentParseDecision({ parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION, parse_source_key: "k", parse_source_sha256: c, source_sha256: a })).toBe(true);
    for (const row of [
      {},
      { parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION },
      { parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION, parse_source_sha256: "x" },
      { parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION, parse_source_sha256: c, source_sha256: a },
      { parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION + 1, parse_source_sha256: a },
    ]) {
      expect(hasCurrentParseDecision(row)).toBe(false);
      expect(parseSourceRescanRequired(row, prod)).toBe(true);
      expect(parseSourceRescanRequired(row, { NODE_ENV: "production", QUARANTINE_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(true);
      expect(parseSourceRescanRequired(row, { NODE_ENV: "development", QUARANTINE_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
    }
  });
});

describe("quarantineRequired (#398: disabling quarantine is development-only)", () => {
  const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

  it("honours an explicit off value only in development or test", () => {
    for (const nodeEnv of ["", "development", "test", " Development ", "TEST"]) {
      for (const off of ["0", "false", "no", "off", " OFF "]) expect(quarantineRequired(env({ NODE_ENV: nodeEnv, QUARANTINE_ENABLED: off }))).toBe(false);
    }
    expect(quarantineRequired(env({ NODE_ENV: "development" }))).toBe(true);
    expect(quarantineRequired(env({ NODE_ENV: "development", QUARANTINE_ENABLED: "true" }))).toBe(true);
  });

  it.each(["production", "staging", "preview", "Production", "\u00a0development", "\ufeffdevelopment", "dev elopment", "prod"])(
    "is always required under NODE_ENV=%j, whatever QUARANTINE_ENABLED says",
    (nodeEnv) => {
      for (const off of ["0", "false", "no", "off"]) {
        expect(quarantineRequired(env({ NODE_ENV: nodeEnv, QUARANTINE_ENABLED: off }))).toBe(true);
        expect(parseSourceRescanRequired({}, env({ NODE_ENV: nodeEnv, QUARANTINE_ENABLED: off }))).toBe(true);
      }
    },
  );

  it("is always required under the service profile, even with NODE_ENV=development", () => {
    expect(quarantineRequired(env({ NODE_ENV: "development", DOCSLURP_PROFILE: "service", QUARANTINE_ENABLED: "false" }))).toBe(true);
  });
});

describe("rescan API error", () => {
  it("the stable code, safe copy and details cross the public boundary", async () => {
    const { API_ERROR_PUBLIC_MESSAGES, publicApiErrorDetails } = await import("../api-error.js");
    expect(API_ERROR_PUBLIC_MESSAGES.quarantine_rescan_required).toBe("This document needs to be scanned again; reprocess it to view pages");
    expect(publicApiErrorDetails({ category: "quarantine-rescan-required", action: "reprocess", raw: "worker said x" })).toEqual({ category: "quarantine-rescan-required", action: "reprocess" });
  });
});
