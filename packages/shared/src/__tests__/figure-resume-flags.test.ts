import { describe, expect, it } from "vitest";

import { figureResumeChatEnabled, figureResumeDeployEnabled } from "../figure-resume.js";

// R2-M5: the chat's resume offer needs the runner on and its own switch (off until the app's proposal card ships).
describe("figure resume flags", () => {
  it("the chat offer is off unless both DOCSLURP_FIGURE_RESUME and DOCSLURP_FIGURE_RESUME_CHAT are on", () => {
    expect(figureResumeChatEnabled({})).toBe(false);
    expect(figureResumeChatEnabled({ DOCSLURP_FIGURE_RESUME: "1" })).toBe(false);
    expect(figureResumeChatEnabled({ DOCSLURP_FIGURE_RESUME_CHAT: "1" })).toBe(false);
    expect(figureResumeChatEnabled({ DOCSLURP_FIGURE_RESUME: "1", DOCSLURP_FIGURE_RESUME_CHAT: "on" })).toBe(true);
    expect(figureResumeDeployEnabled({ DOCSLURP_FIGURE_RESUME: "maybe" })).toBe(false);
  });
});
