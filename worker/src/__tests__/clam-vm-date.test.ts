import { afterEach, describe, expect, it } from "vitest";

import { parseClamSignatureDateUtc, parseClamVmDatabaseHealth } from "../tools/runner.js";

// Validation N6: the parser VM prints the signature date in UTC; a non-UTC worker host must not read it in its own zone.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
/** clamscan's ctime-style date, in UTC as the VM prints it. */
const clamDate = (d: Date) => `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;

const originalTz = process.env.TZ;
afterEach(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

describe("ClamAV signature date from the parser VM", () => {
  it("parses explicitly as UTC", () => {
    expect(parseClamSignatureDateUtc("Thu Nov  6 08:21:02 2026")).toBe(Date.UTC(2026, 10, 6, 8, 21, 2));
    expect(parseClamSignatureDateUtc("Thu Nov 16 08:21:02 2026")).toBe(Date.UTC(2026, 10, 16, 8, 21, 2));
    for (const bad of ["", "Nov 6 2026", "Thu Foo  6 08:21:02 2026", "2026-11-06T08:21:02Z"]) expect(parseClamSignatureDateUtc(bad)).toBeNaN();
  });

  it.each(["America/Los_Angeles", "Asia/Tokyo", "UTC"])("an hour-old signature is fresh on a %s host", (tz) => {
    process.env.TZ = tz;
    const health = parseClamVmDatabaseHealth(`ClamAV 1.4.3/27800/${clamDate(new Date(Date.now() - 3_600_000))}`, 48);
    expect(health.status).toBe("fresh");
    expect(health.ageHours).toBeGreaterThan(0.9);
    expect(health.ageHours).toBeLessThan(1.1);
  });
});
