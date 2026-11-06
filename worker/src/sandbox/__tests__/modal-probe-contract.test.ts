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
    ["parser-vm@2 run as root", JSON.stringify({ protocol: "parser-vm@2", uid: 0 }), 0],
    ["parser-vm@2 without a uid", JSON.stringify({ protocol: "parser-vm@2" }), 0],
    ["a failed run", JSON.stringify({ protocol: "parser-vm@2", uid: 10001 }), 1],
  ])("%s fails the probe and refuses startup", async (_, stdout, exitCode) => {
    const close = fakeSession(stdout, exitCode);
    const probe = await modal.probe(modal.readConfig(env));
    expect(probe.ok).toBe(false);
    expect(close).toHaveBeenCalled();
    await expect(initializeParserSandbox(env, "linux")).rejects.toThrow(/parser isolation unavailable/);
  });

  it("parser-vm@2 passes", async () => {
    fakeSession(JSON.stringify({ protocol: "parser-vm@2", uid: 10001 }));
    expect((await modal.probe(modal.readConfig(env))).ok).toBe(true);
    await expect(initializeParserSandbox(env, "linux")).resolves.toMatchObject({ provider: modal });
  });
});
