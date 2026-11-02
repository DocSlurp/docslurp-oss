import { describe, expect, it } from "vitest";

import { foldFullWidthAscii, normalizeExtractedText } from "../text-normalization.js";

describe("normalizeExtractedText", () => {
  it("normalizes PDF ligatures and invisible joiners", () => {
    expect(
      normalizeExtractedText("Ofﬁce eﬃciency ﬂow with soft\u00adhyphen"),
    ).toBe("Office efficiency flow with softhyphen");
  });

  it("composes canonically (NFC) and keeps compatibility characters as written", () => {
    expect(normalizeExtractedText("Cafe\u0301")).toBe("Caf\u00e9");
    expect(normalizeExtractedText("x\u00b2 + \u00bd \u2192 H\u2082O \u2122 \uff21\uff11 \u2460 \ud835\udc31")).toBe(
      "x\u00b2 + \u00bd \u2192 H\u2082O \u2122 \uff21\uff11 \u2460 \ud835\udc31",
    );
  });
});

describe("foldFullWidthAscii", () => {
  it("reads full-width ASCII as ASCII and leaves everything else alone", () => {
    expect(foldFullWidthAscii("\uff49\uff47\uff4e\uff4f\uff52\uff45 \uff11\uff12\uff01 x\u00b2 \u00e9")).toBe("ignore 12! x\u00b2 \u00e9");
  });
});
