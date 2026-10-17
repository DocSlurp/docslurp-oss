/** Mocked checks of the eval runner's instrumentation. No network, database or provider call is made. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  RunnerHalt, accountRequests, assertAllowedModel, assertProductionSeams, catalogPricing, createReceiptCapture, describeError, loadInputs,
  parseArgs, pointBatches, prepareText, readReceipt, reconcile, scorerOutputs, sourceIdentity, worstCaseLedgerCents,
  type Arm, type CapturedRequest,
} from './run.mts';

const base = ['--dataset', '/tmp/d', '--split', 'development', '--out', '/tmp/o', '--model', 'vendor/model-a', '--arm', 'baseline', '--org', 'o', '--workspace', 'w', '--user', 'u'];

const responsesBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 'gen-1', object: 'response', model: 'vendor/model-a', provider: 'Acme', status: 'completed', output: [],
  usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, cost: 0.001 }, ...overrides,
});
const chatBody = JSON.stringify({ id: 'gen-2', model: 'vendor/model-a', choices: [{ finish_reason: 'length' }], usage: { prompt_tokens: 7, completion_tokens: 9, cost: 0.002 } });

test('arguments are strict and model policy blocks Pro/Ultra spellings and private routes', () => {
  assert.equal(parseArgs(base).budgetCents, 986);
  assert.throws(() => parseArgs([...base, '--budget-cent', '5']), /Unknown argument/);
  assert.throws(() => parseArgs([...base, '--budget-cents', '987']), /budget-cents/);
  assert.throws(() => parseArgs([...base, '--repeat', '3']), /repeat/);
  assert.throws(() => parseArgs([...base, '--model', 'vendor/x']), /Duplicate/);
  assert.throws(() => parseArgs([...base, '--operations', 'graph,chat']), /Unknown operation/);
  assert.throws(() => parseArgs(base.map(a => (a === 'development' ? 'heldout' : a))), /--confirm/);
  assert.equal(parseArgs([...base.map(a => (a === 'development' ? 'heldout' : a)), '--confirm']).confirm, true);
  assert.throws(() => parseArgs([...base, '--confirm']), /held-out runs only/);
  for (const model of ['openai/gpt-9-pro', 'openai/gpt-9-pro:online', 'openai/o9_pro', 'vendor/model-ultra-2', 'llm://private/a/b', 'no-vendor']) assert.throws(() => assertAllowedModel(model), undefined, model);
  assertAllowedModel('deepseek/deepseek-v4.1-flash');
});

test('catalog pricing fails closed on sentinel, missing and expensive output prices', () => {
  const catalog = { data: [{ id: 'a/ok', pricing: { prompt: '0.000001', completion: '0.000002' } }, { id: 'a/router', pricing: { prompt: '-1', completion: '-1' } }, { id: 'a/dear', pricing: { prompt: '0.00001', completion: '0.00005' } }] };
  assert.deepEqual(catalogPricing(catalog, 'a/ok'), { inputPerToken: 0.000001, outputPerToken: 0.000002 });
  for (const id of ['a/router', 'a/dear', 'a/absent']) assert.throws(() => catalogPricing(catalog, id), /verified affordable/);
});

test('receipts are read in Responses and Chat Completions shapes; malformed bodies are classified', () => {
  const responses = readReceipt(responsesBody());
  assert.ok(responses.ok);
  assert.deepEqual([responses.shape, responses.inputTokens, responses.outputTokens, responses.reasoningTokens, responses.finishReason, responses.truncated], ['responses', 100, 20, 5, 'stop', false]);
  const incomplete = readReceipt(responsesBody({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
  assert.ok(incomplete.ok && incomplete.truncated && incomplete.finishReason === 'max_output_tokens');
  const chat = readReceipt(chatBody);
  assert.ok(chat.ok && chat.shape === 'chat' && chat.inputTokens === 7 && chat.truncated);
  assert.deepEqual(readReceipt('not json'), { ok: false, reason: 'unparseable-json' });
  assert.deepEqual(readReceipt(JSON.stringify({ error: { message: 'x' } })), { ok: false, reason: 'provider-error-body' });
  assert.deepEqual(readReceipt(JSON.stringify({ object: 'response', output: [] })), { ok: false, reason: 'missing-usage' });
  assert.deepEqual(readReceipt(JSON.stringify({ object: 'response', output: [], usage: { input_tokens: 'x' } })), { ok: false, reason: 'missing-token-counts' });
  assert.deepEqual(readReceipt(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } })), { ok: false, reason: 'unknown-shape' });
});

const arm = (overrides: Partial<Arm> = {}): Arm => ({ expectedModel: 'vendor/model-a', maxAttempts: 3, roomLedgerCents: 100, inputPerToken: 1e-6, outputPerToken: 2e-6, ledgerFactor: 1.1, ...overrides });
const paidInit = (body: Record<string, unknown> = {}) => ({ method: 'POST', headers: { authorization: 'Bearer secret' }, body: JSON.stringify({ model: 'vendor/model-a', max_output_tokens: 512, input: 'x', ...body }) });
const URL_RESPONSES = 'https://openrouter.ai/api/v1/responses';

test('capture keeps raw bodies for successes and failures, leaves responses readable and never stores headers', async () => {
  const replies = [new Response('{"error":{"message":"busy"}}', { status: 503 }), new Response(responsesBody(), { status: 200 })];
  const capture = createReceiptCapture((async () => replies.shift()!) as typeof fetch);
  capture.arm(arm());
  const failed = await capture.fetch(URL_RESPONSES, paidInit());
  assert.equal(failed.status, 503);
  const ok = await capture.fetch(URL_RESPONSES, paidInit());
  assert.equal((await ok.json() as any).id, 'gen-1'); // caller still gets an unread body
  const requests = capture.disarm();
  assert.deepEqual(requests.map(r => [r.kind, r.status, r.ok]), [['paid', 503, false], ['paid', 200, true]]);
  assert.match(requests[0]!.responseText!, /busy/);
  assert.equal(requests[1]!.maxOutputTokens, 512);
  assert.ok(requests[1]!.requestSha256 && requests[1]!.requestBytes! > 0);
  assert.doesNotMatch(JSON.stringify(requests), /secret|authorization/i);
});

test('capture records network failures and rethrows them', async () => {
  const capture = createReceiptCapture((async () => { throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }); }) as typeof fetch);
  capture.arm(arm());
  await assert.rejects(capture.fetch(URL_RESPONSES, paidInit()), /socket hang up/);
  const [request] = capture.disarm();
  assert.equal(request!.networkError?.name, 'TimeoutError');
});

test('capture refuses unsafe paid requests before sending and stays halted', async () => {
  let sent = 0;
  const send = (async () => { sent++; return new Response(responsesBody()); }) as typeof fetch;
  const cases: Array<[string, () => Promise<unknown>, Partial<Arm>?]> = [
    ['paid-request-outside-operation', c => c.fetch(URL_RESPONSES, paidInit())],
    ['unexpected-openrouter-endpoint', c => c.fetch('https://openrouter.ai/api/v1/embeddings', paidInit())],
    ['unexpected-request-model', c => c.fetch(URL_RESPONSES, paidInit({ model: 'vendor/other' }))],
    ['uncapped-output', c => c.fetch(URL_RESPONSES, paidInit({ max_output_tokens: undefined }))],
    ['unverifiable-request-body', c => c.fetch(URL_RESPONSES, { method: 'POST' })],
    ['budget-guard', c => c.fetch(URL_RESPONSES, paidInit()), { roomLedgerCents: 0.0001 }],
  ];
  for (const [reason, call, overrides] of cases) {
    const capture = createReceiptCapture(send);
    if (reason !== 'paid-request-outside-operation') capture.arm(arm(overrides));
    await assert.rejects(() => call(capture), (error: unknown) => error instanceof RunnerHalt && error.reason.startsWith(reason), reason);
    assert.ok(capture.halted?.startsWith(reason));
    await assert.rejects(capture.fetch(URL_RESPONSES, paidInit()), RunnerHalt); // sticky
    assert.equal(capture.disarm()[0]!.kind, 'blocked');
  }
  assert.equal(sent, 0);
});

test('capture enforces the attempt allowance and accumulates reservations across attempts', async () => {
  const capture = createReceiptCapture((async () => new Response(responsesBody())) as typeof fetch);
  capture.arm(arm({ maxAttempts: 2 }));
  await capture.fetch(URL_RESPONSES, paidInit());
  await capture.fetch(URL_RESPONSES, paidInit());
  await assert.rejects(capture.fetch(URL_RESPONSES, paidInit()), /attempt-allowance-exceeded/);
  const worst = worstCaseLedgerCents(Buffer.byteLength(paidInit().body), 512, arm());
  const tight = createReceiptCapture((async () => new Response(responsesBody())) as typeof fetch);
  tight.arm(arm({ roomLedgerCents: worst * 1.5 }));
  await tight.fetch(URL_RESPONSES, paidInit());
  await assert.rejects(tight.fetch(URL_RESPONSES, paidInit()), /budget-guard/);
});

test('accounting lookups are free and unrecorded; other hosts are noted but not blocked', async () => {
  const capture = createReceiptCapture((async () => new Response('{}')) as typeof fetch);
  capture.arm(arm());
  await capture.fetch('https://openrouter.ai/api/v1/generation?id=g', { headers: { authorization: 'Bearer secret' } });
  await capture.fetch('https://openrouter.ai/api/v1/models');
  await capture.fetch('https://telemetry.example/ingest', { method: 'POST', body: '{}' });
  assert.deepEqual(capture.disarm().map(r => r.kind), ['foreign']);
});

function fakeLedger(markup = 1.1) {
  const pending: any[] = [];
  return {
    record(input: any) { if (!input.inputTokens && !input.outputTokens && !input.costCents) return null; const event = { ...input, costCents: input.costCents * markup }; pending.push(event); return event; },
    get pendingCount() { return pending.length; },
    checkpoint() { const events = pending.slice(); return { events, commit: () => { pending.splice(0); } }; },
  };
}
const paid = (seq: number, responseText: string, extra: Partial<CapturedRequest> = {}): CapturedRequest => ({ seq, at: '', kind: 'paid', method: 'POST', path: '/api/v1/responses', status: 200, ok: true, responseText, ...extra });
const deps = (overrides: Record<string, unknown> = {}) => {
  const ledger = fakeLedger();
  const persisted: any[][] = [];
  return { ledger, persisted, resolveUsage: async (a: any) => ({ inputTokens: a.usage.inputTokens, outputTokens: a.usage.outputTokens, costCents: 0.1, metadata: { costSource: 'provider' } }), persist: async (events: any[]) => { persisted.push(events); return events.reduce((s, e) => s + e.costCents, 0); }, prices: { inputPerToken: 1e-6, outputPerToken: 2e-6 }, ...overrides } as any;
};
const ctx = { operation: 'summary', model: 'vendor/model-a', metadata: { experiment: 'x', caseId: 'c' } };

test('accounting ledgers every ok receipt in either shape and keeps provider and ledger cost apart', async () => {
  const d = deps();
  const acc = await accountRequests([paid(1, '{"error":{}}', { status: 429, ok: false }), paid(2, responsesBody()), paid(3, chatBody)], ctx, d);
  assert.equal(acc.attempts, 3);
  assert.equal(acc.failedAttempts.length, 1);
  assert.equal(acc.receipts.length, 2);
  assert.ok(Math.abs(acc.providerCostCents - 0.2) < 1e-12 && Math.abs(acc.ledgerCostCents - 0.22) < 1e-12);
  assert.equal(acc.persisted, true);
  assert.equal(d.persisted[0].length, 2);
  assert.equal(d.persisted[0][0].metadata.receiptId, 'gen-1');
  assert.equal(d.persisted[0][0].metadata.experiment, 'x');
  assert.deepEqual(reconcile(acc, { generations: 2, inputTokens: 107, outputTokens: 29 }, 1).problems, []);
});

test('accounting never drops a receipt silently: unparseable, zero-usage, missing cost and persistence faults all surface', async () => {
  const garbage = await accountRequests([paid(1, 'not json')], ctx, deps());
  assert.deepEqual(garbage.unaccounted, [{ seq: 1, reason: 'unparseable-json' }]);

  const zero = await accountRequests([paid(1, responsesBody({ usage: { input_tokens: 0, output_tokens: 0 } }))], ctx, deps({ resolveUsage: async () => ({ inputTokens: 0, outputTokens: 0, costCents: 0 }) }));
  assert.deepEqual(zero.unaccounted, [{ seq: 1, reason: 'ledger-rejected-zero-usage' }]);

  const throwing = deps({ resolveUsage: async () => { throw new Error('lookup down'); } });
  const estimated = await accountRequests([paid(1, responsesBody())], ctx, throwing);
  assert.equal(estimated.receipts[0]!.estimated, true);
  assert.equal(estimated.receipts[0]!.costSource, 'runner-catalog-estimate');
  assert.ok(Math.abs(estimated.receipts[0]!.providerCostCents - (100 * 1e-6 + 20 * 2e-6) * 100) < 1e-12);
  assert.equal(throwing.persisted[0][0].metadata.costReconciliationRequired, true);
  assert.match(reconcile(estimated, { generations: 1, inputTokens: 100, outputTokens: 20 }, 1).problems.join(), /estimated-cost/);

  const down = await accountRequests([paid(1, responsesBody())], ctx, deps({ persist: async () => { throw new Error('db down'); } }));
  assert.equal(down.persisted, false);
  assert.equal(down.events.length, 1); // kept for the local ledger file
  assert.match(reconcile(down, { generations: 1, inputTokens: 100, outputTokens: 20 }, 1).problems.join(), /persistence-failed/);
});

test('reconciliation rejects zero-call successes and missed calls, and warns on billed-but-unreported generations', async () => {
  const none = await accountRequests([], ctx, deps());
  assert.match(reconcile(none, { generations: 0, inputTokens: 0, outputTokens: 0 }, 1).problems.join(), /no-provider-call-observed/);
  assert.deepEqual(reconcile(none, { generations: 0, inputTokens: 0, outputTokens: 0 }, 0).problems, []);
  const one = await accountRequests([paid(1, responsesBody())], ctx, deps());
  assert.match(reconcile(one, { generations: 2, inputTokens: 0, outputTokens: 0 }, 2).problems.join(), /missed-calls/);
  const orphan = reconcile(one, { generations: 0, inputTokens: 0, outputTokens: 0 }, 1);
  assert.deepEqual(orphan.problems, []);
  assert.equal(orphan.orphanReceipts, 1);
  assert.match(orphan.warnings.join(), /billed-but-unreported/);
  assert.match(reconcile(one, { generations: 1, inputTokens: 1, outputTokens: 1 }, 1).warnings.join(), /token-mismatch/);
  const mismatch = { ...one, persistedCents: one.ledgerCostCents * 2 };
  assert.match(reconcile(mismatch, { generations: 1, inputTokens: 100, outputTokens: 20 }, 1).problems.join(), /persisted-cost-mismatch/);
});

test('source identity refuses staged, untracked and dirty runner or candidate code and a foreign checkout', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'identity-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  for (const dir of ['worker/src', 'packages/shared/src', 'scripts/extraction-quality']) mkdirSync(resolve(root, dir), { recursive: true });
  writeFileSync(resolve(root, 'worker/src/a.ts'), 'a');
  writeFileSync(resolve(root, 'packages/shared/src/b.ts'), 'b');
  writeFileSync(resolve(root, 'scripts/extraction-quality/run.mts'), 'r');
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');
  const clean = sourceIdentity(root);
  assert.match(clean.head, /^[0-9a-f]{40}$/);
  assert.ok(clean.workerTree && clean.sharedTree && clean.runnerBlob);
  writeFileSync(resolve(root, 'scripts/extraction-quality/other.mjs'), 'owned by someone else');
  sourceIdentity(root); // unrelated files do not block
  writeFileSync(resolve(root, 'worker/src/a.ts'), 'changed'); git('add', 'worker/src/a.ts'); // staged, invisible to a bare `git diff`
  assert.throws(() => sourceIdentity(root), /Commit candidate/);
  git('commit', '-qm', 'candidate');
  writeFileSync(resolve(root, 'worker/src/new.ts'), 'untracked');
  assert.throws(() => sourceIdentity(root), /Commit candidate/);
  execFileSync('rm', [resolve(root, 'worker/src/new.ts')]);
  writeFileSync(resolve(root, 'scripts/extraction-quality/run.mts'), 'edited');
  assert.throws(() => sourceIdentity(root), /Commit candidate/);
  git('checkout', '--', 'scripts/extraction-quality/run.mts');
  mkdirSync(resolve(root, 'nested'));
  assert.throws(() => sourceIdentity(resolve(root, 'nested')), /own core checkout/);
});

test('inputs come from the gold-free list only, and every source is hash-checked against the frozen manifest', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'dataset-'));
  mkdirSync(resolve(root, 'development'));
  const text = 'page one\fpage two';
  const sha = createHash('sha256').update(text).digest('hex');
  const id = 'case-aaaaaaaaaaaa';
  writeFileSync(resolve(root, 'development', `${id}.txt`), text);
  const write = (inputs: unknown, manifest: unknown) => {
    writeFileSync(resolve(root, 'development/runner-inputs.json'), JSON.stringify(inputs));
    writeFileSync(resolve(root, 'integrity-manifest.json'), JSON.stringify(manifest));
  };
  const inputs = (source: Record<string, unknown> = {}) => ({ schema: 'docslurp-extraction-quality-inputs@v1', split: 'development', cases: [{ id, source: { path: `${id}.txt`, sha256: sha, ...source } }] });
  write(inputs(), { cases: [{ id, source: { sha256: sha } }] }); // no label files exist at all
  const [loaded] = await loadInputs(root, 'development', 10);
  assert.equal(loaded!.text, text);
  assert.equal(loaded!.pageSeparator, '\f');
  write(inputs({ sha256: 'f'.repeat(64) }), { cases: [{ id, source: { sha256: sha } }] });
  await assert.rejects(loadInputs(root, 'development', 10), /changed after dataset freeze/);
  write(inputs(), { cases: [{ id, source: { sha256: 'e'.repeat(64) } }] });
  await assert.rejects(loadInputs(root, 'development', 10), /not covered by the integrity-checked manifest/);
  write(inputs({ path: '../escape.txt' }), { cases: [{ id, source: { sha256: sha } }] });
  await assert.rejects(loadInputs(root, 'development', 10));
  write({ ...inputs(), split: 'heldout' }, { cases: [] });
  await assert.rejects(loadInputs(root, 'development', 10), /mismatched/);
});

test('page and paragraph preparation follows the production stage limits', () => {
  const prepared = prepareText('one\ftwo', '\f');
  assert.equal(prepared.document, 'one\n\ntwo');
  assert.deepEqual(prepared.chunks.map(c => c.pageNumber), [1, 2]);
  const para = (n: number) => 'x'.repeat(n);
  assert.deepEqual(pointBatches([para(99), para(100), para(1500), para(1500), para(200)].join('\n\n')).map(b => b.length), [2, 2]);
  assert.deepEqual(pointBatches(para(50)), []);
});

test('the harness refuses to run against production code whose mirrored limits changed', async () => {
  await assertProductionSeams(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  const root = mkdtempSync(resolve(tmpdir(), 'seams-'));
  mkdirSync(resolve(root, 'worker/src/stages'), { recursive: true });
  writeFileSync(resolve(root, 'worker/src/stages/proposition-index.ts'), 'batchParagraphs(paragraphs, 4000)');
  await assert.rejects(assertProductionSeams(root), /Production seam changed/);
});

test('scorer outputs omit unrequested artifacts and emit empty ones for failed generations', () => {
  const records = [
    { id: 'a', repetition: 0, graph: { entities: [{ name: 'A' }], relationships: [], source: 'llm' }, keyPoints: ['p'], summary: 's' },
    { id: 'b', repetition: 0, graph: null, keyPoints: [], summary: '' },
    { id: 'a', repetition: 1, graph: null, keyPoints: [], summary: '' },
  ];
  const out = scorerOutputs(records, { runId: 'r', split: 'development', repetition: 0, operations: ['graph', 'summary'] });
  assert.equal(out.schema, 'docslurp-extraction-quality-outputs@v1');
  assert.deepEqual(Object.keys(out.cases), ['a', 'b']);
  assert.deepEqual(out.cases.b, { graph: { entities: [], relationships: [] }, summary: '' });
  assert.equal('keyPoints' in out.cases.a, false);
  assert.equal('source' in out.cases.a.graph, false);
});

test('error descriptions keep the cause but never the API key', () => {
  const error = Object.assign(new Error('401 for key sk-secret-1'), { name: 'AI_APICallError', statusCode: 401, responseBody: '{"detail":"sk-secret-1 invalid"}' });
  const described = describeError(error, 'sk-secret-1');
  assert.equal(described.statusCode, 401);
  assert.doesNotMatch(JSON.stringify(described), /sk-secret-1/);
  assert.match(described.responseBody!, /invalid/);
});
