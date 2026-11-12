import { describe, expect, it } from "vitest";
import { hasCurrentParseDecision, PARSE_SOURCE_SCAN_VERSION, parseSourceRescanRequired } from "../parse-source-decision.js";

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

describe("rescan API error", () => {
  it("the stable code, safe copy and details cross the public boundary", async () => {
    const { API_ERROR_PUBLIC_MESSAGES, publicApiErrorDetails } = await import("../api-error.js");
    expect(API_ERROR_PUBLIC_MESSAGES.quarantine_rescan_required).toBe("This document needs to be scanned again; reprocess it to view pages");
    expect(publicApiErrorDetails({ category: "quarantine-rescan-required", action: "reprocess", raw: "worker said x" })).toEqual({ category: "quarantine-rescan-required", action: "reprocess" });
  });
});
