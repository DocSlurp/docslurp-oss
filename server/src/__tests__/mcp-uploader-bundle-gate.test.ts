import { describe, expect, it, vi } from "vitest";

// An empty generated bundle (never built) must remove the uploader from every surface, even with the flag on.
vi.mock("../mcp-ui/upload-bundle.generated.js", () => ({ UPLOAD_HTML: "", UPLOAD_HTML_SHA256: "0".repeat(64) }));

const { env } = await import("../config.js");
const { mcpManifest, mcpTools } = await import("../services/mcp-catalog.js");

describe("openUploader bundle gate", () => {
  it("is not offered when the flag is on but the widget bundle is empty", () => {
    env.mcpAppsUiEnabled = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(mcpManifest("https://example.test", ["ingest"]).capabilities.map(tool => tool.id)).not.toContain("openUploader");
      expect(mcpTools("https://example.test").some(tool => tool.id === "openUploader")).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
    } finally { env.mcpAppsUiEnabled = false; error.mockRestore(); }
  });
});
