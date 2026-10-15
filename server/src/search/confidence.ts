import type { SearchResult } from "@docslurp/shared";

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function calibrateSearchConfidence(results: SearchResult[]): SearchResult[] {
  if (results.length === 0) {
    return results;
  }

  const topScore = Math.max(...results.map((result) => result.score || 0), 0.0001);

  return results.map((result, index) => {
    const normalizedRank = 1 - index / Math.max(1, results.length - 1 || 1);
    const normalizedScore = clamp((result.score || 0) / topScore);
    const citationDensity = result.citation.pageNumbers.length > 0 || result.citation.pageNumber != null ? 1 : 0.6;
    const excerptCompleteness = result.parentText && result.parentText.length > result.text.length ? 1 : 0.8;
    const score = clamp(
      normalizedScore * 0.5 +
      normalizedRank * 0.25 +
      citationDensity * 0.15 +
      excerptCompleteness * 0.1
    );

    const reasons: string[] = [];
    if (normalizedRank > 0.75) {
      reasons.push("Top-ranked retrieval match.");
    }
    if (normalizedScore > 0.8) {
      reasons.push("Similarity score remained close to the top hit.");
    }
    if (citationDensity >= 1) {
      reasons.push("Citation includes page anchors.");
    }

    const band = score >= 0.72 ? "high" : score >= 0.45 ? "medium" : "low";

    return {
      ...result,
      confidence: {
        band,
        score,
        reasons
      }
    };
  });
}
