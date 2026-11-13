// Regression guards for two exactly-equivalent performance rewrites: the XML tokenizer's character classes (code-unit
// predicates instead of a RegExp per character) and svg-geometry's grid-pruned marker/vertex de-duplication. Each is
// compared with the code it replaced, so a later edit that drifts from the old behaviour fails here.
import { describe, expect, it } from "vitest";

import { CHART_EXTRACT_LIMITS, ExtractLimitError } from "../limits.js";
import { withoutVertexMarkers } from "../svg-geometry.js";
import type { LinePrim, PointPrim } from "../svg-scene.js";
import { isNameChar, isNameStart, isSpace } from "../xml.js";

describe("XML character classes", () => {
  it("match the regexes they replaced on every UTF-16 code unit, and past the end of input", () => {
    const nameStart = /[A-Za-z_:]/, nameChar = /[A-Za-z0-9_:.\-]/, space = /\s/;
    const diffs: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      if (isNameStart(c) !== nameStart.test(ch)) diffs.push(`nameStart ${c.toString(16)}`);
      if (isNameChar(c) !== nameChar.test(ch)) diffs.push(`nameChar ${c.toString(16)}`);
      if (isSpace(c) !== space.test(ch)) diffs.push(`space ${c.toString(16)}`);
    }
    expect(diffs).toEqual([]);
    // `charCodeAt` past the end is NaN; the old code tested `""`, which no class matches.
    const end = "".charCodeAt(0);
    expect([isNameStart(end), isNameChar(end), isSpace(end)]).toEqual([false, false, false]);
  });
});

const point = (x: number, y: number): PointPrim => ({ kind: "point", x, y, size: 2, fill: "#000", stroke: null } as PointPrim);
const line = (pts: Array<[number, number]>): LinePrim => ({ kind: "line", points: pts, stroke: "#000", fill: null } as unknown as LinePrim);
/** The filter before the grid index: every point against every vertex. */
const bruteForce = (points: PointPrim[], lines: LinePrim[]) =>
  points.filter((p) => !lines.some((l) => l.points.some(([x, y]) => Math.abs(x - p.x) < 1.5 && Math.abs(y - p.y) < 1.5)));

