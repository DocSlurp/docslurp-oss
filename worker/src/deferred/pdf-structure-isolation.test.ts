import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPdfStructure } from "./pdf-structure.js";
import { GUEST_NODE_FLAGS } from "../sandbox/guest-node-flags.js";
const mocks = vi.hoisted(() => ({ run: vi.fn(), hostPdf: vi.fn(() => { throw new Error("host PDF parser invoked"); }) }));
vi.mock("../tools/runner.js", () => ({ CommandRunner: class { run = mocks.run; } }));
vi.mock("./pdf-structure-guest.js", () => ({ readPdfStructure: mocks.hostPdf }));
beforeEach(() => { vi.stubEnv("NODE_ENV", "production"); mocks.run.mockReset(); mocks.hostPdf.mockClear(); });
afterEach(() => vi.unstubAllEnvs());
describe("PDF structure production boundary", () => {
  it("accepts bounded structure from the guest without loading the host parser", async () => {
    mocks.run.mockImplementation(async (plan) => writeFile(plan.args[GUEST_NODE_FLAGS.length + 2], JSON.stringify({ pageCount: 1, outline: [], pageLabels: null })));
    expect(await readPdfStructure(Buffer.from("untrusted PDF"))).toEqual({ pageCount: 1, outline: [], pageLabels: null });
    expect(mocks.hostPdf).not.toHaveBeenCalled();
  });
  it("rejects unavailable VM credentials with no host fallback", async () => {
    mocks.run.mockRejectedValue(new Error("revoked credentials"));
    await expect(readPdfStructure(Buffer.from("PDF"))).rejects.toThrow(/revoked/);
    expect(mocks.hostPdf).not.toHaveBeenCalled();
  });
  it.each([
    { pageCount: 1, outline: [{ title: "x", level: 1, physicalPage: 2, children: [] }], pageLabels: null },
    { pageCount: 1, outline: [{ title: "x", level: 1, physicalPage: 1, children: "hostile" }], pageLabels: null },
    { pageCount: 1, outline: [], pageLabels: [false] },
  ])("rejects invalid guest result %o", async (result) => {
    mocks.run.mockImplementation(async (plan) => writeFile(plan.args[GUEST_NODE_FLAGS.length + 2], JSON.stringify(result)));
    await expect(readPdfStructure(Buffer.from("PDF"))).rejects.toThrow(/invalid PDF/);
  });
  it("rejects deeply nested guest outlines before recursive host traversal", async () => {
    let node = { title: "x", level: 1, physicalPage: 1, children: [] as unknown[] };
    for (let i = 0; i < 16; i++) node = { ...node, children: [node] };
    mocks.run.mockImplementation(async (plan) => writeFile(plan.args[GUEST_NODE_FLAGS.length + 2], JSON.stringify({ pageCount: 1, outline: [node], pageLabels: null })));
    await expect(readPdfStructure(Buffer.from("PDF"))).rejects.toThrow(/invalid PDF outline/);
  });
});
