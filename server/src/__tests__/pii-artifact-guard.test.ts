import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseArtifactUri } from "@docslurp/shared";

const sqlMock = vi.fn();
const listAccessibleWorkspaceIdsMock = vi.fn();

vi.mock("../db.js", () => ({
  sql: Object.assign(sqlMock, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    listen: vi.fn(),
    begin: vi.fn(),
  }),
}));

vi.mock("../config.js", () => ({ env: { s3Bucket: "bucket" } }));

vi.mock("../lib/artifacts.js", () => ({
  parseArtifactUri,
  getArtifactText: vi.fn(async () => ""),
  getArtifactJson: vi.fn(async () => null),
}));

vi.mock("../lib/file-urls.js", () => ({
  fileUrlForArtifact: vi.fn((uri: string) => ({ url: `proxy:${uri}`, expiresAt: "" })),
}));

vi.mock("../services/organizations.js", () => ({
  getWorkspaceAccess: vi.fn(),
  listAccessibleWorkspaceIds: listAccessibleWorkspaceIdsMock,
  listEditableWorkspaceIds: vi.fn(async () => []),
}));

vi.mock("../services/run-creation.js", () => ({
  runCreation: { create: vi.fn() },
}));

const { withheldArtifactUrisFromMetadata } = await import("../services/pii-artifact-guard.js");
const { exportDocumentArtifacts, userCanAccessArtifactUri } = await import("../services/documents.js");

/** Flatten a tagged-template call (and nested fragments) into its SQL text and values. */
function render(call: unknown[]): { text: string; values: unknown[] } {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  let text = "";
  const flat: unknown[] = [];
  strings.forEach((part, index) => {
    text += part;
    if (index >= values.length) return;
    const value = values[index];
    const nested = sqlMock.mock.calls.find((candidate, i) => sqlMock.mock.results[i]?.value === value);
    if (nested) {
      const inner = render(nested);
      text += inner.text;
      flat.push(...inner.values);
    } else {
      text += "$";
      flat.push(value);
    }
  });
  return { text, values: flat };
}

beforeEach(() => {
  sqlMock.mockReset();
  listAccessibleWorkspaceIdsMock.mockReset();
  listAccessibleWorkspaceIdsMock.mockResolvedValue(["ws-1"]);
});

describe("withheldArtifactUrisFromMetadata", () => {
  it("reads the worker's withheld list and ignores malformed metadata", () => {
    expect([...withheldArtifactUrisFromMetadata({ pii: { withheldArtifactUris: ["s3://b/a", 4] } })]).toEqual(["s3://b/a"]);
    expect(withheldArtifactUrisFromMetadata({ pii: { reviewRequired: true } }).size).toBe(0);
    expect(withheldArtifactUrisFromMetadata(null).size).toBe(0);
  });
});

describe("artifact access under the PII policy", () => {
  it("refuses any URI a document in the caller's workspaces withholds", async () => {
    sqlMock.mockImplementation((...call: unknown[]) => {
      // Fragments are returned as tokens; the outer query resolves to a row.
      const { text } = render(call);
      return text.includes("as accessible") ? Promise.resolve([{ accessible: false }]) : { fragment: text };
    });

    await expect(userCanAccessArtifactUri("s3://bucket/u1/run-1/vision/doc-1.json", "user-1")).resolves.toBe(false);

    const outer = sqlMock.mock.calls.find((call) => render(call).text.includes("as accessible"));
    const { text, values } = render(outer!);
    expect(text).toContain("and not exists(");
    expect(text).toContain("withheldArtifactUris");
    expect(values).toContainEqual(["s3://bucket/u1/run-1/vision/doc-1.json"]);
  });

  it("drops withheld artifacts from document exports", async () => {
    sqlMock
      .mockResolvedValueOnce([{
        id: "doc-1", run_id: "run-1", source_key: "src",
        metadata: { pii: { redacted: true, withheldArtifactUris: ["s3://bucket/vision.json"] } },
      }])
      .mockResolvedValueOnce([{
        id: "run-1",
        artifacts: {
          "doc-1:markdown": "s3://bucket/markdown.md",
          "doc-1:vision": "s3://bucket/vision.json",
          "doc-2:markdown": "s3://bucket/other.md",
        },
      }]);

    const exported = await exportDocumentArtifacts(["doc-1"], "user-1");

    expect(exported["doc-1"]).toEqual([
      { slot: "doc-1:markdown", uri: "s3://bucket/markdown.md", url: "proxy:s3://bucket/markdown.md" },
    ]);
  });
});
