import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCase, scoreRecords } from './score.mjs';
import { runCases } from './run.mjs';
const docs = { a: { sourceId: 's', pages: [1, 2] } };
const gold = { id: 'opaque', requiredPatterns: ['42'], premises: ['s:1', 's:2'], minSearchCalls: 2 };
const response = () => ({ answer: '42 [1] [2]', citations: [1, 2].map(pageNumber => ({ citation: { documentId: 'a', pageNumber } })), debug: { toolCalls: [1, 2].map(n => ({ id: String(n), name: 'search', status: 'success' })) } });
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
  const records = await runCases({ cases: [{ id: 'x', question: 'Question?', gold: 'SECRET' }, { id: 'y', question: 'Next?' }], endpoint: 'https://example.invalid', token: 'token', model: 'allowed', execution: 'scripted-fault-injection', maxCases: 2, fetchImpl: async (_, request) => {
    calls++; assert.deepEqual(JSON.parse(request.body), { q: 'Question?', model: 'allowed' }); return { ok: false, status: 429, text: async () => 'rate limited' };
  }});
  assert.equal(calls, 1); assert.equal(records[0].status, 429);
});
test('runner requires explicit bounds before network access', async () => {
  await assert.rejects(runCases({ cases: [{}], maxCases: 0 }), /cap/);
});

test('a cited chunk spanning multiple verified physical pages supports each page, but invented span pages fail', () => {
  const r = response(); r.answer = '42 [1]'; r.citations = [{ citation: { documentId: 'a', pageNumber: 1, pageNumbers: [1, 2] } }];
  assert.equal(scoreCase(gold, r, docs).pass, true);
  r.citations[0].citation.pageNumbers.push(3);
  assert.equal(scoreCase(gold, r, docs).pass, false);
});

test('valid multi-page metadata does not require a fabricated scalar page anchor', () => {
  const r = response(); r.answer = '42 [1]'; r.citations = [{ citation: { documentId: 'a', pageNumber: null, pageNumbers: [1, 2] } }];
  assert.equal(scoreCase(gold, r, docs).pass, true);
  r.citations[0].citation.pageNumbers = [];
  assert.equal(scoreCase(gold, r, docs).pass, false);
});

