import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..");

describe("worker Dockerfiles", () => {
  it.each(["Dockerfile", "Dockerfile.lean", "Dockerfile.full"])(
    "%s runs the worker as the unprivileged docslurp user",
    async (filename) => {
      const dockerfile = await readFile(path.join(root, filename), "utf8");
      const userCreateIndex = dockerfile.indexOf("useradd --system");
      const userIndex = dockerfile.indexOf("\nUSER docslurp");

      expect(userCreateIndex).toBeGreaterThanOrEqual(0);
      expect(userIndex).toBeGreaterThan(userCreateIndex);
      expect(dockerfile).not.toMatch(/\nUSER root\b/);
    },
  );
});
