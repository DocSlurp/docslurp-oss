import { beforeEach, describe, expect, it, vi } from "vitest";

const queries: { text: string; values: unknown[] }[] = [];
let scripted: unknown[][] = [];
const accessible = vi.fn<(userId: string) => Promise<string[]>>();

vi.mock("../db.js", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?"), values });
    return Promise.resolve(scripted.shift() ?? []);
  };
  sql.array = (items: unknown[]) => items;
  return { sql, transaction: vi.fn() };
});
vi.mock("../services/organizations.js", () => ({
  getWorkspaceAccess: vi.fn(),
  listAccessibleWorkspaceIds: accessible,
  listEditableWorkspaceIds: vi.fn()
}));

const { buildDocumentVersionEntries, getDocumentVersionChangelog, getDocumentVersionsWithTags } = await import("../services/documents.js");

const row = (id: string, version: number, extra: Record<string, unknown> = {}) => ({
  id, version_number: version, created_at: `2026-10-0${version}T00:00:00.000Z`, status: "completed",
  page_count: version * 2, filename: "msa.pdf", superseded_at: null, archived_at: null, purged_at: null,
  source_path: "legal/2026", file_size: String(version * 1000), ...extra
});

describe("document version listing", () => {
  beforeEach(() => {
    queries.length = 0;
    scripted = [];
    accessible.mockReset().mockResolvedValue(["ws-1"]);
  });

  it("lists the whole chain newest first from a middle version, in one chain query", async () => {
    scripted = [
      [{ id: "d2", workspace_id: "ws-1", canonical_id: "path:abc" }],
      [row("d1", 1, { superseded_at: "x", archived_at: "x" }), row("d3", 3), row("d2", 2, { superseded_at: "x", archived_at: "x" })]
    ];
    const versions = await getDocumentVersionsWithTags("d2", "user-1");
    expect(versions.map((v) => [v.documentId, v.versionNumber, v.isCurrent, v.archived])).toEqual([
      ["d3", 3, true, false], ["d2", 2, false, true], ["d1", 1, false, true]
    ]);
    expect(versions[0]).toMatchObject({ pageCount: 6, sourcePath: "legal/2026", filename: "msa.pdf", sizeBytes: 3000, status: "completed" });
    expect(queries).toHaveLength(2);
    const chain = queries[1]!;
    expect(chain.text).toContain("workspace_id =");
    expect(chain.text).toContain("canonical_id");
    expect(chain.values).toContain("ws-1");
    expect(chain.values).toContain("path:abc");
  });

  it("lists purged versions as tombstones and never marks them current", () => {
    const versions = buildDocumentVersionEntries([
      row("d1", 1, { purged_at: "x", superseded_at: "x" }) as never,
      row("d2", 2) as never
    ]);
    expect(versions.map((v) => [v.documentId, v.purged, v.isCurrent])).toEqual([["d2", false, true], ["d1", true, false]]);
  });

  it("returns nothing for a document outside the user's workspaces", async () => {
    scripted = [[]];
    expect(await getDocumentVersionsWithTags("other-org-doc", "user-1")).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.values).toContainEqual(["ws-1"]);
    accessible.mockResolvedValue([]);
    expect(await getDocumentVersionsWithTags("d1", "nobody")).toEqual([]);
  });

  it("scopes the chain to the target's workspace, so a shared canonical id elsewhere never leaks in", async () => {
    scripted = [[{ id: "d1", workspace_id: "ws-1", canonical_id: "path:same" }], [row("d1", 1)]];
    await getDocumentVersionsWithTags("d1", "user-1");
    expect(queries[1]!.values).toContain("ws-1");
  });

  it("keeps a processing or failed newest upload out of current: the newest completed live version is", () => {
    for (const status of ["processing", "failed"]) {
      const versions = buildDocumentVersionEntries([row("d4", 4, { status }) as never, row("d3", 3) as never, row("d2", 2, { superseded_at: "x" }) as never]);
      expect(versions.map((v) => [v.versionNumber, v.status, v.isCurrent])).toEqual([[4, status, false], [3, "completed", true], [2, "completed", false]]);
    }
  });

  it("hides sources replaced by a re-index and cancelled re-index attempts, and orders ties by creation time", () => {
    const versions = buildDocumentVersionEntries([
      row("src", 2, { superseded_at: "x", superseded_by_document_id: "child" }) as never,
      row("child", 3, { reindex_of: "src" }) as never,
      row("dead", 3, { reindex_of: "src", status: "cancelled", superseded_at: "x" }) as never,
      row("early", 4, { created_at: "2026-01-01T00:00:00Z" }) as never,
      row("late", 4, { created_at: "2026-02-01T00:00:00Z" }) as never,
      row("v1", 1, { superseded_at: "x" }) as never,
    ]);
    expect(versions.map((v) => v.documentId)).toEqual(["late", "early", "child", "v1"]);
  });

  it("keeps a re-index source visible while its replacement has not superseded it", () => {
    const versions = buildDocumentVersionEntries([
      row("src", 2) as never,
      row("child", 3, { reindex_of: "src", status: "processing" }) as never,
    ]);
    expect(versions.map((v) => v.documentId)).toEqual(["child", "src"]);
  });

  it("falls back to the newest live row when none completed", () => {
    const versions = buildDocumentVersionEntries([row("d1", 1, { status: "processing" }) as never]);
    expect(versions[0]!.isCurrent).toBe(true);
  });
});

describe("changelog baseline access", () => {
  beforeEach(() => {
    queries.length = 0;
    accessible.mockReset().mockResolvedValue(["ws-1"]);
  });
  const docRow = { id: "d3", user_id: "u", org_id: "o", workspace_id: "ws-1", run_id: null, filename: "msa.pdf", mime_type: "application/pdf",
    source_key: "k", status: "completed", extraction_mode: "balanced", page_count: 1, version_number: 3, previous_version_id: "d2",
    metadata: {}, tags: [], created_at: "2026-10-03T00:00:00Z", updated_at: "2026-10-03T00:00:00Z" };
  const chain = [[{ ...row("d3", 3), workspace_id: "ws-1", canonical_id: "path:abc" }], [row("d3", 3), row("d2", 2, { superseded_at: "x" }), row("d1", 1, { purged_at: "x", superseded_at: "x" })]];

  it("returns null for a baseline outside the scoped chain (other workspace or org)", async () => {
    scripted = [[docRow], [], ...chain];
    expect(await getDocumentVersionChangelog("d3", "user-1", "foreign-doc")).toBeNull();
  });

  it("returns null for a purged baseline", async () => {
    scripted = [[docRow], [], ...chain];
    expect(await getDocumentVersionChangelog("d3", "user-1", "d1")).toBeNull();
  });
});
