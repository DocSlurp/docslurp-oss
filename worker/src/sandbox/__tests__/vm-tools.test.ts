import { afterEach, describe, expect, it, vi } from "vitest";

import modal from "../providers/modal/index.js";
import { setDefaultParserSandbox } from "../startup.js";
import type { ParserSandboxProvider, SandboxSession } from "../types.js";
import { CommandRunner } from "../../tools/runner.js";

// Validation N7: availability of a tool for a VM command comes from the VM image (the probe's contract), not the worker's PATH.
afterEach(() => { setDefaultParserSandbox(undefined); vi.restoreAllMocks(); });

const remote = { filesystem: true, network: "full", processes: true, location: "remote" } as const;

describe("VM tool availability", () => {
  it("the Modal probe returns the tools the VM image reports, dropping malformed names", async () => {
    vi.spyOn(modal, "openSession").mockResolvedValue({
      run: async () => ({ exitCode: 0, stdout: JSON.stringify({ protocol: "parser-vm@4", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: "12.2.0", tools: ["pandoc", "ffmpeg", "../x", 7] }), stderr: "" }),
      close: async () => {},
    } as unknown as SandboxSession);
    const probe = await modal.probe(modal.readConfig({ MODAL_TOKEN_ID: "t", MODAL_TOKEN_SECRET: "s", DOCSLURP_MODAL_IMAGE: `ghcr.io/docslurp/worker-full@sha256:${"a".repeat(64)}` }));
    expect(probe).toMatchObject({ ok: true, tools: ["pandoc", "ffmpeg"] });
  });

  it("with a remote sandbox registered, a bare tool is available only if the VM reported it, whatever the host PATH has", async () => {
    setDefaultParserSandbox({ provider: { id: "modal" } as unknown as ParserSandboxProvider, config: {}, isolation: remote, tools: ["pandoc"] });
    const runner = new CommandRunner();
    expect((await runner.plan("pandoc")).available).toBe(true);
    // `sh` is on every host PATH; the VM did not report it.
    expect((await runner.plan("sh")).available).toBe(false);
  });

  it("without a remote sandbox, the host PATH decides as before", async () => {
    expect((await new CommandRunner().plan("sh")).available).toBe(true);
  });
});
