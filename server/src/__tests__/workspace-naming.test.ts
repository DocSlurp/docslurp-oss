import { describe, expect, it, vi } from "vitest";
vi.mock("../db.js", () => ({ sql: vi.fn() }));
import { inferWorkspaceTitleFromFilenames, workspaceSubject, workspaceChatSubject, workspaceSummarySubject } from "../services/workspace-naming.js";
describe("workspace subjects", () => {
  it("uses an extracted heading and bounds long titles", () => {
    expect(workspaceSubject("# Annual energy report")).toBe("Annual energy report");
    expect(workspaceSubject("word ".repeat(40))!.length).toBeLessThanOrEqual(72);
    expect(workspaceSubject("Copyright")).toBeNull();
  });
  it("names the first conversation from the user's subject", () => {
    expect(workspaceChatSubject("Can you summarize renewal obligations? ")).toBe("summarize renewal obligations");
  });
  it("titles from the subject of a stored document summary", () => {
    expect(workspaceSummarySubject("This document is a quarterly revenue report for Acme Corp, covering sales and margins.")).toBe("Quarterly revenue report for Acme Corp");
    expect(workspaceSummarySubject("The paper presents a method for sparse attention that scales to long inputs.")).toBe("Method for sparse attention");
    expect(workspaceSummarySubject("Acme's 2025 employee handbook describes leave, benefits and conduct rules.")).toBe("Acme's 2025 employee handbook");
    expect(workspaceSummarySubject("Sampled document overview (3 of 90 pages; excerpts may be clipped). This transcript records a board meeting about budgets.")).toBe("Board meeting about budgets");
    expect(workspaceSummarySubject("This document describes overview.")).toBeNull();
    expect(workspaceSummarySubject("")).toBeNull();
  });
  it("titles a batch from its first filename and the count of the rest", () => {
    expect(inferWorkspaceTitleFromFilenames(["lease_2026.pdf", "rider.pdf", "invoice.pdf"])).toBe("Lease 2026 + 2 more");
  });
});
