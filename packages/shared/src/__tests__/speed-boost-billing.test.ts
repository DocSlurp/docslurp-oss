import { describe, expect, it } from "vitest";
import { applySpeedBoostUnitCharge, speedBoostMultiplier, priceAiUsageEvent, unitChargeMetadata } from "../billing.js";

const unit = () => ({ provider: "docslurp", metric: "chat-answer", costCents: 2, metadata: unitChargeMetadata() });
describe("Speed boost credit policy", () => {
  it("is off on omission and applies exactly four times only on opt-in", () => {
    expect(speedBoostMultiplier()).toBe(1);
    expect(speedBoostMultiplier(false)).toBe(1);
    expect(speedBoostMultiplier(true)).toBe(4);
    expect(applySpeedBoostUnitCharge(unit()).costCents).toBe(2);
    expect(applySpeedBoostUnitCharge(unit(), true).costCents).toBe(8);
    for (const value of ["true", 4, 0, null, {}, []]) {
      expect(() => Reflect.apply(speedBoostMultiplier, undefined, [value])).toThrow("boolean");
    }
  });
  it("is idempotent at buffer and persistence seams and ignores arbitrary multipliers", () => {
    const once = applySpeedBoostUnitCharge(unit(), true);
    expect(applySpeedBoostUnitCharge(once, true)).toEqual(once);
    expect(applySpeedBoostUnitCharge(once, false).costCents).toBe(2);
    expect(applySpeedBoostUnitCharge({ ...unit(), metadata: unitChargeMetadata({ multiplier: 1000 }) }, true).costCents).toBe(8);
  });
  it("preserves provider dollars and never multiplies non-unit events", () => {
    const receipt = priceAiUsageEvent({ provider: "openrouter", metric: "chat", costCents: 0.73, metadata: {} as Record<string, unknown>, inputTokens: 12, outputTokens: 9 });
    expect(applySpeedBoostUnitCharge(receipt, true)).toEqual(receipt);
    expect(receipt.metadata).toMatchObject({ providerCostCents: 0.73, billable: false });
    expect(applySpeedBoostUnitCharge({ ...unit(), provider: "openrouter" }, true).costCents).toBe(2);
  });
});
