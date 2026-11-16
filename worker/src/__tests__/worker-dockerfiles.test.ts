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

  // #398 council: an unset NODE_ENV counts as development, so a bare `docker run` of a published image must not get the
  // development posture (fail-open defaults, overrides honoured).
  it.each(["Dockerfile", "Dockerfile.lean", "Dockerfile.full"])("%s bakes NODE_ENV=production into the runtime stage", async (filename) => {
    const dockerfile = await readFile(path.join(root, filename), "utf8");
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    expect(runtime).toMatch(/^ENV NODE_ENV=production$/m);
    expect(runtime.match(/^ENV NODE_ENV=/gm)).toHaveLength(1);
    expect(runtime.indexOf("ENV NODE_ENV=production")).toBeLessThan(runtime.indexOf("\nUSER docslurp"));
  });

  it.each(["worker/Dockerfile", "worker/Dockerfile.lean", "worker/Dockerfile.full", "server/Dockerfile"])(
    "%s copies pnpm patches wherever it copies the lockfile",
    async (filename) => {
      const dockerfile = await readFile(path.join(root, "..", filename), "utf8");
      const copies = dockerfile.split("\n").filter((line) => line.startsWith("COPY package.json pnpm-lock.yaml"));
      expect(copies.length).toBeGreaterThan(0);
      // pnpm install --frozen-lockfile fails with ENOENT on a patchedDependencies entry whose file is missing.
      expect(dockerfile.match(/^COPY patches \.\/patches$/gm)?.length ?? 0).toBe(copies.length);
    },
  );
});
