import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mapValidationIssues } from "./validation.js";
import { publicApiErrorDetails } from "@docslurp/shared";

describe("validation constraint transport", () => {
  it("preserves reviewed zod constraints through mapper and response sanitizer", () => {
    const result = z.object({ title: z.string().max(3), count: z.number().min(1) }).safeParse({ title: "private text", count: 0 });
    if (result.success) throw new Error("Expected invalid input");
    const details = publicApiErrorDetails({ issues: mapValidationIssues(result.error) });
    expect(details?.issues).toMatchObject([
      { path: "title", code: "too_big", maximum: 3, origin: "string" },
      { path: "count", code: "too_small", minimum: 1, origin: "number" },
    ]);
    expect(JSON.stringify(details)).not.toContain("private text");
  });
});
