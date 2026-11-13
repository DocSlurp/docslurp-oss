// Regression guards for two exactly-equivalent performance rewrites: the XML tokenizer's character classes (code-unit
// predicates instead of a RegExp per character) and svg-geometry's grid-pruned marker/vertex de-duplication. Each is
// compared with the code it replaced, so a later edit that drifts from the old behaviour fails here.
import { describe, expect, it } from "vitest";

import { extractDeterministicVisuals } from "../index.js";
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
    const mismatches: number[] = [];
    for (let scene = 0; scene < 1000; scene++) {
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
      // Same points, same order (compared by identity, one assertion per run to keep the loop cheap).
      const got = withoutVertexMarkers(points, lines);
      const want = bruteForce(points, lines);
      if (got.length !== want.length || got.some((p, k) => p !== want[k])) mismatches.push(scene);
      compared += points.length;
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(15_000);
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
    // Under the density gate one SVG has at most maxSvgPrimitives markers and maxSvgPathSegments vertices (2×10⁸ pair
    // tests unbounded). The per-SVG cap stops a packed one at 10⁵ (~0.3 ms at the measured ~3 ns each).
    expect(budget).toBeLessThanOrEqual(1e5);
  });

  it("stops vertices packed into one cell against markers in the next cell at its budget, at the density-gate maxima", () => {
    // The council's packed-cell scene: vertices clustered in [30, 32.9)², markers at 34.6 (the neighbouring cell, and
    // more than 1.5 from every vertex), so no marker short-circuits. Sized to the most one SVG may hold under the gate.
    const lines = [line(Array.from({ length: CHART_EXTRACT_LIMITS.maxSvgPathSegments }, (_, i) => [30 + (i % 290) / 100, 30 + (i % 97) / 34] as [number, number]))];
    const points = Array.from({ length: CHART_EXTRACT_LIMITS.maxSvgPrimitives }, () => point(34.6, 34.6));
    // Unbounded, this is 4,000 × 50,000 = 2×10⁸ pair tests; the cap stops it at 10⁵.
    expect(points.length * CHART_EXTRACT_LIMITS.maxSvgPathSegments).toBeGreaterThan(400 * budget);
    const work = { pairTests: 0 };
    let error: unknown;
    try { withoutVertexMarkers(points, lines, work); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ExtractLimitError);
    expect((error as ExtractLimitError).reason).toBe("svg-marker-limit");
    expect(work.pairTests).toBe(budget + 1);
  });

  it("finishes markers over long dense polylines (markers-vs-lines) with the brute-force result", () => {
    // Sine polylines at 0.2-unit spacing and markers spread over the plot (the shape of the perf report's
    // markers-vs-lines.svg, scaled to 3 polylines and 5,000 markers): 3×10⁸ pair tests for the pairwise filter.
    const lines = Array.from({ length: 3 }, (_, k) => line(Array.from({ length: CHART_EXTRACT_LIMITS.maxPathVertices }, (_, i) => [Number((i * 0.2).toFixed(1)), Number((500 + 400 * Math.sin(i / (40 + k))).toFixed(1))] as [number, number])));
    const points = Array.from({ length: 5_000 }, (_, i) => point(Number(((i * 0.8) % 4000).toFixed(1)), (i * 37) % 1000));
    const work = { pairTests: 0 };
    const kept = withoutVertexMarkers(points, lines, work, Infinity);
    // A few hundred pair tests per marker at most, against 60k vertices each for the pairwise filter.
    expect(work.pairTests).toBeLessThan(points.length * 500);
    // Spot-check equivalence on a slice (the full brute force is the cost this guards against).
    const slice = points.slice(0, 20);
    expect(withoutVertexMarkers(slice, lines, { pairTests: 0 }, Infinity)).toEqual(bruteForce(slice, lines));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(points.length);
  });

  /** V polyline vertices (the two ends far apart, the rest packed into one 3-unit cell) and P markers in the next cell: (V − 2) × P pair tests. */
  function packedSvg(vertices: number, markers: number): string {
    const pts = ["10,90", ...Array.from({ length: vertices - 2 }, (_, i) => `${(30 + (i % 290) / 100).toFixed(2)},${(30 + (i % 97) / 34).toFixed(2)}`), "90,10"];
    const ticks = [[0, 90], [10, 50], [20, 10]].map(([v, y]) => `<text x="2" y="${y}">${v}</text>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><polyline points="${pts.join(" ")}" stroke="#f00" fill="none"/>`
      + `${'<circle cx="34.6" cy="34.6" r="1" fill="#00f"/>'.repeat(markers)}${ticks}<text x="10" y="98">A</text><text x="50" y="98">B</text><text x="90" y="98">C</text></svg>`;
  }

  it("approximates an SVG over the per-SVG pair cap instead of refusing it; the next SVG stays exact", () => {
    // 1,000 packed vertices × 1,000 markers: 10⁶ pair tests, over the 10⁵ cap but under every density gate.
    const hostile = packedSvg(1000, 1000);
    const ok = packedSvg(100, 100); // 98 × 100 = 9,800 pair tests
    const r = extractDeterministicVisuals({ kind: "html", text: `<html><body>${hostile}${ok}</body></html>` });
    expect(r.refusals).toEqual([]);
    expect(r.visuals.map((v) => v.locator)).toEqual(["svg[0]", "svg[1]"]);
    expect(r.visuals[0]!.reason).toBe("approximate-marker-dedup");
    expect(r.visuals[0]!.confidence).toBeLessThanOrEqual(CHART_EXTRACT_LIMITS.approximateMaxConfidence);
    expect(r.visuals[1]!.reason).not.toBe("approximate-marker-dedup");
    // Alone, the ordinary one is byte-identical to its result next to the hostile one.
    expect(JSON.stringify(extractDeterministicVisuals({ kind: "svg", text: ok }).visuals[0]!.spec)).toBe(JSON.stringify(r.visuals[1]!.spec));
  });

  it("does no pair tests for non-finite points or vertices", () => {
    const lines = [line(Array.from({ length: 10_000 }, () => [NaN, Infinity] as [number, number]))];
    const points = Array.from({ length: 10_000 }, () => point(Infinity, NaN));
    const work = { pairTests: 0 };
    expect(withoutVertexMarkers(points, lines, work)).toHaveLength(points.length);
    expect(work.pairTests).toBe(0);
  });
});
