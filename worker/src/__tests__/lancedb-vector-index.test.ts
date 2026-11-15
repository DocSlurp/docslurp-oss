import { expect, it } from "vitest";
import { vectorIndexPartitions } from "../stages/lancedb-vector-index.js";
it("bounds training size while partitioning large graphs", () => {
  expect(vectorIndexPartitions(10)).toBe(1);
  expect(vectorIndexPartitions(100_000)).toBe(128);
  expect(vectorIndexPartitions(37_245)).toBe(64);
  expect(vectorIndexPartitions(20_000_000)).toBe(4096);
  expect(vectorIndexPartitions(100_000, { LANCEDB_VECTOR_PARTITION_ROWS: "0" })).toBe(1);
  for (const rows of [NaN, Infinity, -1, 0, 1.5]) expect(() => vectorIndexPartitions(rows)).toThrow();
  for (const raw of ["many", "-1", "1.5"]) expect(() => vectorIndexPartitions(1000, { LANCEDB_VECTOR_PARTITION_ROWS: raw })).toThrow();
});
