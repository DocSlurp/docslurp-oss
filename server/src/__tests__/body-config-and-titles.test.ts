import { afterEach, describe, expect, it, vi } from "vitest";

const { queries } = vi.hoisted(() => ({ queries: [] as string[] }));
vi.mock("../db.js", () => ({
  sql: Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    // The project's auto-title row, then its completed documents.
    return queries.length === 1 ? [{ name: "notes", phase: "upload" }] : [{ filename: "notes.txt" }];
  }), { json: (value: unknown) => value, array: (value: unknown) => value }),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); queries.length = 0; });

describe("title re-derivation seeds", () => {
  it("never seeds a title from a URL-origin document's filename", async () => {
    const { nameProjectFromUpload } = await import("../services/project-naming.js");
    await nameProjectFromUpload({ projectId: "p1", filenames: ["notes.txt"] }).catch(() => null);
    const documentsQuery = queries.find((query) => query.includes("from documents"));
    expect(documentsQuery).toContain("metadata ->> 'sourceUrl') is null");
  });
});

describe("multipart cap clamp", () => {
  it("warns at startup when MAX_MULTIPART_UPLOAD_BYTES is clamped to the 100 MiB in-memory ceiling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.stubEnv("MAX_MULTIPART_UPLOAD_BYTES", String(400 * 1024 * 1024));
      vi.resetModules();
      const { env } = await import("../config.js");
      expect(env.maxMultipartUploadBytes).toBe(100 * 1024 * 1024);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("MAX_MULTIPART_UPLOAD_BYTES=419430400 is above");
    } finally {
      warn.mockRestore();
    }
  });
});
