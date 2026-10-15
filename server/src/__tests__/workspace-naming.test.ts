import { describe, expect, it, vi } from "vitest";
vi.mock("../db.js", () => ({ sql: vi.fn() }));
import { workspaceSubject, workspaceChatSubject } from "../services/workspace-naming.js";
describe("workspace subjects", () => {
  it("uses an extracted heading and bounds long titles", () => {
    expect(workspaceSubject("# Annual energy report")).toBe("Annual energy report");
    expect(workspaceSubject("word ".repeat(40))!.length).toBeLessThanOrEqual(72);
    expect(workspaceSubject("Copyright")).toBeNull();
  });
  it("names the first conversation from the user's subject", () => {
    expect(workspaceChatSubject("Can you summarize renewal obligations? ")).toBe("summarize renewal obligations");
  });
});
