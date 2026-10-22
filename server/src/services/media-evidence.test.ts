import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchResultSchema } from "@docslurp/shared";
const mocks = vi.hoisted(() => ({ sql: vi.fn(), read: vi.fn() }));
vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("../lib/artifacts.js", () => ({ getArtifactText: mocks.read }));
import { loadMediaEvidence } from "./media-evidence.js";

beforeEach(() => { mocks.sql.mockReset(); mocks.read.mockReset(); });
describe("media evidence", () => {
  it("returns cited extracted frame descriptions even for a one-page video", async () => {
    mocks.sql.mockResolvedValue([{ filename: "tour.mp4", text: "[00:03] On screen: a wide shot of a room.", total_chars: 50000, artifacts: null, metadata: {} }]);
    const result = await loadMediaEvidence("selected", "video", 10);
    expect(result?.results[0].text).toContain("On screen:");
    expect(searchResultSchema.safeParse(result?.results[0]).success).toBe(true);
    expect(result?.nextOffset).toBe(10 + result!.results[0].text.length);
    const [strings, ...params] = mocks.sql.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toContain("d.workspace_id =");
    expect(sql).toContain("d.status = 'completed'");
    expect(sql).toContain("d.superseded_at is null");
    expect(params).toEqual([11, "video", "selected"]);
  });

  it("does not read raw or policy-withheld media artifacts", async () => {
    mocks.sql.mockResolvedValue([{ filename: "tour.mp4", text: "[00:03] On screen: [REDACTED]", total_chars: 38,
      artifacts: { "video:media-summary": "s3://b/summary", "video:media-transcript": "s3://b/raw" },
      metadata: { pii: { withheldArtifactUris: ["s3://b/summary"] } } }]);
    await loadMediaEvidence("selected", "video");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("returns unavailable without loading artifacts when there is no eligible media document", async () => {
    mocks.sql.mockResolvedValue([]);
    expect(await loadMediaEvidence("selected", "foreign-or-blocked")).toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
