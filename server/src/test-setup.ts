// Billing suites price through an installed provider with test prices (shared `DISTINCT_TEST_PRICING`: the published
// per-page prices, arbitrary values for every other rule), never a deployment's private rules. Suites that need other
// numbers install their own (`installTestPricing`).
import { vi } from "vitest";
import { assertDisposableTestDatabaseUrl, DISTINCT_TEST_PRICING, installTestPricing } from "@docslurp/shared";

// Gated database tests (#400) write and drop data: TEST_DATABASE_URL must name a disposable database on a loopback host
// (scripts/run-database-tests.mjs creates one per file). A wrong URL fails every test here instead of reaching it.
if (process.env.TEST_DATABASE_URL) assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);

installTestPricing(DISTINCT_TEST_PRICING);

// Credential lookups on route auth use a dedicated pool (lib/auth-lookup-pool.ts) to DATABASE_URL. In tests they go
// through the suite's own transports instead, where each lookup ran before that pool: API-key lookups through
// `./db.js`'s sql and OAuth token lookups (`unsafe`) through `./lib/auth.js`'s appDbPool, mocked or not.
// bounded-lookup.test.ts and credential-lookup-bounds.pg.test.ts exercise the real pool.
vi.mock("./lib/auth-lookup-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/auth-lookup-pool.js")>();
  const db = await import("./db.js");
  const lookup = (strings: TemplateStringsArray, ...values: unknown[]) => (db.sql as unknown as (...args: unknown[]) => unknown)(strings, ...values);
  lookup.unsafe = (text: string, values: unknown[]) => Object.assign(
    import("./lib/auth.js").then(({ appDbPool }) => appDbPool.query(text, values)).then((result: { rows: unknown[] }) => result.rows),
    { cancel: () => {} },
  );
  return { ...actual, authLookupSql: () => lookup as unknown as ReturnType<typeof actual.authLookupSql> };
});
