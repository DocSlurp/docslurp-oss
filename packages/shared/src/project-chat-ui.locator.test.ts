import { describe, expect, it } from "vitest";
import { projectChatCitationsSchema } from "./project-chat-ui.js";

describe("projectChatCitationSchema locator", () => {
  const base = { id: "c1", filename: "a.pdf", pageNumber: 1, score: 0.9, text: "x" };

  it("keeps a valid locator", () => {
    const parsed = projectChatCitationsSchema.parse({
      citations: [{ ...base, locator: { kind: "sheet", range: "B7:D8" } }],
    });
    expect(parsed.citations[0].locator).toMatchObject({ kind: "sheet", range: "B7:D8" });
  });

  it("drops a malformed locator without rejecting the list", () => {
    const parsed = projectChatCitationsSchema.parse({
      citations: [{ ...base, locator: { kind: "media", startSeconds: -5 } }, { ...base, id: "c2" }],
    });
    expect(parsed.citations).toHaveLength(2);
    expect(parsed.citations[0].locator).toBeNull();
  });
});