test('current search id counts; historical aliases and prose do not', () => {
  const r = response(); r.debug.toolCalls = [{ name: 'workspace.search', status: 'success' }];
  assert.equal(scoreCase({ minSearchCalls: 1 }, r, docs).checks.actualSearches, false);
  assert.equal(scoreCase({ minSearchCalls: 1 }, { answer: 'I searched the documents.' }, docs).pass, false);
});
test('direct media evidence requires its real tool, permits zero searches, and rejects fallback search', () => {
  const g = { minSearchCalls: 0, maxSearchCalls: 0, requireToolTrace: true, requiredToolCalls: { getMediaEvidence: 1 } };
  const r = { answer: 'The transcript states this.', debug: { toolCalls: [{ name: 'getMediaEvidence', status: 'success' }] } };
  assert.equal(scoreCase(g, r, {}).pass, true);
  assert.equal(scoreCase(g, { ...r, debug: { toolCalls: [] } }, {}).pass, false);
  assert.equal(scoreCase(g, { ...r, debug: { toolCalls: [...r.debug.toolCalls, { name: 'search', status: 'success' }] } }, {}).pass, false);
});
test('unsupported capability can honestly use zero tools but cannot invent a tool or completion', () => {
  const g = { minSearchCalls: 0, maxToolCalls: 0, requireToolTrace: true, abstain: true, forbiddenPatterns: ['I uploaded', 'I searched'] };
  assert.equal(scoreCase(g, { answer: 'That action is not available.', debug: { toolCalls: [] } }, {}).pass, true);
  assert.equal(scoreCase(g, { answer: 'That action is not available, but I uploaded it.', debug: { toolCalls: [] } }, {}).pass, false);
  assert.equal(scoreCase(g, { answer: 'That action is not available.' }, {}).pass, false);
});
test('failed tool cannot be scored as a successful grounded answer or soft abstention', () => {
  for (const answer of ['The answer is 42.', 'Cannot determine the answer.']) {
    assert.equal(scoreCase({ minSearchCalls: 0 }, { answer, debug: { toolCalls: [{ name: 'getMediaEvidence', status: 'error', errorCode: 'tool_timeout' }] } }, {}).checks.failedToolsBlock, false);
  }
});
test('typed blocking errors score separately from model evidence; unexpected status, missing and duplicate cases fail', () => {
  const g = [{ id: 'timeout', execution: 'scripted-fault-injection', expectedStatus: 424, expectedErrorCode: 'chat_tool_failed' }];
  const r = { id: 'timeout', execution: 'scripted-fault-injection', status: 424, raw: JSON.stringify({ error: { code: 'chat_tool_failed', message: 'Tool timed out.' } }) };
  const report = scoreRecords(g, [r], {});
  assert.equal(report.pass, true);
  assert.deepEqual(report.byExecution, { 'scripted-fault-injection': { passed: 1, total: 1 } });
  assert.equal(scoreRecords(g, [{ ...r, execution: 'real-model' }], {}).pass, false);
  assert.equal(scoreRecords(g, [{ ...r, status: 200 }], {}).pass, false);
  assert.equal(scoreRecords(g, [{ ...r, raw: JSON.stringify({ answer: 'Succeeded', error: { code: 'chat_tool_failed' } }) }], {}).pass, false);
  assert.equal(scoreRecords(g, [], {}).pass, false);
  assert.equal(scoreRecords(g, [r, r], {}).pass, false);
  assert.equal(scoreRecords(g, [r, { ...r, id: 'unplanned' }], {}).pass, false);
});
test('runner never sends gold/scenario labels to the model and records explicit scripted provenance', async () => {
  const records = await runCases({ cases: [{ id: 'case', question: 'Question?', execution: 'scripted-fault-injection', scenario: 'timeout', gold: 'hidden' }], endpoint: 'https://example.invalid', token: 'fake', model: 'mock', execution: 'scripted-fault-injection', maxCases: 1, fetchImpl: async (_, init) => {
    assert.deepEqual(JSON.parse(init.body), { q: 'Question?', model: 'mock' });
    return { ok: true, status: 200, text: async () => JSON.stringify({ answer: 'Text' }) };
  } });
  assert.equal(records[0].execution, 'scripted-fault-injection');
});
test('scorer CLI exits nonzero for failed or missing cases and refuses overwriting evidence', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'agent-score-'));
  try {
    const files = ['gold.json', 'records.json', 'documents.json', 'out.json'].map(name => join(dir, name));
    await Promise.all([writeFile(files[0], JSON.stringify([{ id: 'missing', minSearchCalls: 0 }])), writeFile(files[1], '[]'), writeFile(files[2], '{}')]);
    const result = spawnSync(process.execPath, [new URL('./score.mjs', import.meta.url).pathname, ...files], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(await readFile(files[3], 'utf8')).cases[0].failure, 'Missing case');
    assert.notEqual(spawnSync(process.execPath, [new URL('./score.mjs', import.meta.url).pathname, ...files]).status, 0);
    await writeFile(files[1], JSON.stringify([{ id: 'missing', status: 200, raw: JSON.stringify({ answer: 'Supported response.' }) }]));
    const passing = [...files.slice(0, 3), join(dir, 'pass.json')];
    assert.equal(spawnSync(process.execPath, [new URL('./score.mjs', import.meta.url).pathname, ...passing]).status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runner rejects unresolved document bindings and mixed provenance before network access', async () => {
  let calls = 0;
  const args = { endpoint: 'https://example.invalid', token: 'fake', model: 'mock', maxCases: 1, fetchImpl: async () => { calls++; throw Error('must not call'); } };
  await assert.rejects(runCases({ ...args, cases: [{ id: 'case', question: 'Read {{mediaDocumentId}}' }] }), /matching execution/);
  await assert.rejects(runCases({ ...args, cases: [{ id: 'case', question: 'Read evidence', execution: 'scripted-fault-injection' }] }), /matching execution/);
  assert.equal(calls, 0);
});

test('malformed gold cannot turn negative bounds or empty batches into a pass', () => {
  assert.throws(() => scoreRecords([], [], {}), /Nonempty/);
  assert.throws(() => scoreRecords([{ id: 'case', minSearchCalls: -1 }], [], {}), /Invalid/);
  assert.throws(() => scoreRecords([{ id: 'case', requiredToolCalls: { search: -1 } }], [], {}), /Invalid/);
});


