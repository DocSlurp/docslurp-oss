import { readFile, writeFile, access } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import image from "./isolated-image.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), hostDecode: vi.fn(() => { throw new Error("host decoder invoked"); }) }));
vi.mock("sharp", () => ({ default: mocks.hostDecode }));
vi.mock("./runner.js", () => ({ CommandRunner: class { run = mocks.run; } }));
beforeEach(() => { vi.stubEnv("NODE_ENV", "production"); mocks.run.mockReset(); mocks.hostDecode.mockClear(); });
afterEach(() => vi.unstubAllEnvs());

describe("isolated production image processing", () => {
  it("stages encoded bytes and runs the transformation in the parser VM", async () => {
    let requestFile = "";
    mocks.run.mockImplementation(async (plan) => {
      requestFile = plan.args.filter((a: string) => !a.startsWith("--"))[1];
      const request = JSON.parse(await readFile(requestFile, "utf8"));
      expect(request.input).toEqual({ $bytes: Buffer.from("hostile bytes").toString("base64") });
      expect(request.operations).toEqual([{ method: "rotate", args: [] }, { method: "png", args: [] }]);
      expect(request.terminal).toBe("toBuffer");
      await writeFile(plan.args.filter((a: string) => !a.startsWith("--"))[2], JSON.stringify({ $bytes: Buffer.from("guest output").toString("base64") }));
    });
    expect(await image(Buffer.from("hostile bytes")).rotate().png().toBuffer()).toEqual(Buffer.from("guest output"));
    expect(mocks.hostDecode).not.toHaveBeenCalled();
    await expect(access(requestFile)).rejects.toThrow();
  });
  it.each(["revoked VM credential", "VM unavailable", "malformed image rejected in guest"])("never falls back on %s", async (message) => {
    mocks.run.mockRejectedValue(new Error(message));
    await expect(image(Buffer.from("malformed")).metadata()).rejects.toThrow(message);
    expect(mocks.hostDecode).not.toHaveBeenCalled();
  });
  it("rejects oversized bytes before starting a VM", async () => {
    await expect(image(new Uint8Array(64 * 1024 * 1024 + 1)).metadata()).rejects.toThrow(/limit/);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.hostDecode).not.toHaveBeenCalled();
  });
  it("uses separate staging for concurrent tenant work", async () => {
    const seen = new Set<string>();
    mocks.run.mockImplementation(async (plan) => {
      expect(seen.has(plan.args.filter((a: string) => !a.startsWith("--"))[1])).toBe(false);
      seen.add(plan.args.filter((a: string) => !a.startsWith("--"))[1]);
      const request = JSON.parse(await readFile(plan.args.filter((a: string) => !a.startsWith("--"))[1], "utf8"));
      await writeFile(plan.args.filter((a: string) => !a.startsWith("--"))[2], JSON.stringify({ $bytes: request.input.$bytes }));
    });
    const [a, b] = await Promise.all([image(Buffer.from("tenant A")).toBuffer(), image(Buffer.from("tenant B")).toBuffer()]);
    expect(a.toString()).toBe("tenant A"); expect(b.toString()).toBe("tenant B");
    expect(seen.size).toBe(2);
  });
});
