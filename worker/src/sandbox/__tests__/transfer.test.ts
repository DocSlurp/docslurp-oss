import { describe, expect, it } from "vitest";
import { boundedVmStream } from "../providers/modal/transfer.js";
describe("hostile VM transfers", () => {
  it("cancels an oversized stream before retaining the oversized chunk", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } });
    await expect(boundedVmStream(stream, 4)).rejects.toThrow(/byte limit/);
    expect(cancelled).toBe(true);
  });
  it("collects bounded text and binary chunks", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue("a"); c.enqueue(Buffer.from("b")); c.close(); } });
    expect((await boundedVmStream(stream, 2)).toString()).toBe("ab");
  });
});
