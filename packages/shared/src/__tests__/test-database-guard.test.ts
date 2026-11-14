import { describe, expect, it } from "vitest";
import { assertDisposableTestDatabaseUrl, UnsafeTestDatabaseError } from "../test-database-guard.js";

describe("assertDisposableTestDatabaseUrl (#400)", () => {
  it.each([
    "postgres://u:p@127.0.0.1:5432/dbtest_3",
    "postgres://u:p@localhost/docslurp_test",
    "postgresql://u@[::1]:5432/test_runs",
    "postgres://u@127.0.0.2/scratch-db",
    "postgres://u@localhost/docslurp_tmp_1",
    "postgres://u@localhost/my_tests",
  ])("accepts %s", (url) => {
    expect(() => assertDisposableTestDatabaseUrl(url)).not.toThrow();
  });

  it.each([
    ["unset", undefined, /not set/],
    ["not a URL", "localhost:5432/dbtest_1", /valid URL|postgres:\/\//],
    ["a remote host", "postgres://u:secret@db.example.com/dbtest_1", /loopback/],
    ["a private address", "postgres://u@10.0.0.5/docslurp_test", /loopback/],
    ["a host that only starts like loopback", "postgres://u@127.0.0.1.example.com/dbtest_1", /loopback/],
    ["a unix socket with no host", "postgres:///dbtest_1?host=/var/run/postgresql", /loopback/],
    ["the development database", "postgres://u@localhost/docslurp", /does not look disposable/],
    ["a name that merely contains test", "postgres://u@localhost/latest", /does not look disposable/],
    ["no database", "postgres://u@localhost:5432", /does not look disposable/],
    ["the postgres maintenance database", "postgres://u@localhost/postgres", /does not look disposable/],
    ["another scheme", "mysql://u@localhost/dbtest_1", /postgres:\/\//],
  ])("refuses %s", (_label, url, message) => {
    expect(() => assertDisposableTestDatabaseUrl(url)).toThrow(UnsafeTestDatabaseError);
    expect(() => assertDisposableTestDatabaseUrl(url)).toThrow(message);
  });

  it("never echoes credentials", () => {
    try {
      assertDisposableTestDatabaseUrl("postgres://admin:hunter2@db.example.com/prod");
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("hunter2");
    }
  });
});
