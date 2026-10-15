import { describe, expect, it } from "vitest";

import { assessClamDatabaseHealth, resolveMalwareScanPolicy } from "../tools/runner.js";

describe("malware scan policy", () => {
  it("requires clamd and fails closed on stale definitions in production by default", () => {
    const policy = resolveMalwareScanPolicy({ NODE_ENV: "production" });

    expect(policy.requireDaemon).toBe(true);
    expect(policy.failOpenOnStaleDefinitions).toBe(false);
    expect(policy.maxSignatureAgeHours).toBe(24);
  });

  it("keeps stale-definition warnings non-blocking in local development by default", () => {
    const policy = resolveMalwareScanPolicy({ NODE_ENV: "development" });

    expect(policy.requireDaemon).toBe(false);
    expect(policy.failOpenOnStaleDefinitions).toBe(true);
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
