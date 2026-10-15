import { generateOpenRouterText, SEARCH_OPENROUTER_MODEL } from "../lib/ai.js";
import type { UsageRecorder } from "../lib/ai-usage.js";
import type { PrivacyMode } from "@docslurp/shared";

/**
 * Query rewriting and decomposition utilities.
 */

const SPLIT_PATTERNS = [
  /\band\b/i,
  /\bvs\.?\b/i,
  /\bcompare\b/i,
  /\bdifference between\b/i,
  /\balso\b/i,
];

const MIN_WORDS = 3;

/**
 * Detect compound queries and split into sub-queries.
 * Returns original query if no decomposition is needed.
 */
export function decomposeQuery(query: string): string[] {
  for (const pattern of SPLIT_PATTERNS) {
    if (pattern.test(query)) {
      const parts = query
        .split(pattern)
        .map((p) => p.trim())
        .filter((p) => p.split(/\s+/).length >= MIN_WORDS);

      if (parts.length > 1) {
        return parts;
      }
    }
  }

  return [query];
}

/**
 * Uses LLM to rewrite ambiguous queries into clearer form.
 * Falls back to original if apiKey is empty.
 */
export async function rewriteQuery(
  query: string,
  apiKey: string,
  usage: UsageRecorder,
  privacyMode: PrivacyMode,
): Promise<{ query: string }> {
  if (!apiKey) {
    return { query };
  }

  try {
    const result = await generateOpenRouterText({
      operation: "api.search.rewrite",
      apiKey,
      privacyMode,
      model: SEARCH_OPENROUTER_MODEL,
      maxOutputTokens: 100,
      prompt: `Rewrite this search query to be clearer and more specific for document retrieval. Return only the rewritten query, nothing else.\n\nQuery: ${query}`,
    });

    usage.record({
      provider: "openrouter",
      model: SEARCH_OPENROUTER_MODEL,
      metric: "query-rewrite",
      ...result.usage,
    });

    return { query: result.text.trim() || query };
  } catch {
    return { query };
  }
}
