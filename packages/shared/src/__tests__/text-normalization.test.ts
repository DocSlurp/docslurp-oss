import { describe, expect, it } from "vitest";

import { normalizeExtractedText } from "../text-normalization.js";

describe("normalizeExtractedText", () => {
  it("normalizes PDF ligatures and invisible joiners", () => {
    expect(
      normalizeExtractedText("Ofﬁce eﬃciency ﬂow with soft\u00adhyphen"),
    ).toBe("Office efficiency flow with softhyphen");
  });
});
