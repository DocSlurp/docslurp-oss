import { describe, expect, it } from "vitest";

import { validateRasterTextRegions } from "./raster-text-regions.js";

const rectangle = [0.1, 0.2, 0.4, 0.5];

describe("advisory raster text evidence", () => {
  it("allows bounded independent rectangles and keeps a known empty list", () => {
    expect(validateRasterTextRegions([rectangle, [0.4, 0.2, 0.8, 0.5]])).toEqual([rectangle, [0.4, 0.2, 0.8, 0.5]]);
    expect(validateRasterTextRegions([])).toEqual([]);
  });

  it("keeps malformed, missing, or oversized lists unknown", () => {
    for (const regions of [undefined, [rectangle, rectangle], [[-1, 0, 0.4, 0.5]], [[0, 0, Infinity, 0.5]],
      [[0.1, 0.1, 0.1, 0.5]], Array.from({ length: 9 }, () => rectangle)]) {
      expect(validateRasterTextRegions(regions)).toBeUndefined();
    }
  });
});