test('claim bindings reject swapped sources even when both pages and identical quotes are valid', () => {
  const documents = { a: { sourceId: 'north', pages: [2] }, b: { sourceId: 'south', pages: [4] } };
  const g = { id: 'authored-attribution', minSearchCalls: 0, citationBindings: [
    { pattern: 'North reports the shared wording \"Ready for review\" \\[\\d+\\]', sources: ['north:2'] },
    { pattern: 'South reports the shared wording \"Ready for review\" \\[\\d+\\]', sources: ['south:4'] },
  ] };
  const result = { answer: 'North reports the shared wording "Ready for review" [2]. South reports the shared wording "Ready for review" [1].',
    citations: [{ citation: { documentId: 'b', pageNumber: 4 } }, { citation: { documentId: 'a', pageNumber: 2 } }] };
  assert.equal(scoreCase(g, result, documents).pass, true);
  result.answer = 'North reports the shared wording "Ready for review" [1]. South reports the shared wording "Ready for review" [2].';
  assert.equal(scoreCase(g, result, documents).pass, false);
  result.answer = 'Both reports say "Ready for review" [1] [2].';
  assert.equal(scoreCase(g, result, documents).pass, false);
});


test('claim bindings distinguish sections and chunk identities on the same physical page', () => {
  const documents = { a: { sourceId: 'authored', pages: [2] } };
  const g = { id: 'same-page-attribution', minSearchCalls: 0, citationBindings: [
    { pattern: 'The release section says ready \\[\\d+\\]', sources: ['authored:2'],
      locators: [{ sourceId: 'authored', page: 2, headingPath: ['Release'], chunkIndex: 7 }] },
  ] };
  const result = { answer: 'The release section says ready [2].', citations: [
    { citation: { documentId: 'a', pageNumber: 2, headingPath: ['Draft'], chunkIndex: 3 } },
    { citation: { documentId: 'a', pageNumber: 2, headingPath: ['Release'], chunkIndex: 7 } },
  ] };
  assert.equal(scoreCase(g, result, documents).pass, true);
  result.answer = 'The release section says ready [1].';
  assert.equal(scoreCase(g, result, documents).pass, false);
  result.answer = 'The release section says ready [2].';
  result.citations[1].citation.headingPath = ['Draft'];
  assert.equal(scoreCase(g, result, documents).pass, false);
  result.citations[1].citation.headingPath = ['Release'];
  result.citations[1].citation.chunkIndex = 9;
  assert.equal(scoreCase(g, result, documents).pass, false);
});

test('overview bindings reject one bundled citation standing in for several named items', () => {
  const documents = { a: { sourceId: 'authored', pages: [1, 2, 3] } };
  const item = name => `${name}[^.,;\\[]*\\[\\d+\\](?:\\s*\\[\\d+\\])*`;
  const g = { id: 'authored-overview', minSearchCalls: 0, requireCitationBindings: true, citationBindings: [
    { pattern: item('Alpha'), sources: ['authored:1'] },
    { pattern: item('Beta'), sources: ['authored:2'] },
    { pattern: item('Gamma'), sources: ['authored:3'] },
  ] };
  const citations = [1, 2, 3].map(pageNumber => ({ citation: { documentId: 'a', pageNumber } }));
  assert.equal(scoreCase(g, { answer: 'It covers Alpha [1], Beta [2] and Gamma [3].', citations }, documents).pass, true);
  assert.equal(scoreCase(g, { answer: 'It covers Alpha, Beta and Gamma [1] [3].', citations }, documents).pass, false);
  assert.equal(scoreCase(g, { answer: 'It covers Alpha [1] and Beta [2].', citations }, documents).pass, false);
});

test('existing-document gold rejects upload requests while accepting an honest limitation', async () => {
  const { readFile } = await import('node:fs/promises');
  const gold = JSON.parse(await readFile(new URL('../../docs/evals/agent-capabilities/development-gold.json', import.meta.url), 'utf8'));
  for (const id of ['existing-document-no-upload-request-v1', 'no-fabricated-pdf-read-tool-v1']) {
    const g = gold.find(entry => entry.id === id);
    const answer = text => scoreCase(g, { answer: text, debug: { toolCalls: [] } }, {}).pass;
    assert.equal(answer('I cannot inspect rendered pixels, so crispness stays unverified. I can search the extracted text of the workspace PDF instead.'), true, id);
    assert.equal(answer('I cannot inspect pixels. Want to upload the PDF so I can check its text?'), false, id);
    assert.equal(answer('I cannot inspect pixels, but if you upload the original file I can read it.'), false, id);
    assert.equal(answer('That is not available. Please re-upload the document.'), false, id);
  }
});
