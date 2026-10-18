import { describe, expect, it } from "vitest";

import { InvalidRetrievalQueryError, parseRetrievalQueryFlags } from "../lib/retrieval-query-flags.js";

const parse = (query: string) => {
  const params = new URLSearchParams(query);
  return parseRetrievalQueryFlags((name) => params.get(name) ?? undefined);
};

describe("parseRetrievalQueryFlags", () => {
  it("keeps omitted and unrecognised flags undefined", () => {
    const flags = parse("hyde=maybe");
    expect(Object.values(flags).every((value) => value === undefined)).toBe(true);
  });

  it("reads explicit true and false values", () => {
    expect(parse("rerank=false&mmr=1&compression=0&communityExpansion=true")).toMatchObject({
      useRerank: false,
      useMmr: true,
      useContextualCompression: false,
      enableCommunityExpansion: true,
    });
  });

  it("clamps graph hops and MMR lambda", () => {
    expect(parse("graphHops=9&mmrLambda=-1")).toMatchObject({ graphHops: 3, mmrLambda: 0 });
    expect(parse("graphHops=abc").graphHops).toBeUndefined();
  });

  it("accepts minScore from 0 to 1 and rejects anything else like POST does", () => {
    expect(parse("minScore=0")).toMatchObject({ minScore: 0 });
    expect(parse("minScore=0.35")).toMatchObject({ minScore: 0.35 });
    expect(parse("minScore=1")).toMatchObject({ minScore: 1 });
    expect(parse("minScore").minScore).toBeUndefined();
    for (const bad of ["minScore=7", "minScore=-0.1", "minScore=abc", "minScore=NaN", "minScore=Infinity"]) {
      expect(() => parse(bad), bad).toThrow(InvalidRetrievalQueryError);
    }
  });
});


it("parses bounded candidate depth and explicit result ordering", () => {
  const parse = (values: Record<string, string>) => parseRetrievalQueryFlags(name => values[name]);
  expect(parse({ candidateDepth: "50", resultOrder: "relevance", rerank: "false" })).toMatchObject({ candidateDepth: 50, resultOrder: "relevance", useRerank: false });
  expect(parse({})).toMatchObject({ candidateDepth: undefined, resultOrder: undefined });
  for (const candidateDepth of ["0", "201", "50.5", "oops"]) expect(() => parse({ candidateDepth })).toThrow();
  expect(() => parse({ resultOrder: "unknown" })).toThrow();
});
