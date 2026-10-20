import type { SearchResponse } from '../services/search.js';

/** Public totals only; ledger metadata can contain internal prompts and traces. */
export function publicSearchResponse(response: SearchResponse) {
  const events = response.usageEvents ?? [];
  const inputTokens = events.reduce((sum, event) => sum + event.inputTokens, 0);
  const outputTokens = events.reduce((sum, event) => sum + event.outputTokens, 0);
  const sources = new Set(events.map(event => event.metadata?.costSource ?? 'unknown'));
  const costSource: 'none' | 'mixed' | 'provider' | 'estimate' | 'unknown' = events.length === 0 ? 'none'
    : sources.size > 1 ? 'mixed' : sources.has('provider') ? 'provider'
    : sources.has('estimate') ? 'estimate' : 'unknown';
  return {
    results: response.results,
    sessionId: response.sessionId,
    availability: response.availability,
    noMatch: response.relevanceFloor?.noMatch ?? false,
    ...(response.relevanceFloor ? { relevanceFloor: { minScore: response.relevanceFloor.minScore, dropped: response.relevanceFloor.dropped } } : {}),
    ...(response.timings ? { timings: response.timings } : {}),
    ...(response.deferred ? { deferred: response.deferred } : {}),
    usage: {
      inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      costCents: events.reduce((sum, event) => sum + event.costCents, 0),
      currency: 'USD' as const, costSource,
      scope: 'retrieval' as const,
    },
  };
}
