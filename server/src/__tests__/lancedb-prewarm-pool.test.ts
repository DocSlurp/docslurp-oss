import { expect, it } from "vitest";
import { withIndexWarmSlot } from "../search/lancedb-prewarm-pool.js";

it("keeps two native loads active, removes cancelled queue entries, and never starts them later", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let started = 0;
  const activeController = new AbortController();
  const active = [0, 1].map(() => withIndexWarmSlot(async () => { started++; await gate; }, activeController.signal));
  const controllers = Array.from({ length: 100 }, () => new AbortController());
  const queued = controllers.map((c) => withIndexWarmSlot(async () => { started++; }, c.signal).catch(() => "cancelled"));
  expect(started).toBe(2);
  activeController.abort(); // native work cannot be cancelled, so its slots remain occupied
  for (const c of controllers) c.abort();
  expect(await Promise.all(queued)).toEqual(Array(100).fill("cancelled"));
  let replacementStarted = false;
  const replacement = withIndexWarmSlot(async () => { replacementStarted = true; }, new AbortController().signal);
  expect(replacementStarted).toBe(false);
  release();
  await Promise.all([...active, replacement]);
  expect(started).toBe(2);
  expect(replacementStarted).toBe(true);
});
