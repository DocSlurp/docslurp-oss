import { afterEach, expect, it, vi } from "vitest";
import { reconcileVisionReceiptMetadata } from "./vision-receipt-reconciliation.js";
afterEach(() => vi.unstubAllGlobals());
it("replaces aggregate estimates once after all attempt receipts arrive", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {
    total_cost: 0.002, is_byok: false,
  } }))));
  const metadata = { providerCostCents: 9, visionAttempts: [
    { generationId: "earlier", inputTokens: 10, outputTokens: 2 },
    { generationId: "later", inputTokens: 10, outputTokens: 2, costCents: 0.1 },
  ] };
  const first = await reconcileVisionReceiptMetadata(metadata, "m", "key");
  expect(first).toMatchObject({ originalProviderCostCents: 9, providerCostCents: expect.closeTo(0.3), accountingStatus: "reconciled" });
  expect(await reconcileVisionReceiptMetadata(first!, "m", "key")).toEqual(first);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("leaves uncertain costs untouched when an attempt lacks a generation ID", async () => {
  expect(await reconcileVisionReceiptMetadata({ visionAttempts: [{ inputTokens: 1, outputTokens: 2 }] }, "m", "key")).toBeNull();
});
