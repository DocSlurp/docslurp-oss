import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const bundledMigrations = fileURLToPath(new URL("../../../server/db/migrations/", import.meta.url));

/** Locate the owning application's migration files when testing the worker against its schema. */
export function testMigrationPath(filename = ""): string {
  const directory = process.env.DOCSLURP_TEST_MIGRATIONS_DIR ?? bundledMigrations;
  if (!isAbsolute(directory)) throw new Error("DOCSLURP_TEST_MIGRATIONS_DIR must be an absolute directory");
  return join(directory, filename);
}
