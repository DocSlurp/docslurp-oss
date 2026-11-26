export type RasterTextRegion = [left: number, top: number, right: number, bottom: number];

const MAX_REGIONS = 8;

function isRectangle(value: unknown): value is RasterTextRegion {
  return Array.isArray(value) && value.length === 4 &&
    value.every((coordinate) => typeof coordinate === "number" && coordinate >= 0 && coordinate <= 1) &&
    value[0] < value[2] && value[1] < value[3];
}

/** Validate an advisory list of disjoint rectangles in normalized displayed-page coordinates. */
export function validateRasterTextRegions(value: unknown): RasterTextRegion[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REGIONS) return undefined;
  const regions: RasterTextRegion[] = [];
  for (const rectangle of value) {
    if (!isRectangle(rectangle)) return undefined;
    const [left, top, right, bottom] = rectangle;
    if (regions.some(([otherLeft, otherTop, otherRight, otherBottom]) =>
      left < otherRight && right > otherLeft && top < otherBottom && bottom > otherTop,
    )) return undefined;
    regions.push([left, top, right, bottom]);
  }
  return regions;
}
