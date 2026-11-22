import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const bundledApplication = fileURLToPath(new URL("../../../server/", import.meta.url));

/** App-only assertions run in the application CI when the source is supplied. */
export function hasTestApplication(): boolean {
  const configured = process.env.DOCSLURP_TEST_APPLICATION_ROOT;
  if (!configured) return existsSync(join(bundledApplication, "src"));
  if (!existsSync(testApplicationPath("src"))) throw new Error("DOCSLURP_TEST_APPLICATION_ROOT must contain the application src directory");
  return true;
}

/** Select the owning application's source tree for cross-package contract tests. */
export function testApplicationPath(...segments: string[]): string {
  const directory = process.env.DOCSLURP_TEST_APPLICATION_ROOT ?? bundledApplication;
  if (!isAbsolute(directory)) throw new Error("DOCSLURP_TEST_APPLICATION_ROOT must be an absolute directory");
  return join(directory, ...segments);
}
