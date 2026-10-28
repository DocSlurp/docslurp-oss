import { describe, expect, it } from "vitest";

import { classifyEmail, isReservedTestEmail, staffEmailDomains, testEmailPatterns } from "../services/account-kind.js";

describe("account kind rules", () => {
  it("treats reserved test domains as test accounts (seed, e2e, pressure test)", () => {
    for (const email of ["admin@docslurp.local", "run-1-a@e2e.docslurp.local", "pressure-20261028-1@docslurp.invalid", "x@example.com", "x@foo.test", "x@localhost"]) {
      expect(isReservedTestEmail(email)).toBe(true);
      expect(classifyEmail(email, false)).toEqual({ kind: "test", reason: "reserved test email domain" });
    }
    for (const email of ["ada@acme.dev", "x@examples.com", "x@testing.io", "x@local.dev"]) expect(isReservedTestEmail(email)).toBe(false);
  });

  it("matches configured test patterns literally apart from *", () => {
    const env = { TEST_ACCOUNT_EMAIL_PATTERNS: "qa+*@gmail.com, *@mailinator.com" };
    expect(classifyEmail("QA+agent7@gmail.com", false, env)?.kind).toBe("test");
    expect(classifyEmail("anyone@mailinator.com", false, env)?.kind).toBe("test");
    expect(classifyEmail("qaXagent@gmail.com", false, env)).toBeNull();
    expect(testEmailPatterns({ TEST_ACCOUNT_EMAIL_PATTERNS: "a.(b)*@c.d" })[0]!.test("a.(b)zz@c.d")).toBe(true);
  });

  it("recognizes staff only from a verified address", () => {
    expect(classifyEmail("dan@docslurp.io", true, {})).toEqual({ kind: "staff", reason: "STAFF_EMAIL_DOMAINS" });
    expect(classifyEmail("dan@docslurp.io", false, {})).toBeNull();
    expect(classifyEmail("boss@corp.example.org", true, {})?.kind).toBe("test");
    expect(classifyEmail("ops@partner.dev", true, { ADMIN_EMAILS: "ops@partner.dev", STAFF_EMAIL_DOMAINS: "" })).toEqual({ kind: "staff", reason: "ADMIN_EMAILS" });
    expect(staffEmailDomains({ STAFF_EMAIL_DOMAINS: "" })).toEqual([]);
    expect(classifyEmail("ada@acme.dev", true, {})).toBeNull();
  });
});
