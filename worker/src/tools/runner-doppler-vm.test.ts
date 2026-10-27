import { afterEach, describe, it, expect, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })));
vi.mock("../sandbox/providers/modal/doppler-vm.js", () => ({ executeDopplerVm: execute, VM_TIMEOUT_MS: 180_000 }));
import { CommandRunner } from "./runner.js";
import { SandboxSessionScope, runWithSandboxScope } from "../sandbox/session-context.js";

afterEach(() => vi.unstubAllEnvs());

describe("mandatory document VM dispatch", () => {
  it("precedes activity sessions, custom openers and vector backend dispatch", async () => {
    vi.stubEnv("DOCSLURP_DOPPLER_VM_IMAGE", `registry/doppler@sha256:${"a".repeat(64)}`);
    const open = vi.fn(); const scoped = vi.fn(); const runner = new CommandRunner({ openSession: open });
    const plan = await runner.dopplerMarkdown("/input.webp", "/output.png");
    // A backend-shaped command and bundle env must not change VM dispatch or reach its env.
    plan.binary = "python3"; plan.args = ["vector-backend.py"]; plan.bundleEnv = { SECRET: "forbidden" };
    const launched = await runWithSandboxScope(new SandboxSessionScope(scoped), () => runner.launch(plan));
    expect("remote" in launched).toBe(true);
    if ("remote" in launched) await launched.remote;
    expect(open).not.toHaveBeenCalled(); expect(scoped).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith({ operation: "doppler-markdown", input: "/input.webp", output: "/output.png" }, undefined);
  });
});
