import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
it.skipIf(!url)("executes native PostgreSQL lifecycle contention and rollback assertions", () => {
  const output = execFileSync("pnpm", ["exec", "tsx", "db/tests/run-control-admission.mjs"], {
    env: { ...process.env, DATABASE_URL: url!, TEST_DATABASE_URL: url! },
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(output).toContain("Native PostgreSQL: retry/recover/resume contention, rollback, immutable boost passed.");
}, 65_000);