/** mulberry32: a small seeded generator, so a failure reproduces. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPECIAL = [NaN, Infinity, -Infinity, -0, 0, 1.5, -1.5, 3, -3, 4.5, -4.5, 2.9999999999999996, 3.0000000000000004, 1.4999999999999998,
  2 ** 53, 2 ** 53 + 2, -(2 ** 53), 3 * 2 ** 52, 3 * 2 ** 53, 1e308, -1e308, 5e-324, Number.MAX_VALUE];

describe("withoutVertexMarkers", () => {
  it("keeps exactly the points the brute-force filter keeps, in order (seeded property test)", () => {
    const random = rng(364);
    const coord = (scale: number) => {
      const r = random();
      if (r < 0.2) return SPECIAL[Math.floor(random() * SPECIAL.length)]!;
      // Near a special value, so pairs straddle cell borders and the 1.5 threshold.
      if (r < 0.35) return SPECIAL[Math.floor(random() * SPECIAL.length)]! + (random() - 0.5) * 4;
      return (random() - 0.5) * scale;
    };
    let compared = 0;
    for (let scene = 0; scene < 2000; scene++) {
      const scale = [10, 100, 1000, 1e6][scene % 4]!;
      const lines = Array.from({ length: 1 + Math.floor(random() * 4) }, () => line(Array.from({ length: 1 + Math.floor(random() * 30) }, () => [coord(scale), coord(scale)] as [number, number])));
      // Half the points sit near a random vertex, so both outcomes are common.
      const points = Array.from({ length: Math.floor(random() * 40) }, () => {
        if (random() < 0.5) {
          const l = lines[Math.floor(random() * lines.length)]!;
          const [vx, vy] = l.points[Math.floor(random() * l.points.length)]!;
          return point(vx + (random() - 0.5) * 3.2, vy + (random() - 0.5) * 3.2);
        }
        return point(coord(scale), coord(scale));
      });
      const got = withoutVertexMarkers(points, lines);
      const want = bruteForce(points, lines);
      expect(got.length).toBe(want.length);
      got.forEach((p, k) => expect(p).toBe(want[k]));
      compared += points.length;
    }
    expect(compared).toBeGreaterThan(30_000);
  });

  it("handles each special value against itself and its neighbours", () => {
    for (const a of SPECIAL) {
      for (const b of SPECIAL) {
        const points = [point(a, b), point(b, a), point(a + 1.49, b), point(a - 1.5, b)];
        const lines = [line([[a, b], [b, a]])];
        expect(withoutVertexMarkers(points, lines)).toEqual(bruteForce(points, lines));
      }
    }
  });
});

describe("withoutVertexMarkers work bound (hostile input; counted in pair tests, not wall time)", () => {
  const budget = CHART_EXTRACT_LIMITS.maxMarkerPairTests;

  it("caps the work far below the guest timeout", () => {
    // ~0.2 s of pair tests on an idle core; the guest's timeout is 60 s.
    expect(budget).toBeLessThanOrEqual(5e7);
  });

  it("refuses vertices packed into one cell against markers in the next cell, at the SVG size limits", () => {
    // The council's packed-cell scene: vertices clustered in [30, 32.9)², markers at 34.6 (the neighbouring cell, and
    // more than 1.5 from every vertex), so no marker short-circuits. Sized to the input limits: 20 polylines of
    // maxPathVertices (400k vertices, within a 5 MB SVG) and maxUseExpansions markers.
    const V = CHART_EXTRACT_LIMITS.maxPathVertices;
    const lines = Array.from({ length: 20 }, () => line(Array.from({ length: V }, (_, i) => [30 + (i % 290) / 100, 30 + (i % 97) / 34] as [number, number])));
    const points = Array.from({ length: CHART_EXTRACT_LIMITS.maxUseExpansions }, () => point(34.6, 34.6));
    // Unbounded, this is 20k × 400k = 8×10⁹ pair tests. Each marker alone scans all 400k packed vertices, so even the
    // first 125 markers exceed the production budget. The test injects a smaller cap to count it without running 5×10⁷
    // tests; the counting is the same code path.
    expect(points.length * lines.length * CHART_EXTRACT_LIMITS.maxPathVertices).toBeGreaterThan(100 * budget);
    const cap = 1_000_000;
    const work = { pairTests: 0 };
    let error: unknown;
    try { withoutVertexMarkers(points, lines, work, cap); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ExtractLimitError);
    expect((error as ExtractLimitError).reason).toBe("svg-marker-limit");
    expect(work.pairTests).toBe(cap + 1);
  });

  it("finishes markers over long dense polylines (markers-vs-lines) far below the budget, with the brute-force result", () => {
    // 12 sine polylines of maxPathVertices vertices at 0.2-unit spacing, and 20k markers spread over the plot:
    // 4.8×10⁹ pair tests for the old filter.
    const lines = Array.from({ length: 12 }, (_, k) => line(Array.from({ length: CHART_EXTRACT_LIMITS.maxPathVertices }, (_, i) => [Number((i * 0.2).toFixed(1)), Number((500 + 400 * Math.sin(i / (40 + k))).toFixed(1))] as [number, number])));
    const points = Array.from({ length: 20_000 }, (_, i) => point(Number(((i * 0.2) % 4000).toFixed(1)), (i * 37) % 1000));
    const work = { pairTests: 0 };
    const kept = withoutVertexMarkers(points, lines, work);
    expect(work.pairTests).toBeLessThan(budget / 10);
    // Spot-check equivalence on a slice (the full brute force is the 4.8×10⁹-test cost this guards against).
    const slice = points.slice(0, 20);
    expect(withoutVertexMarkers(slice, lines)).toEqual(bruteForce(slice, lines));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(points.length);
  });

  it("does no pair tests for non-finite points or vertices", () => {
    const lines = [line(Array.from({ length: 10_000 }, () => [NaN, Infinity] as [number, number]))];
    const points = Array.from({ length: 10_000 }, () => point(Infinity, NaN));
    const work = { pairTests: 0 };
    expect(withoutVertexMarkers(points, lines, work)).toHaveLength(points.length);
    expect(work.pairTests).toBe(0);
  });
});
