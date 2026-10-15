import { describe, expect, it } from "vitest";

import { parseRetrievalQueryFlags } from "../lib/retrieval-query-flags.js";

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
});
