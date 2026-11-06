import { afterEach, describe, expect, it, vi } from "vitest";

import modal from "../providers/modal/index.js";
import { initializeParserSandbox } from "../startup.js";
import type { SandboxSession } from "../types.js";

// Council G M4: the startup probe runs worker/scripts/parser-vm-contract.mjs in the VM and accepts only the parser-vm@2
// contract. An older image (parser-vm@1), empty output or a failed run must fail the probe and stop startup.
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

describe("modal startup probe requires the parser-vm@2 contract", () => {
  it.each([
    ["parser-vm@1", JSON.stringify({ protocol: "parser-vm@1" }), 0],
    ["empty output", "", 0],
    ["no protocol", "{}", 0],
    ["link protections off", JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 0, symlinks: 0 } }), 0],
    ["hardlink protection off", JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 0, symlinks: 1 } }), 0],
    ["link protections absent", JSON.stringify({ protocol: "parser-vm@2", uid: 10001 }), 0],
    ["link protections null", JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: null, symlinks: null } }), 0],
    ["link protections malformed", JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: "1", symlinks: 2 } }), 0],
    ["parser-vm@2 run as root", JSON.stringify({ protocol: "parser-vm@2", uid: 0 }), 0],
    // Recheck S #5: set-id core dumps must read back off, and Yama ptrace restricted when present.
    ["suid_dumpable not 0", JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 2, ptraceScope: 1 } }), 0],
    ["suid_dumpable unknown", JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: null, ptraceScope: 1 } }), 0],
    ["hardening absent", JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 1, symlinks: 1 } }), 0],
    ["ptrace_scope 0", JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 0 } }), 0],
    ["parser-vm@2 without a uid", JSON.stringify({ protocol: "parser-vm@2" }), 0],
    ["a failed run", JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 } }), 1],
  ])("%s fails the probe and refuses startup", async (_, stdout, exitCode) => {
    const close = fakeSession(stdout, exitCode);
    const probe = await modal.probe(modal.readConfig(env));
    expect(probe.ok).toBe(false);
    expect(close).toHaveBeenCalled();
    await expect(initializeParserSandbox(env, "linux")).rejects.toThrow(/parser isolation unavailable/);
  });

  it("passes without Yama (ptrace_scope null) when everything else holds", async () => {
    fakeSession(JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: null } }));
    expect((await modal.probe(modal.readConfig(env))).ok).toBe(true);
  });

  it("parser-vm@2 passes", async () => {
    fakeSession(JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 } }));
    expect((await modal.probe(modal.readConfig(env))).ok).toBe(true);
    await expect(initializeParserSandbox(env, "linux")).resolves.toMatchObject({ provider: modal });
  });
});

describe("modal startup probe requires a job root the parser user can write (real-Modal check F4)", () => {
  it("refuses with a clear message when uid 10001 cannot create a directory under a job root", async () => {
    const good = JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 } });
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
