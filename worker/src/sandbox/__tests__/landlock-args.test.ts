import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { landrunArgs } from "../providers/landlock/index.js";

describe("landrunArgs", () => {
  const args = landrunArgs({ binary: "pdfinfo", args: ["a.pdf"], env: {}, readablePaths: [], writablePaths: [] });
  const roGrant = args[args.indexOf("--ro") + 1] ?? "";

  it("grants the fontconfig cache read-only when it exists", () => {
    if (!existsSync("/var/cache/fontconfig")) return;
    expect(roGrant.split(",")).toContain("/var/cache/fontconfig");
    expect(args).not.toContain("--rw");
  });

  it("omits the fontconfig cache when it does not exist", () => {
    if (existsSync("/var/cache/fontconfig")) return;
    expect(args.join(" ")).not.toContain("/var/cache/fontconfig");
  });
});
