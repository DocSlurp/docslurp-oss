import { afterEach, describe, expect, it, vi } from "vitest";

import modal, { parserVmCapabilities } from "../providers/modal/index.js";
import { initializeParserSandbox, parserImageCapability, parserImageHasCapability } from "../startup.js";
import type { SandboxSession } from "../types.js";

// Council G M4: the startup probe runs worker/scripts/parser-vm-contract.mjs in the VM and accepts only the parser-vm@5
// contract (with a qpdf quarantine can decrypt PDFs with). An older image (parser-vm@1, @2, @3), empty output or a failed run
// must fail the probe and stop startup.
const env = {
  DOCSLURP_PARSER_SANDBOX: "modal",
  MODAL_TOKEN_ID: "control-token",
  MODAL_TOKEN_SECRET: "control-secret",
  DOCSLURP_MODAL_IMAGE: `ghcr.io/docslurp/worker-full@sha256:${"a".repeat(64)}`,
};

function fakeSession(stdout: string, exitCode = 0) {
  const close = vi.fn(async () => {});
  const session = { run: vi.fn(async () => ({ exitCode, stdout, stderr: "" })), close } as unknown as SandboxSession;
  vi.spyOn(modal, "openSession").mockResolvedValue(session);
  return close;
}

afterEach(() => vi.restoreAllMocks());

describe("modal startup probe requires the parser-vm@5 contract", () => {
  it.each([
    ["parser-vm@1", JSON.stringify({ protocol: "parser-vm@1" }), 0],
    // Owner decision (PR #339): an image before the PDF decryption and nested-archive walk, or without a usable qpdf.
    ["parser-vm@2 (no PDF encryption check)", JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: "12.2.0" }), 0],
    ["parser-vm@4 (no inline chart guest, #369 council r4 M3)", JSON.stringify({ protocol: "parser-vm@4", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: "12.2.0" }), 0],
    // Council N-H1: an image without the encryption-structure check (no `encryptConflict`) is the previous contract.
    ["parser-vm@3 (no encryption structure check)", JSON.stringify({ protocol: "parser-vm@3", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: "12.2.0" }), 0],
    ["no qpdf", JSON.stringify({ protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: null }), 0],
    ["qpdf older than 11", JSON.stringify({ protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: "10.6.3" }), 0],
    ["qpdf version malformed", JSON.stringify({ protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: "12.2.0; rm" }), 0],
    ["empty output", "", 0],
    ["no protocol", "{}", 0],
    ["link protections off", JSON.stringify({ qpdfVersion: "12.2.0", protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 0, symlinks: 0 } }), 0],
    ["hardlink protection off", JSON.stringify({ qpdfVersion: "12.2.0", protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 0, symlinks: 1 } }), 0],
    ["link protections absent", JSON.stringify({ qpdfVersion: "12.2.0", protocol: "parser-vm@5", uid: 10001 }), 0],
    ["link protections null", JSON.stringify({ qpdfVersion: "12.2.0", protocol: "parser-vm@5", uid: 10001, links: { hardlinks: null, symlinks: null } }), 0],
    ["link protections malformed", JSON.stringify({ qpdfVersion: "12.2.0", protocol: "parser-vm@5", uid: 10001, links: { hardlinks: "1", symlinks: 2 } }), 0],
    ["parser-vm@5 run as root", JSON.stringify({ qpdfVersion: "12.2.0", protocol: "parser-vm@5", uid: 0 }), 0],
    // Recheck S #5: set-id core dumps must read back off, and Yama ptrace restricted when present.
    ["suid_dumpable not 0", JSON.stringify({ qpdfVersion: "12.2.0", protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 2, ptraceScope: 1 } }), 0],
    ["suid_dumpable unknown", JSON.stringify({ qpdfVersion: "12.2.0", protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: null, ptraceScope: 1 } }), 0],
    ["hardening absent", JSON.stringify({ qpdfVersion: "12.2.0", protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 } }), 0],
    ["ptrace_scope 0", JSON.stringify({ qpdfVersion: "12.2.0", protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 0 } }), 0],
    ["parser-vm@5 without a uid", JSON.stringify({ protocol: "parser-vm@5" }), 0],
    ["a failed run", JSON.stringify({ protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: "12.2.0" }), 1],
  ])("%s fails the probe and refuses startup", async (_, stdout, exitCode) => {
    const close = fakeSession(stdout, exitCode);
    const probe = await modal.probe(modal.readConfig(env));
    expect(probe.ok).toBe(false);
    expect(close).toHaveBeenCalled();
    await expect(initializeParserSandbox(env, "linux")).rejects.toThrow(/parser isolation unavailable/);
  });

  it("passes without Yama (ptrace_scope null) when everything else holds", async () => {
    fakeSession(JSON.stringify({ protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: null }, qpdfVersion: "12.2.0" }));
    expect((await modal.probe(modal.readConfig(env))).ok).toBe(true);
  });

  it("parser-vm@5 passes", async () => {
    fakeSession(JSON.stringify({ protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: "12.2.0" }));
    expect((await modal.probe(modal.readConfig(env))).ok).toBe(true);
    await expect(initializeParserSandbox(env, "linux")).resolves.toMatchObject({ provider: modal });
  });
});

