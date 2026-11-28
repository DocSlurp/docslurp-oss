import { describe, expect, it } from "vitest";

import { assessClamDatabaseHealth, resolveMalwareScanPolicy } from "../tools/runner.js";

describe("malware scan policy", () => {
  it.each(["production", "staging", "preview", "prodution"])("falls back to 24 hours for an out-of-range or malformed age even when startup was skipped in %s", (NODE_ENV) => {
    for (const value of ["999999", "169", "168.9", "99h", "48abc", "1+999", "072", "0", "-1", " "]) {
      expect(resolveMalwareScanPolicy({ NODE_ENV, DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS: value }).maxSignatureAgeHours).toBe(24);
    }
  });
  it("defaults to 24 hours and accepts up to 168 when deployed", () => {
    expect(resolveMalwareScanPolicy({ NODE_ENV: "production" }).maxSignatureAgeHours).toBe(24);
    expect(resolveMalwareScanPolicy({ NODE_ENV: "production", DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS: "48" }).maxSignatureAgeHours).toBe(48);
    expect(resolveMalwareScanPolicy({ NODE_ENV: "production", DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS: "72" }).maxSignatureAgeHours).toBe(72);
    expect(resolveMalwareScanPolicy({ NODE_ENV: "production", DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS: "168" }).maxSignatureAgeHours).toBe(168);
  });
  it("retains stricter deployed ages and development controls", () => {
    expect(resolveMalwareScanPolicy({ NODE_ENV: "staging", DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS: "12" }).maxSignatureAgeHours).toBe(12);
    expect(resolveMalwareScanPolicy({ NODE_ENV: "development", DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS: "168" }).maxSignatureAgeHours).toBe(168);
  });
  it("uses VM-local scanning and fails closed on stale definitions in production by default", () => {
    const policy = resolveMalwareScanPolicy({ NODE_ENV: "production" });

    expect(policy.requireDaemon).toBe(false);
    expect(policy.failOpenOnStaleDefinitions).toBe(false);
    expect(policy.maxSignatureAgeHours).toBe(24);
  });

  // #398: stale definitions block scanning by default everywhere; only an explicit development opt-in warns.
  it("fails closed on stale definitions in local development by default", () => {
    const policy = resolveMalwareScanPolicy({ NODE_ENV: "development" });

    expect(policy.requireDaemon).toBe(false);
    expect(policy.failOpenOnStaleDefinitions).toBe(false);
  });

  it.each(["development", "test"])("honours an explicit stale-definition opt-in in %s", (nodeEnv) => {
    expect(resolveMalwareScanPolicy({ NODE_ENV: nodeEnv, DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB: "true" }).failOpenOnStaleDefinitions).toBe(true);
  });

  it.each(["production", "staging"])("never fails open on stale definitions in %s, even when asked", (nodeEnv) => {
    expect(resolveMalwareScanPolicy({ NODE_ENV: nodeEnv, DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB: "true" }).failOpenOnStaleDefinitions).toBe(false);
  });
});

describe("clam signature database health", () => {
  it("marks recent signatures as fresh", () => {
    const health = assessClamDatabaseHealth({
      maxSignatureAgeHours: 24,
      nowMs: new Date("2026-04-10T12:00:00.000Z").getTime(),
      entries: [
        {
          path: "/var/lib/clamav/main.cvd",
          updatedAtMs: new Date("2026-04-10T02:00:00.000Z").getTime()
        }
      ]
    });

    expect(health).toEqual({
      status: "fresh",
      updatedAt: "2026-04-10T02:00:00.000Z",
      ageHours: 10,
      source: "/var/lib/clamav/main.cvd"
    });
  });

  it("marks old signatures as stale", () => {
    const health = assessClamDatabaseHealth({
      maxSignatureAgeHours: 24,
      nowMs: new Date("2026-04-10T12:00:00.000Z").getTime(),
      entries: [
        {
          path: "/var/lib/clamav/daily.cld",
          updatedAtMs: new Date("2026-04-08T00:00:00.000Z").getTime()
        }
      ]
    });

    expect(health.status).toBe("stale");
    expect(health.ageHours).toBe(60);
  });

  it("marks missing signature sets explicitly", () => {
    const health = assessClamDatabaseHealth({
      maxSignatureAgeHours: 24,
      entries: []
    });

    expect(health).toEqual({
      status: "missing",
      updatedAt: null,
      ageHours: null,
      source: null
    });
  });
});
