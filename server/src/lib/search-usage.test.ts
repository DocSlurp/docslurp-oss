import { describe, expect, it } from 'vitest';
import { publicSearchResponse } from './search-usage';
import type { SearchResponse } from '../services/search';

const response = (usageEvents: SearchResponse['usageEvents']): SearchResponse => ({ results: [], sessionId: 's', availability: {} as SearchResponse['availability'], usageEvents });
describe('public search usage', () => {
  it('totals tokens and fractional cents without leaking private ledger metadata', () => {
    const event = { provider: 'provider', model: 'model', metric: 'tokens', amount: 3, unit: 'token', inputTokens: 2, outputTokens: 1, costCents: 0.003, metadata: { costSource: 'provider', prompt: 'private' } };
    const result = publicSearchResponse(response([event, { ...event, costCents: 0.004, metadata: { costSource: 'estimate' } }]));
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6, costCents: 0.007, currency: 'USD', costSource: 'mixed', scope: 'retrieval' });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result).not.toHaveProperty('usageEvents');
  });
  it('reports an explicit no-AI-usage result', () => {
    expect(publicSearchResponse(response([])).usage).toMatchObject({ totalTokens: 0, costCents: 0, costSource: 'none' });
  });
  it('does not call unclassified costs provider-reported', () => {
    const event = { provider: 'p', model: 'm', metric: 'tokens', amount: 2, unit: 'token', inputTokens: 2, outputTokens: 0, costCents: 0, metadata: {} };
    expect(publicSearchResponse(response([event])).usage.costSource).toBe('unknown');
  });
});
