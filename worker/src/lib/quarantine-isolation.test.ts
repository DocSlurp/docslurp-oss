import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanDocumentForQuarantine } from "./quarantine.js";
import type { CommandRunner } from "../tools/runner.js";
afterEach(() => vi.unstubAllEnvs());
const policy = { quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 10, quarantineMaxArchiveDepth: 3, quarantineMaxTotalUncompressedBytes: 1000, quarantineMaxSingleEntryBytes: 1000, quarantineMaxExpansionRatio: 10, databaseUrl: "credential-sentinel", openAiApiKey: "credential-sentinel", storage: { secret: "credential-sentinel" } };
function args(run: ReturnType<typeof vi.fn>) {
  return { documentId: "d", filename: "x.pdf", declaredMimeType: "application/pdf", bytes: Buffer.from("%PDF"), tempFile: "/unused-input.pdf", policy, runner: { run, scanForMalware: async () => ({ status: "clean", engine: "clamscan", available: true }) } as unknown as CommandRunner };
}
describe("quarantine production boundary", () => {
  it("stages only policy fields despite a full secret-bearing config at the caller", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const run = vi.fn(async (plan) => {
      const encoded = await readFile(plan.args[2], "utf8");
      expect(encoded).not.toContain("credential-sentinel");
      expect(Object.keys(JSON.parse(encoded).policy)).toHaveLength(6);
      await writeFile(plan.args[3], JSON.stringify({ sniffed: { mimeType: "application/pdf", container: null, encoding: null }, archive: null }));
    });
    expect((await scanDocumentForQuarantine(args(run))).decision).toBe("accepted"); expect(run).toHaveBeenCalledOnce();
  });
  it("refuses VM failures rather than inspecting hostile archives on the host", async () => {
    vi.stubEnv("NODE_ENV", "production"); const run = vi.fn().mockRejectedValue(new Error("revoked VM key"));
    await expect(scanDocumentForQuarantine(args(run))).rejects.toThrow(/revoked/);
  });
  it("rejects malformed archive fields from a compromised guest", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const run = vi.fn(async (plan) => writeFile(plan.args[3], JSON.stringify({ sniffed: { mimeType: null, container: "zip", encoding: null }, archive: { issues: [], kind: "zip", suspicious: false, inspectable: true, entryCount: -1 } })));
    await expect(scanDocumentForQuarantine(args(run))).rejects.toThrow(/invalid quarantine archive size/);
  });
  it("rejects a forged sniff result from a compromised guest: unknown fields, containers, encodings or MIME syntax", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const sniffed of [
      { mimeType: "application/pdf", container: null, encoding: null, trusted: true },
      { mimeType: "application/pdf", container: "tar", encoding: null },
      { mimeType: "text/plain", container: null, encoding: "ebcdic" },
      { mimeType: "application/pdf; charset=x", container: null, encoding: null },
      { mimeType: "a".repeat(300), container: null, encoding: null },
      null,
    ]) {
      const run = vi.fn(async (plan) => writeFile(plan.args[3], JSON.stringify({ sniffed, archive: null })));
      await expect(scanDocumentForQuarantine(args(run)), JSON.stringify(sniffed)).rejects.toThrow(/invalid quarantine MIME result/);
    }
  });
});

