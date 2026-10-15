import { describe, expect, it } from "vitest";
import { runPageBundle } from "../temporal/page-bundle.js";
import type { VisionPageTask } from "../temporal/shared.js";
const pages = (n: number) => Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1 }) as VisionPageTask);

describe("page bundle execution", () => {
  it.each([2, 5, 8])("keeps two calls in flight across a %i-page bundle", async (size) => {
    let active = 0, peak = 0;
    const completed: number[] = [];
    const usage = await runPageBundle(pages(size), async task => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--; completed.push(task.pageNumber);
      return { inputTokens: 10, outputTokens: 2, costCents: 0.125 };
    });
    expect(peak).toBe(2);
    expect(completed).toHaveLength(size);
    expect(usage).toEqual({ inputTokens: size * 10, outputTokens: size * 2, costCents: size * 0.125 });
  });
  it("drains in-flight work and retries without repeating checkpointed page charges", async () => {
    const completed = new Map<number, number>();
    let fail = true, active = 0, calls = 0;
    const run = async (task: VisionPageTask) => {
      if (!completed.has(task.pageNumber)) {
        active++;
        await new Promise(resolve => setTimeout(resolve, task.pageNumber === 1 ? 1 : 10));
        active--;
        if (task.pageNumber === 1 && fail) throw new Error("provider unavailable");
        completed.set(task.pageNumber, ++calls);
      }
      return { inputTokens: 10, outputTokens: 2, costCents: 0.125 };
    };
    await expect(runPageBundle(pages(5), run)).rejects.toThrow("provider unavailable");
    expect(active).toBe(0);
    expect(completed.size).toBe(1);
    fail = false;
    expect((await runPageBundle(pages(5), run)).costCents).toBe(0.625);
    expect(calls).toBe(5);
  });
});
