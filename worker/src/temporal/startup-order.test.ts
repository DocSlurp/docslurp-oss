import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISTINCT_TEST_PRICING, installTestPricing, resetPricingProviderForTests } from "@docslurp/shared";

import { createModalProvider, type ModalSdk } from "../sandbox/providers/modal/index.js";
import type { ParserSandboxProvider } from "../sandbox/types.js";
import { loadPricingThenParserSandbox } from "./startup-order.js";

// Real-Modal validation N2: under the service profile the worker probed the parser VM before loading pricing, and the
// probe's VM-time meter called pricing(), which refuses until a provider is installed, so the worker never started.
const config = { tokenId: "ak-id", tokenSecret: "as-secret", app: "app", image: "debian:trixie-slim", cpu: 1, memoryMb: 512, sessionTimeoutSeconds: 60 };
const command = { binary: "/usr/bin/true", args: [], env: {}, readablePaths: [], inputPaths: [], writablePaths: [], limits: { timeoutMs: 5_000 } };

function stream(text: string): ReadableStream<Uint8Array> { return new ReadableStream({ start(c) { c.enqueue(Buffer.from(text)); c.close(); } }); }

/** A Modal SDK whose VM answers every command with the parser-vm@2 contract, run as uid 10001. */
function fakeSdk(): ModalSdk {
  const sandbox = {
    sandboxId: "sb-test",
    terminate: async () => {},
    filesystem: { makeDirectory: async () => {}, stat: async () => { throw new Error("absent"); }, listFiles: async () => [] },
    exec: async () => ({ stdout: stream(JSON.stringify({ protocol: "parser-vm@3", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 }, qpdfVersion: "12.2.0" })), stderr: stream(""), wait: async () => 0 }),
  };
  return {
    SandboxFilesystemNotFoundError: class extends Error {},
    Sandbox: class { async terminate() {} },
    ModalClient: class {
      apps = { fromName: async () => ({}) };
      images = { fromRegistry: () => ({}) };
      secrets = { fromName: async () => ({}) };
      sandboxes = { create: async () => sandbox };
      close() {}
    },
  } as unknown as ModalSdk;
}

describe("service-profile worker boot: pricing, then the parser probe (validation N2)", () => {
  beforeEach(() => {
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    vi.stubEnv("NODE_ENV", "production");
    resetPricingProviderForTests();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); installTestPricing(DISTINCT_TEST_PRICING); });

  it("a metered VM command cannot be priced before the provider loads: why the probe must not come first", async () => {
    const session = await createModalProvider(async () => fakeSdk()).openSession(config, { activityId: "job" });
    await expect(session.run!(command)).rejects.toThrow(/no pricing provider is installed/);
    await session.close();
  });

  it("starts with a fixture provider: pricing loads first, then the probe passes and later commands are priced", async () => {
    const provider = createModalProvider(async () => fakeSdk());
    const order: string[] = [];
    const sandbox = await loadPricingThenParserSandbox({
      loadPricing: async () => { order.push("pricing"); installTestPricing(DISTINCT_TEST_PRICING); },
      initializeParserSandbox: async () => {
        order.push("parser sandbox");
        const probe = await provider.probe(config);
        expect(probe).toMatchObject({ ok: true });
        return { provider: provider as unknown as ParserSandboxProvider, config, isolation: probe.isolation };
      },
    });
    expect(order).toEqual(["pricing", "parser sandbox"]);
    const session = await sandbox.provider.openSession(config, { activityId: "job" });
    const result = await session.run!(command);
    expect(result.usage).toMatchObject({ provider: "modal", metadata: { providerCostCents: expect.any(Number) } });
    await session.close();
  });

  it("a pricing failure stops startup before any parser VM is created", async () => {
    const init = vi.fn();
    await expect(loadPricingThenParserSandbox({ loadPricing: async () => { throw new Error("no provider"); }, initializeParserSandbox: init })).rejects.toThrow("no provider");
    expect(init).not.toHaveBeenCalled();
  });

  it("the startup probe never prices its VM time, so preflight (which loads no pricing) can run it", async () => {
    expect(await createModalProvider(async () => fakeSdk()).probe(config)).toMatchObject({ ok: true });
  });
});
