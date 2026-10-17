import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCase } from './score.mjs';
import { runCases } from './run.mjs';
const docs = { a: { sourceId: 's', pages: [1, 2] } };
const gold = { id: 'opaque', requiredPatterns: ['42'], premises: ['s:1', 's:2'], minSearchCalls: 2 };
const response = () => ({ answer: '42 [1] [2]', citations: [1, 2].map(pageNumber => ({ citation: { documentId: 'a', pageNumber } })), debug: { toolCalls: [1, 2].map(n => ({ id: String(n), name: 'workspace.search', status: 'success' })) } });
test('multi-premise answer requires cited pages and actual successful searches', () => {
  assert.equal(scoreCase(gold, response(), docs).pass, true);
  for (const mutate of [r => r.answer = '42 [1]', r => r.debug.toolCalls.pop(), r => r.debug.toolCalls[1].status = 'error', r => r.citations[1].citation.pageNumber = 9, r => r.answer = '41 [1] [2]']) {
    const r = response(); mutate(r); assert.equal(scoreCase(gold, r, docs).pass, false);
  }
});
test('search-many, nested chat, and claimed search prose do not count as actual search calls', () => {
  const r = response(); r.debug.toolCalls = [{ name: 'workspace.search-many', status: 'success' }];
  assert.equal(scoreCase(gold, r, docs).checks.actualSearches, false);
});
test('negative control rejects unsupported affirmative answer', () => {
  const g = { id: 'negative', abstain: true, minSearchCalls: 0 };
  assert.equal(scoreCase(g, { answer: 'The policy number is 123.' }, docs).pass, false);
  assert.equal(scoreCase(g, { answer: 'The policy number is not provided.' }, docs).pass, true);
});
test('runner sends question only, records failures, and never retries', async () => {
  let calls = 0;
  const records = await runCases({ cases: [{ id: 'x', question: 'Question?', gold: 'SECRET' }, { id: 'y', question: 'Next?' }], endpoint: 'https://example.invalid', token: 'token', model: 'allowed', maxCases: 2, fetchImpl: async (_, request) => {
    calls++; assert.deepEqual(JSON.parse(request.body), { q: 'Question?', model: 'allowed' }); return { ok: false, status: 429, text: async () => 'rate limited' };
  }});
  assert.equal(calls, 1); assert.equal(records[0].status, 429);
});
test('runner requires explicit bounds before network access', async () => {
  await assert.rejects(runCases({ cases: [{}], maxCases: 0 }), /cap/);
});
