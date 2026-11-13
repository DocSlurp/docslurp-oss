import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectQuarantine, scanDocumentForQuarantine } from "./quarantine.js";
import { CommandExitError } from "../tools/runner.js";
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
      const encoded = await readFile(plan.args.filter((a: string) => !a.startsWith("--"))[2], "utf8");
      expect(encoded).not.toContain("credential-sentinel");
      expect(Object.keys(JSON.parse(encoded).policy)).toHaveLength(6);
      await writeFile(plan.args.filter((a: string) => !a.startsWith("--"))[3], JSON.stringify({ sniffed: { mimeType: "application/pdf", container: null, encoding: null }, archive: null, pdf: { encryptName: false, encryptConflict: false } }));
    });
    expect((await scanDocumentForQuarantine(args(run))).decision).toBe("accepted"); expect(run).toHaveBeenCalledOnce();
  });
  it("refuses VM failures rather than inspecting hostile archives on the host", async () => {
    vi.stubEnv("NODE_ENV", "production"); const run = vi.fn().mockRejectedValue(new Error("revoked VM key"));
    await expect(scanDocumentForQuarantine(args(run))).rejects.toThrow(/revoked/);
  });
  it("rejects malformed archive fields from a compromised guest", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const run = vi.fn(async (plan) => writeFile(plan.args.filter((a: string) => !a.startsWith("--"))[3], JSON.stringify({ sniffed: { mimeType: null, container: "zip", encoding: null }, archive: { issues: [], kind: "zip", suspicious: false, inspectable: true, entryCount: -1 } })));
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
      const run = vi.fn(async (plan) => writeFile(plan.args.filter((a: string) => !a.startsWith("--"))[3], JSON.stringify({ sniffed, archive: null, pdf: null })));
      await expect(scanDocumentForQuarantine(args(run)), JSON.stringify(sniffed)).rejects.toThrow(/invalid quarantine MIME result/);
    }
  });
  it("refuses a guest result without the PDF encryption check (an older image), or a forged one, never reading it as not encrypted", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const pdf of [undefined, { encryptName: "no" }, { encryptName: false, trusted: true }, [], "false"]) {
      const run = vi.fn(async (plan) => writeFile(plan.args.filter((a: string) => !a.startsWith("--"))[3], JSON.stringify({ sniffed: { mimeType: "application/pdf", container: null, encoding: null }, archive: null, ...(pdf === undefined ? {} : { pdf }) })));
      await expect(scanDocumentForQuarantine(args(run)), JSON.stringify(pdf)).rejects.toThrow(/invalid quarantine PDF result/);
    }
  });

  it("rejects forged nesting counts from a compromised guest", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const archive = { issues: [], kind: "zip", suspicious: false, inspectable: true, entryCount: 1, totalCompressedBytes: 1, totalUncompressedBytes: 1, maxEntryUncompressedBytes: 1, maxPathDepth: 1, compressionRatio: 1, nestedContainers: -1 };
    const run = vi.fn(async (plan) => writeFile(plan.args.filter((a: string) => !a.startsWith("--"))[3], JSON.stringify({ sniffed: { mimeType: null, container: "zip", encoding: null }, archive, pdf: null })));
    await expect(scanDocumentForQuarantine(args(run))).rejects.toThrow(/invalid quarantine nesting count/);
  });
});

describe("inline charts never cost the inspection (council r3 L1)", () => {
  const ok = { sniffed: { mimeType: "image/svg+xml", container: null, encoding: "utf-8" }, archive: null, pdf: null };
  const base = { bytes: Buffer.from("<svg/>"), filename: "c.svg", tempFile: "/unused.svg", policy, charts: { kind: "svg" as const, diagrams: true } };
  const out = (plan: { args: string[] }) => plan.args.filter((a) => !a.startsWith("--"))[3]!;
  it("a guest that wrote its inspection, then exited non-zero in the chart step: the inspection stands, charts refused", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const run = vi.fn(async (plan) => { await writeFile(out(plan), JSON.stringify(ok)); throw new CommandExitError("node (3)", 3); });
    const inspection = await inspectQuarantine({ ...base, runner: { run } as unknown as CommandRunner });
    expect(inspection.sniffed.mimeType).toBe("image/svg+xml");
    expect(inspection.charts).toEqual({ status: "refused", reason: "worker-failed", ms: 0 });
    expect(run).toHaveBeenCalledOnce();
  });
  it("still fails without charts asked, on a timeout (no exit code), or with no inspection written", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const wrote = vi.fn(async (plan) => { await writeFile(out(plan), JSON.stringify(ok)); throw new CommandExitError("node (3)", 3); });
    const { charts: _c, ...noCharts } = base;
    await expect(inspectQuarantine({ ...noCharts, runner: { run: wrote } as unknown as CommandRunner })).rejects.toThrow(/node \(3\)/);
    const timedOut = vi.fn(async (plan) => { await writeFile(out(plan), JSON.stringify(ok)); throw new CommandExitError("node (unknown)", null); });
    await expect(inspectQuarantine({ ...base, runner: { run: timedOut } as unknown as CommandRunner })).rejects.toThrow(/unknown/);
    const nothing = vi.fn(async () => { throw new CommandExitError("node (1)", 1); });
    await expect(inspectQuarantine({ ...base, runner: { run: nothing } as unknown as CommandRunner })).rejects.toThrow(/node \(1\)/);
  });
});