describe("parser image capabilities (council #387 M1)", () => {
  const good = { protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: "12.2.0" };
  it("reports the image's capabilities, and an older @5 image without the field reports none", async () => {
    fakeSession(JSON.stringify({ ...good, capabilities: ["inline-command-budget", "BAD cap", 7, "inline-command-budget"] }));
    expect((await modal.probe(modal.readConfig(env))).capabilities).toEqual(["inline-command-budget"]);
    const withCap = await initializeParserSandbox(env, "linux");
    expect(parserImageHasCapability("inline-command-budget", withCap)).toBe(true);
    fakeSession(JSON.stringify(good));
    const older = await initializeParserSandbox(env, "linux");
    expect(older.capabilities).toEqual([]);
    // The image still starts (other parsing is unaffected); inline charts are refused per document instead.
    expect(parserImageHasCapability("inline-command-budget", older)).toBe(false);
    expect(parserVmCapabilities("inline-command-budget")).toEqual([]);
  });
  it("a local sandbox runs this checkout's guest scripts: every capability it knows; none known is no capability", () => {
    expect(parserImageHasCapability("inline-command-budget", { isolation: { location: "local" } } as never)).toBe(true);
    // No sandbox known: fail closed (council #387 r2 L1).
    expect(parserImageHasCapability("inline-command-budget", undefined)).toBe(false);
    expect(parserImageCapability("inline-command-budget", undefined)).toBe("sandbox-not-ready");
    expect(parserImageCapability("inline-command-budget", { isolation: { location: "remote" }, capabilities: [] } as never)).toBe("missing");
  });
});

describe("modal startup probe requires a job root the parser user can write (real-Modal check F4)", () => {
  it("refuses with a clear message when uid 10001 cannot create a directory under a job root", async () => {
    const good = JSON.stringify({ protocol: "parser-vm@5", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: "12.2.0" });
    const close = vi.fn(async () => {});
    const run = vi.fn(async (command: { binary: string; args: string[] }) => command.binary === "/bin/sh"
      ? { exitCode: 1, stdout: "", stderr: "mkdir: Permission denied" }
      : { exitCode: 0, stdout: good, stderr: "" });
    vi.spyOn(modal, "openSession").mockResolvedValue({ run, close } as unknown as SandboxSession);
    const probe = await modal.probe(modal.readConfig(env));
    expect(probe.ok).toBe(false);
    expect(probe.detail).toMatch(/job root .* is not writable by the parser user \(uid 10001\).*TMPDIR/);
    const roots = run.mock.calls.filter(([command]) => command.binary === "/bin/sh").map(([command]) => command.args[3]);
    expect(roots.length).toBeGreaterThan(0);
  });
});
