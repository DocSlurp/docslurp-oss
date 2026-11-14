/**
 * Test-only guard (#400): gated database tests create, truncate and drop data, so TEST_DATABASE_URL must name a
 * disposable database on this machine. scripts/run-database-tests.mjs creates one per file (`dbtest_<n>` on a loopback
 * server); a developer running a file by hand must use a loopback host and a database whose name says it is disposable
 * (a `test`, `tmp` or `scratch` word, or the runner's `dbtest_` prefix), never a development or shared database. The
 * server and worker test setups call this whenever TEST_DATABASE_URL is set, so a mistyped URL fails every test loudly
 * instead of writing to the wrong database.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "::1", "[::1]"]);
const DISPOSABLE_NAME = /^dbtest_[a-z0-9_]+$|(^|[_-])(test|tests|tmp|scratch)([_-]|\d|$)/i;

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTestDatabaseError";
  }
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase()) || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** Throws unless `raw` is a postgres URL on a loopback host naming a disposable database. Never prints credentials. */
export function assertDisposableTestDatabaseUrl(raw: string | undefined, variable = "TEST_DATABASE_URL"): void {
  if (!raw) throw new UnsafeTestDatabaseError(`${variable} is not set`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTestDatabaseError(`${variable} is not a valid URL`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new UnsafeTestDatabaseError(`${variable} must be a postgres:// URL`);
  if (!isLoopback(url.hostname)) {
    throw new UnsafeTestDatabaseError(
      `${variable} points at host '${url.hostname || "(none)"}'; gated tests write and drop data, so use a loopback host (localhost, 127.0.0.1 or ::1)`,
    );
  }
  let database = "";
  try {
    database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    database = "";
  }
  if (!DISPOSABLE_NAME.test(database)) {
    throw new UnsafeTestDatabaseError(
      `${variable} names database '${database || "(none)"}', which does not look disposable; gated tests write and drop data, ` +
        "so point it at a throwaway database whose name has a test, tmp or scratch word (scripts/run-database-tests.mjs creates dbtest_<n>)",
    );
  }
}
