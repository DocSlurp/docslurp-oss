import { runVisionRequest } from "../tools/vision-runtime.js";
import { runDocuments } from "../pipeline/checkpoints.js";
import type { Document } from "../models.js";
import { describe, expect, it, vi } from "vitest";
import { assertResourceCapacity, ResourceCapacityError, withResourceCapacityGuard } from "../lib/resource-capacity.js";
import { fetchWithProviderRetry } from "../lib/provider-retry.js";
import { isDocumentLevelFailure } from "../lib/document-failure.js";
import { CommandRunner } from "../tools/runner.js";

const pressure = () => { throw new ResourceCapacityError(); };

describe("resource admission at execution", () => {
  it("permits cached bookkeeping but refuses a later cache-bypassing request before spend admission", async () => {
    const send = vi.fn(async () => new Response("ok"));
    const admit = vi.fn(async () => {});
    await withResourceCapacityGuard(pressure, async () => {
      expect(await Promise.resolve("cached manifest")).toBe("cached manifest");
      await expect(fetchWithProviderRetry("https://provider.invalid", {}, {
        provider: "test", label: "cache bypass", maxRetries: 0, fetchImpl: send,
        gate: { admit, failed() {}, async unbilled() { return true; } },
      })).rejects.toBeInstanceOf(ResourceCapacityError);
    });
    expect(send).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("returns an unsent billing admission when pressure develops during the gate", async () => {
    let congested = false;
    const send = vi.fn();
    const unbilled = vi.fn(async () => true);
    await expect(withResourceCapacityGuard(() => { if (congested) pressure(); }, () =>
      fetchWithProviderRetry("https://provider.invalid", {}, {
        provider: "test", label: "delayed gate", maxRetries: 0, fetchImpl: send,
        gate: { async admit() { congested = true; }, failed() {}, unbilled },
      }),
    )).rejects.toBeInstanceOf(ResourceCapacityError);
    expect(send).not.toHaveBeenCalled();
    expect(unbilled).toHaveBeenCalledExactlyOnceWith("cancelled");
  });

  it("refuses command execution before staging or reading an oversized/malicious source", async () => {
    const runner = new CommandRunner();
    await expect(withResourceCapacityGuard(pressure, () => runner.run({
      binary: "not-a-real-parser", args: ["/hostile/customer.pdf"], available: true,
    }))).rejects.toBeInstanceOf(ResourceCapacityError);
  });

  it("guards direct launch paths used by streams, artifacts and malware scans", async () => {
    const runner = new CommandRunner();
    await expect(withResourceCapacityGuard(pressure, () => runner.launch({
      binary: "not-a-real-parser", args: ["/hostile/customer.pdf"], available: true,
    }))).rejects.toBeInstanceOf(ResourceCapacityError);
  });

  it("rechecks pressure after asynchronous sandbox acquisition and releases without dispatch", async () => {
    let congested = false;
    const run = vi.fn();
    const close = vi.fn(async () => {});
    const runner = new CommandRunner({ openSession: async () => {
      await Promise.resolve();
      congested = true;
      return { providerId: "test-vm", isolation: { location: "remote" }, run, close } as never;
    } });
    await expect(withResourceCapacityGuard(() => { if (congested) pressure(); }, () => runner.launch({
      binary: "not-a-real-parser", args: [], available: true,
    }))).rejects.toBeInstanceOf(ResourceCapacityError);
    expect(run).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("isolates simultaneous activity guards and leaves outer contexts unchanged", async () => {
    const check = vi.fn();
    const rejected = withResourceCapacityGuard(pressure, async () => {
      await Promise.resolve();
      expect(() => assertResourceCapacity()).toThrow(ResourceCapacityError);
    });
    const accepted = withResourceCapacityGuard(check, async () => {
      await Promise.resolve();
      assertResourceCapacity();
    });
    await Promise.all([rejected, accepted]);
    assertResourceCapacity();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("drains accepted document work and stops new admissions after pressure", async () => {
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => { finish = resolve; });
    const docs = ["one", "two", "three"].map((id) => ({ id }) as Document);
    const started: string[] = [];
    let persisted = false;
    let settled = false;
    const pending = runDocuments(docs, 2, async (document) => {
      started.push(document.id);
      if (document.id === "one") { await Promise.resolve(); throw new ResourceCapacityError(); }
      await slow;
      persisted = true;
    });
    void pending.catch(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await expect(pending).rejects.toBeInstanceOf(ResourceCapacityError);
    expect(persisted).toBe(true);
    expect(started).toEqual(["one", "two"]);
  });

  it("never treats allocation pressure as a bad document", () => {
    expect(isDocumentLevelFailure(new Error("command admission", { cause: new ResourceCapacityError() }))).toBe(false);
  });
});

it("returns local vision's gate admission when the real runner refuses dispatch", async () => {
  const runner = new CommandRunner();
  vi.spyOn(runner, "florence2").mockResolvedValue({ binary: "unused", args: [], available: true });
  const failed = vi.fn();
  const unbilled = vi.fn(async () => true);
  const admit = vi.fn(async () => {});
  await expect(withResourceCapacityGuard(pressure, () => runVisionRequest({
    imagePath: "/hostile/scan.png", outputPath: "/unused/output.json", mimeType: "image/png",
    runner, runtime: "local-cli", model: "microsoft/Florence-2-base-ft", prompt: "<OCR>",
    baseUrl: null, apiKey: "", gate: { admit, failed, unbilled },
  }))).rejects.toBeInstanceOf(ResourceCapacityError);
  expect(admit).toHaveBeenCalledOnce();
  expect(unbilled).toHaveBeenCalledExactlyOnceWith("cancelled");
  expect(failed).not.toHaveBeenCalled();
});
