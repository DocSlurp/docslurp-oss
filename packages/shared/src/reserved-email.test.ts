import { describe, expect, it } from "vitest";

import { isReservedTestEmail } from "./reserved-email.js";

describe("isReservedTestEmail", () => {
  it("matches reserved domains that can never receive mail", () => {
    for (const email of ["admin@docslurp.local", "a@run1.invalid", "qa@agent.test", "x@example.com", "x@sub.example.org", "root@localhost", " A@Example.NET "]) {
      expect(isReservedTestEmail(email)).toBe(true);
    }
  });

  it("leaves real domains alone", () => {
    for (const email of ["ada@acme.dev", "x@examples.com", "x@testing.io", "x@local.dev", "noreply@docslurp.io", "no-at-sign"]) {
      expect(isReservedTestEmail(email)).toBe(false);
    }
  });
});
