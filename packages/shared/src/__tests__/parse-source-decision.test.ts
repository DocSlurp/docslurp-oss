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
      { parse_source_scan_version: 999, parse_source_sha256: a },
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
    expect(quarantineRequired(env({ NODE_ENV: "development", DOCSLURP_SERVICE_PROFILE: "service", QUARANTINE_ENABLED: "false" }))).toBe(true);
  });
});

describe("rescan API error", () => {
  it("the stable code, safe copy and details cross the public boundary", async () => {
    const { API_ERROR_PUBLIC_MESSAGES, publicApiErrorDetails } = await import("../api-error.js");
    expect(API_ERROR_PUBLIC_MESSAGES.quarantine_rescan_required).toBe("This document needs to be scanned again; reprocess it to view pages");
    expect(publicApiErrorDetails({ category: "quarantine-rescan-required", action: "reprocess", raw: "worker said x" })).toEqual({ category: "quarantine-rescan-required", action: "reprocess" });
  });
});

describe("operator-owned malware scanning entitlement", () => {
  const enterprise = "b53c2ff7-bc5e-4ab1-a33e-d6294dc02d66";
  const standard = "706aa517-ec47-47de-bd25-e77acf57c613";
  const validated = { parse_source_scan_version: -1, parse_source_sha256: "a".repeat(64), source_sha256: "a".repeat(64) };

  it("requires the organization's current entitlement even on a previously validated source", () => {
    const env = { NODE_ENV: "production", DOCSLURP_MALWARE_SCAN_ORGS: enterprise };
    expect(parseSourceRescanRequired({ ...validated, org_id: standard }, env)).toBe(false);
    expect(parseSourceRescanRequired({ ...validated, org_id: enterprise }, env)).toBe(true);
    expect(parseSourceRescanRequired({ ...validated, org_id: enterprise, parse_source_scan_version: 1 }, env)).toBe(true);
    expect(parseSourceRescanRequired({ ...validated, org_id: enterprise, parse_source_scan_version: 2 }, env)).toBe(false);
    expect(parseSourceRescanRequired({ ...validated, org_id: standard }, { ...env, DOCSLURP_MALWARE_SCAN_ORGS: standard })).toBe(true);
    expect(parseSourceRescanRequired({ ...validated, org_id: standard, source_sha256: "b".repeat(64) }, env)).toBe(true);
    expect(parseSourceRescanRequired({ ...validated, org_id: standard, parse_source_key: "copy" }, env)).toBe(true);
  });

  it("requires a scan for unknown organizations and absent or invalid configuration", () => {
    for (const roster of [undefined, "", "invalid", enterprise + ","]) {
      expect(parseSourceRescanRequired({ ...validated, org_id: standard }, { NODE_ENV: "production", DOCSLURP_MALWARE_SCAN_ORGS: roster })).toBe(true);
    }
    expect(parseSourceRescanRequired({ ...validated, org_id: standard }, { NODE_ENV: "production", DOCSLURP_MALWARE_SCAN_ORGS: "none" })).toBe(false);
    expect(parseSourceRescanRequired(validated, { NODE_ENV: "production", DOCSLURP_MALWARE_SCAN_ORGS: "none" })).toBe(true);
  });
});
