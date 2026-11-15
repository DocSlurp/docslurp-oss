import { assertDisposableTestDatabaseUrl } from "./test-database-guard.js";

if (process.env.TEST_DATABASE_URL) assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);
