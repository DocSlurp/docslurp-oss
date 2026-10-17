// Sentinel tests for the extraction-quality scorer and dataset builder.
// Fixtures are synthetic and invented here; no authored dataset content appears in this file.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildDataset } from './build-dataset.mjs';
import { aggregateOnly, parseNumbers, scoreCase, scoreGraph, scoreProse, scoreRun, splitUnits, tokens } from './score.mjs';

const SOURCE = [
  'Hale Voss founded the Tarn Institute in 1961. The Institute employs at least 40 researchers.',
  'Ines Marlow succeeded Voss as director in 1998. The board did not approve the relocation.',
].join('\f');
const q = (page, quote) => ({ page, quote });
const gold = {
  id: 'synthetic-case-01', split: 'development', summaryWordLimit: 60,
  entities: [
    { id: 'voss', name: 'Hale Voss', aliases: ['Voss'] },
    { id: 'tarn', name: 'Tarn Institute', aliases: ['the Institute', 'Tarn'] },
    { id: 'marlow', name: 'Ines Marlow', aliases: ['Marlow', 'Dr. Marlow'] },
  ],
  relations: [
    { id: 'r-founded', source: 'voss', target: 'tarn', predicates: ['founded'], inversePredicates: ['founded by'], evidence: [q(1, 'Hale Voss founded the Tarn Institute in 1961.')] },
    { id: 'r-succeeded', source: 'marlow', target: 'voss', predicates: ['succeeded'], inversePredicates: ['succeeded by', 'predecessor of'], evidence: [q(2, 'Ines Marlow succeeded Voss as director in 1998.')] },
    { id: 'r-worked', source: 'marlow', target: 'voss', predicates: ['worked with'], symmetric: true, evidence: [q(2, 'Ines Marlow succeeded Voss as director in 1998.')] },
  ],
  forbiddenRelations: [{ id: 'f-owns', source: 'marlow', target: 'tarn', predicates: ['founded'] }],
  facts: [
    { id: 'f-founded', salient: true, statement: 'Hale Voss founded the Tarn Institute in 1961.', evidence: [q(1, 'Hale Voss founded the Tarn Institute in 1961.')], variants: [{ groups: ['voss', 'found', 'tarn|institute'] }], numbers: [{ value: 1961 }] },
    { id: 'f-staff', statement: 'The Institute employs at least 40 researchers.', evidence: [q(1, 'The Institute employs at least 40 researchers.')], variants: [{ groups: ['institute|tarn', 'employ', 'researchers', 'at least|minimum'] }], numbers: [{ value: 40 }], contradictions: [{ id: 'wrong-bound', reason: 'upper bound stated as lower bound', variants: [{ groups: ['institute|tarn', 'employ', 'researchers', 'at most|up to'] }] }] },
    { id: 'f-succeeded', statement: 'Ines Marlow succeeded Voss as director in 1998.', evidence: [q(2, 'Ines Marlow succeeded Voss as director in 1998.')], variants: [{ groups: ['marlow', 'succeed', 'voss'], ordered: true }, { groups: ['voss', 'succeeded by', 'marlow'], ordered: true }], numbers: [{ value: 1998 }], contradictions: [{ id: 'reversed-succession', reason: 'roles reversed', variants: [{ groups: ['voss', 'succeeded(?! by)', 'marlow'], ordered: true }] }] },
    { id: 'f-board', salient: true, polarity: 'negative', statement: 'The board did not approve the relocation.', evidence: [q(2, 'The board did not approve the relocation.')], variants: [{ groups: ['board', 'approv|consent', 'relocation'] }, { groups: ['board', 'reject|declin|refus|veto', 'relocation'], inherentNegation: true }] },
  ],
  forbiddenClaims: [], allowedTerms: [], allowedNumbers: [],
};
const ids = (list) => list.map((e, i) => ({ id: `e${i}`, name: e }));
const edge = (source, predicate, target) => ({ source, predicate, target });
const reference = {
  graph: { entities: [{ id: 'a', name: 'Hale Voss' }, { id: 'b', name: 'the Institute' }, { id: 'c', name: 'Marlow' }], relationships: [edge('a', 'founded', 'b'), edge('c', 'succeeded', 'a'), edge('a', 'worked with', 'c')] },
  keyPoints: ['Hale Voss founded the Tarn Institute in 1961.', 'The Institute employs at least 40 researchers.', 'Ines Marlow succeeded Voss as director in 1998.', 'The board rejected the relocation.'],
  summary: 'Hale Voss founded the Tarn Institute in 1961 and Ines Marlow succeeded Voss in 1998, but the board did not approve the relocation.',
};
const run = (output, review = null, sourceText = SOURCE) => scoreRun({ cases: [{ id: gold.id, gold, sourceText }], outputs: { cases: { [gold.id]: output } }, review });
const blind = (items) => ({ schema: 'docslurp-quality-review@v1', reviewer: 'reviewer', blind: true, independentOfAuthor: true, items });
const only = (r) => r.cases[0];
const unitsOf = (r, field) => r.cases[0].details[field].units;

test('reference answer is fully covered, sound, and still needs blind review', () => {
  const r = run(reference), c = only(r);
  assert.equal(c.graph.f1, 1);
  assert.equal(c.keyPoints.coverage, 1);
  assert.equal(c.keyPoints.soundness, 1);
  assert.equal(c.summary.coverage, 1);
  assert.equal(r.aggregate.contradictions, 0);
  assert.equal(r.aggregate.verdict, 'needs-review');
  assert.equal(run(reference, blind({})).aggregate.verdict, 'pass');
});

test('graph: reversed directed edges are contradicted, never supported', () => {
  const g = scoreGraph(gold, { entities: ids(['Hale Voss', 'Tarn Institute']), relationships: [edge('e1', 'founded', 'e0'), edge('Hale Voss', 'succeeded', 'Ines Marlow'), edge('Tarn Institute', 'founded by', 'Hale Voss')] });
  assert.deepEqual(g.unsupported.map((e) => [e.class, e.reason]), [['contradicted', 'reversed'], ['contradicted', 'reversed']]);
  assert.equal(g.supportedEdges, 1, 'the inverse predicate with swapped endpoints is a correct edge');
  const r = run({ ...reference, graph: { entities: reference.graph.entities, relationships: [edge('b', 'founded', 'a'), edge('a', 'succeeded', 'c')] } });
  assert.equal(r.aggregate.verdict, 'fail');
  assert.equal(r.aggregate.graph.contradictedEdges, 2);
});

test('graph: symmetric relations accept either orientation; reciprocal edges need both directions', () => {
  assert.equal(scoreGraph(gold, { relationships: [edge('Voss', 'worked with', 'Marlow')] }).covered.includes('r-worked'), true);
  const reciprocal = { ...gold, relations: [{ id: 'ab', source: 'voss', target: 'marlow', predicates: ['mentors'] }, { id: 'ba', source: 'marlow', target: 'voss', predicates: ['mentors'] }] };
  const half = scoreGraph(reciprocal, { relationships: [edge('Voss', 'mentors', 'Marlow')] });
  assert.deepEqual(half.missing, ['ba']);
  assert.equal(scoreGraph(reciprocal, { relationships: [edge('Voss', 'mentors', 'Marlow'), edge('Marlow', 'mentors', 'Voss')] }).missing.length, 0);
});

test('graph: aliases and entity ids resolve; unknown endpoints and predicates are unmatched, not supported', () => {
  const g = scoreGraph(gold, { entities: [{ id: '1', name: 'Dr. Marlow' }, { id: '2', name: 'someone else' }], relationships: [edge('1', 'Succeeded', 'Voss'), edge('1', 'admires', 'Voss'), edge('2', 'founded', 'Tarn'), edge('1', 'succeeded', 'Voss')] });
  assert.equal(g.supportedEdges, 1);
  assert.equal(g.unsupported.length, 2);
  assert.ok(g.unsupported.every((e) => e.class === 'unmatched'));
  assert.deepEqual(g.unsupported.map((e) => e.reason), [undefined, 'unresolved-endpoint']);
});

test('graph: a forbidden relation and a self loop are contradictions', () => {
  const g = scoreGraph(gold, { relationships: [edge('Marlow', 'founded', 'Tarn'), edge('Voss', 'founded', 'Voss')] });
  assert.deepEqual(g.unsupported.map((e) => e.reason).sort(), ['forbidden', 'self-loop']);
});

test('graph: no-relations control penalises any edge and rewards an empty graph', () => {
  const control = { ...gold, relations: [], forbiddenRelations: [] };
  const empty = scoreRun({ cases: [{ id: 'c', gold: control }], outputs: { cases: { c: { ...reference, graph: { entities: [], relationships: [] } } } } });
  assert.equal(empty.cases[0].graph.f1, 1);
  const invented = scoreRun({ cases: [{ id: 'c', gold: control }], outputs: { cases: { c: { ...reference, graph: { entities: [], relationships: [edge('Voss', 'founded', 'Tarn')] } } } } });
  assert.equal(invented.cases[0].graph.precision, 0);
  assert.equal(invented.aggregate.graph.controls.withEdges, 1);
});

test('wrong numbers contradict; right number words and separators match', () => {
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['Hale Voss founded the Tarn Institute in 1951.'] }), 'keyPoints')[0].status, 'contradicted');
  assert.equal(run({ ...reference, keyPoints: ['The Institute employs at least 400 researchers.'] }).aggregate.verdict, 'fail');
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['The Institute employs at least forty researchers.'] }), 'keyPoints')[0].status, 'supported');
  assert.deepEqual(parseNumbers('1,200 and 3.5 and 2.5 million and twenty-five and one hundred and five and 4th and one'), [1200, 3.5, 2500000, 25, 105]);
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['The Institute employs at most 40 researchers.'] }), 'keyPoints')[0].status, 'contradicted', 'wrong qualifier with the right number');
});

test('a number explained by another covered fact in the same sentence is not a wrong number', () => {
  const g = { ...gold, facts: [
    { id: 'cap', statement: 'The ceiling was 3.2 million.', evidence: [q(1, 'x')], variants: [{ groups: ['ceiling'] }], numbers: [{ value: 3200000 }], lexicon: ['above', 'original'] },
    { id: 'cost', statement: 'The final cost was 3.45 million.', evidence: [q(1, 'x')], variants: [{ groups: ['final cost'] }], numbers: [{ value: 3450000 }] },
  ] };
  const both = scoreProse(g, ['The final cost was 3.45 million, above the original ceiling of 3.2 million.']);
  assert.equal(both.units[0].status, 'supported');
  const wrong = scoreProse(g, ['The ceiling was 3.45 million.']);
  assert.equal(wrong.units[0].status, 'contradicted');
  const onlyOne = scoreProse(g, ['The final cost was 3.45 million, above the original ceiling.']);
  assert.deepEqual(onlyOne.covered, ['cost']);
  assert.notEqual(onlyOne.units[0].status, 'contradicted');
});

test('negation: lost or added negation contradicts, bounds like "no more than" are not negation', () => {
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['The board approved the relocation.'] }), 'keyPoints')[0].status, 'contradicted');
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['The board did not reject the relocation.'] }), 'keyPoints')[0].status, 'contradicted');
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['The board declined the relocation.'] }), 'keyPoints')[0].status, 'supported');
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['Hale Voss did not found the Tarn Institute in 1961.'] }), 'keyPoints')[0].status, 'contradicted');
  const bound = { ...gold, facts: [{ id: 'cap', statement: 'The Institute employs no more than 40 researchers.', evidence: [q(1, 'The Institute employs at least 40 researchers.')], salient: true, variants: [{ groups: ['institute', 'employ', 'researchers'] }], numbers: [{ value: 40 }] }] };
  assert.equal(scoreProse(bound, ['The Institute employs no more than 40 researchers.']).units[0].status, 'supported');
});

test('a negated rendering of a contradiction signature is not itself a contradiction', () => {
  const g = { ...gold, facts: [{ id: 'denied', polarity: 'negative', statement: 'Marlow did not report to Voss.', evidence: [q(1, 'x')], variants: [{ groups: ['marlow', 'report', 'voss'], ordered: true }] }, { id: 'line', statement: 'Voss reports to Marlow.', evidence: [q(1, 'x')], variants: [{ groups: ['voss', 'report', 'marlow'], ordered: true }], contradictions: [{ id: 'swap', variants: [{ groups: ['marlow', 'reports? to', 'voss'], ordered: true }] }] }] };
  assert.equal(scoreProse(g, ['Marlow did not report to Voss.']).units[0].status, 'supported');
  assert.equal(scoreProse(g, ['Marlow reports to Voss.']).units[0].status, 'contradicted');
});

test('roles reversed in prose contradict even though every term is present', () => {
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['Voss succeeded Ines Marlow as director in 1998.'] }), 'keyPoints')[0].status, 'contradicted');
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['Voss was succeeded by Ines Marlow as director in 1998.'] }), 'keyPoints')[0].status, 'supported');
});

test('fluent irrelevant and empty answers earn nothing and cannot pass', () => {
  const fluent = 'The quarterly harvest festival drew many visitors and local vendors praised the weather.';
  const r = run({ graph: { entities: [], relationships: [] }, keyPoints: [fluent], summary: fluent }, blind({}));
  assert.equal(only(r).keyPoints.coverage, 0);
  assert.equal(only(r).summary.coverage, 0);
  assert.notEqual(r.aggregate.verdict, 'pass');
  assert.equal(unitsOf(r, 'keyPoints')[0].status, 'unverified');
  const empty = run({ graph: { entities: [], relationships: [] }, keyPoints: [], summary: '' }, blind({}));
  assert.equal(empty.aggregate.keyPoints.pooledCoverage, 0);
  assert.notEqual(empty.aggregate.verdict, 'pass');
  assert.equal(run(undefined).aggregate.verdict, 'fail');
});

test('sentinel: a whole-sentence fact match cannot hide an appended unsupported claim', () => {
  const clean = 'Hale Voss founded the Tarn Institute in 1961';
  for (const appended of [
    `${clean} and a visiting zeppelin delivered marmalade.`,
    `${clean}, a decision criticised by regulators.`,
    `${clean} and the board also resigned.`,
    `${clean} and hired 900 guards.`,
    `${clean}, and Marlow was arrested.`,
  ]) {
    const unit = unitsOf(run({ ...reference, keyPoints: [appended] }), 'keyPoints')[0];
    assert.notEqual(unit.status, 'supported', appended);
    assert.ok(unit.residualTerms?.length || unit.unsupportedNumbers?.length || unit.status === 'contradicted', appended);
  }
  const r = run({ ...reference, summary: `${reference.summary.replace(/\.$/u, '')} and a visiting zeppelin delivered marmalade.` });
  assert.equal(unitsOf(r, 'summary')[0].status, 'unverified');
  assert.equal(only(r).summary.coverage, 1, 'the true facts are still credited');
  assert.equal(only(r).summary.soundness, 0, 'but the sentence is not counted as supported');
  assert.equal(run({ ...reference, summary: `${reference.summary.replace(/\.$/u, '')} and a visiting zeppelin delivered marmalade.` }, blind({})).aggregate.verdict, 'needs-review');
});

test('summary is scored on salient facts only; key points on every fact', () => {
  const summary = 'Hale Voss founded the Tarn Institute in 1961, and the board did not approve the relocation.';
  const r = run({ ...reference, summary });
  assert.equal(only(r).summary.expected, 2);
  assert.equal(only(r).summary.coverage, 1);
  assert.equal(only(r).keyPoints.expected, 4);
  assert.equal(only(run({ ...reference, keyPoints: reference.keyPoints.slice(0, 2) })).keyPoints.coverage, 0.5);
});

test('unknowns stay unverified until a valid blind independent review resolves them', () => {
  const out = { ...reference, keyPoints: [...reference.keyPoints, 'The Institute runs a telescope.'], graph: { ...reference.graph, relationships: [...reference.graph.relationships, edge('c', 'admires', 'a')] } };
  const r = run(out);
  const queue = r.queue.items;
  assert.equal(queue.length, 2);
  assert.equal(r.aggregate.verdict, 'needs-review');
  const verdicts = Object.fromEntries(queue.map((i) => [i.itemId, 'supported']));
  assert.equal(run(out, blind(verdicts)).aggregate.verdict, 'pass');
  assert.equal(run(out, { ...blind(verdicts), blind: false }).aggregate.verdict, 'needs-review');
  assert.equal(run(out, { ...blind(verdicts), independentOfAuthor: false }).aggregate.verdict, 'needs-review');
  assert.equal(run(out, blind({ [queue[0].itemId]: 'supported' })).aggregate.verdict, 'needs-review', 'every queued item needs a verdict');
  const rejected = run(out, blind({ ...verdicts, [queue.find((i) => i.type === 'unit').itemId]: 'unsupported' }));
  assert.equal(rejected.aggregate.verdict, 'fail');
  assert.equal(run({ ...out, keyPoints: ['The board approved the relocation.'] }, blind({})).aggregate.verdict, 'fail', 'a review cannot clear a contradiction');
  assert.equal(run(out, blind({ nonsense: 'supported' })).review.ignoredVerdicts, 1);
});

test('missed facts are reviewable; reviewed coverage updates but never exceeds the artifact', () => {
  const out = { ...reference, keyPoints: ['Voss started the Tarn Institute during 1961.', ...reference.keyPoints.slice(1)] };
  const r = run(out);
  const miss = r.queue.items.find((i) => i.type === 'fact');
  assert.ok(miss && miss.factId === 'f-founded' && miss.artifactText.includes('started'));
  assert.equal(only(r).keyPoints.coverage, 0.75);
  const reviewed = run(out, blind(Object.fromEntries(r.queue.items.map((i) => [i.itemId, i.type === 'fact' ? 'covered' : 'supported']))));
  assert.equal(only(reviewed).keyPoints.coverage, 1);
  assert.equal(reviewed.deterministic.keyPoints.pooledCoverage, 0.75, 'deterministic numbers stay available beside reviewed ones');
});

test('review queue is deduplicated, carries no scores, and is ordered independently of input order', () => {
  const ids = (points) => run({ ...reference, keyPoints: [...points, ...reference.keyPoints] }).queue.items.map((i) => i.itemId);
  const a = ids(['The Institute runs a telescope.', 'Tarn grows lemons.', 'Tarn grows lemons.']);
  const b = ids(['Tarn grows lemons.', 'The Institute runs a telescope.']);
  assert.deepEqual(a, b);
  const item = run({ ...reference, keyPoints: ['Tarn grows lemons.'] }).queue.items.find((i) => i.type === 'unit');
  assert.deepEqual(Object.keys(item).sort(), ['caseId', 'field', 'itemId', 'itemSha256', 'sourceSha256', 'text', 'type']);
});

test('aggregate-only output drops case ids, units and review text', () => {
  const text = JSON.stringify(aggregateOnly(run({ ...reference, keyPoints: ['Tarn grows lemons.'] })));
  assert.ok(!text.includes('synthetic-case-01') && !text.includes('lemons') && !/"cases":\s*\[/u.test(text) && !text.includes('"queue"') && !text.includes('"details"'));
  assert.ok(text.includes('pooledCoverage'));
});

test('repeated generations are scored independently and pooled', () => {
  const r = scoreRun({ cases: [{ id: gold.id, gold }], outputs: { cases: { [gold.id]: [reference, { ...reference, keyPoints: [] }] } } });
  assert.equal(r.aggregate.generations, 2);
  assert.equal(r.aggregate.keyPoints.pooledCoverage, 0.5);
});

test('envelope and paragraph checks are diagnostics, not correctness', () => {
  const messy = scoreCase(gold, { ...reference, summary: `- ${reference.summary}\n\nSecond paragraph.` });
  assert.equal(messy.summary.diagnostics.oneParagraph, false);
  assert.equal(messy.summary.covered.length, 2);
  const missing = run({ graph: reference.graph, keyPoints: reference.keyPoints, summary: 42 });
  assert.equal(only(missing).envelope.valid, false);
  assert.equal(only(missing).keyPoints.coverage, 1);
  assert.equal(only(run({ ...reference, summary: 'word '.repeat(100) })).summary.diagnostics.withinWordLimit, false);
});

test('units: abbreviations, decimals, list markers and CJK are handled', () => {
  assert.deepEqual(splitUnits('Dr. Marlow measured 3.5 metres. She left; later returned.'), ['Dr. Marlow measured 3.5 metres.', 'She left', 'later returned.']);
  assert.deepEqual(splitUnits('It runs between 7 a.m. and 7 p.m. daily. Done.'), ['It runs between 7 a.m. and 7 p.m. daily.', 'Done.']);
  assert.deepEqual(splitUnits(['- first item', '2) second item']), ['first item', 'second item']);
  assert.deepEqual(tokens('東京は首都'), ['東', '京', 'は', '首', '都'].map((t) => t));
});

// ---- reviewer-backed adjudication (review schema v2) ------------------------------------
const QUOTE = 'Hale Voss founded the Tarn Institute in 1961.';
const POSITIVE = { unit: 'supported', edge: 'supported', fact: 'covered', relation: 'covered' };
/** A v2 review that answers every queued item; `pick` overrides entries (or the whole entry) by item id or predicate. */
const reviewV2 = (queue, pick = () => ({}), header = {}) => ({
  schema: 'docslurp-quality-review@v2', reviewer: 'independent-reviewer', blind: true, independentOfAuthor: true, ...header,
  items: Object.fromEntries(queue.items.map((i) => [i.itemId, {
    verdict: POSITIVE[i.type], itemSha256: i.itemSha256, evidence: [QUOTE],
    ...(i.type === 'relation' ? { coveredBy: i.candidates[0]?.edgeId } : {}), ...pick(i),
  }])),
});
// True to the source ("did not approve"), but without any negation cue the heuristic can see.
const PARAPHRASE = 'The board withheld consent for the relocation.';
const flaggedOutput = { ...reference, keyPoints: [...reference.keyPoints.slice(0, 3), PARAPHRASE] };
const flaggedItem = (r) => r.queue.items.find((i) => i.type === 'unit' && i.text === PARAPHRASE);
const reasons = (r) => r.review.rejected.map((x) => x.reason);

test('a heuristic contradiction flag fails unreviewed and is queued blind, indistinguishable from other units', () => {
  const r = run(flaggedOutput);
  assert.equal(unitsOf(r, 'keyPoints')[3].status, 'contradicted');
  assert.equal(r.aggregate.verdict, 'fail');
  assert.equal(r.aggregate.contradictions, 1);
  const item = flaggedItem(r);
  assert.ok(item, 'the flagged unit is queued for independent judgement');
  assert.deepEqual(Object.keys(item).sort(), Object.keys(r.queue.items.find((i) => i.type === 'unit' && i !== item) ?? item).sort());
  assert.ok(!('flags' in item) && !('contradictions' in item) && !('status' in item), 'no flag detail leaks into the queue');
  assert.equal(r.queue.items.length > 0 && r.queue.items.every((i) => i.itemSha256 && /^[0-9a-f]{64}$/u.test(i.itemSha256)), true);
});

test('an explicit, bound, evidenced independent verdict overrules a heuristic flag; the override is itemised in the report', () => {
  const first = run(flaggedOutput);
  const review = reviewV2(first.queue, (i) => (i.text === PARAPHRASE ? { rationale: 'withheld consent = did not approve' } : {}));
  const r = run(flaggedOutput, review);
  assert.deepEqual(r.review.rejected, []);
  assert.equal(r.aggregate.contradictions, 0);
  assert.equal(r.aggregate.adjudication.flagsOverruled, 1);
  assert.equal(r.aggregate.verdict, 'pass');
  assert.equal(r.deterministic.contradictions, 1, 'the unreviewed numbers stay beside the reviewed ones');
  assert.equal(r.deterministic.verdict, 'fail');
  const [a] = r.review.adjudications.filter((x) => x.overrides === 'flag');
  assert.equal(a.verdict, 'supported');
  assert.equal(a.reviewer, 'independent-reviewer');
  assert.equal(a.itemSha256, flaggedItem(first).itemSha256);
  assert.deepEqual(a.evidence, [QUOTE]);
});

test('overrides never count silently: legacy, unbound, unevidenced, stale, misquoted, unsourced or non-independent verdicts leave the flag standing', () => {
  const first = run(flaggedOutput), id = flaggedItem(first).itemId;
  const standing = (r) => r.aggregate.verdict === 'fail' && r.aggregate.contradictions === 1;
  const entry = (patch) => reviewV2(first.queue, (i) => (i.itemId === id ? patch : {}));
  const cases = [
    ['legacy string verdict', blind(Object.fromEntries(first.queue.items.map((i) => [i.itemId, POSITIVE[i.type]]))), 'invalid-verdict', false],
    ['legacy string inside v2', { ...entry({}), items: { ...entry({}).items, [id]: 'supported' } }, 'missing-binding', true],
    ['no binding', entry({ itemSha256: undefined }), 'missing-binding', true],
    ['stale binding', entry({ itemSha256: 'f'.repeat(64) }), 'stale-binding', true],
    ['no evidence', entry({ evidence: [] }), 'missing-evidence', true],
    ['quote not in source', entry({ evidence: ['The board unanimously approved the relocation in 1961.'] }), 'evidence-not-in-source', true],
    ['trivial quote', entry({ evidence: ['the board'] }), 'evidence-not-in-source', true],
  ];
  for (const [name, review, reason, isV2] of cases) {
    const r = run(flaggedOutput, review);
    assert.ok(standing(r), name);
    if (isV2) assert.ok(reasons(r).includes(reason), `${name}: ${reasons(r)}`);
  }
  assert.ok(standing(run(flaggedOutput, { ...entry({}), blind: false })), 'non-blind');
  assert.ok(standing(run(flaggedOutput, { ...entry({}), independentOfAuthor: false })), 'author-reviewed');
  assert.equal(standing(run(flaggedOutput, entry({}))), false, 'sanity: the same entry clears the flag when the source is available');
  const noSource = { cases: [{ id: gold.id, gold }], outputs: { cases: { [gold.id]: flaggedOutput } } };
  assert.ok(reasons(scoreRun({ ...noSource, review: entry({}) })).includes('stale-binding'), 'bindings include the source hash');
  const unsourced = scoreRun({ ...noSource, review: reviewV2(scoreRun(noSource).queue) });
  assert.equal(unsourced.aggregate.contradictions, 1, 'without a source nothing can be bound or quoted');
  assert.ok(reasons(unsourced).includes('source-unavailable'));
});

test('a stale review is rejected when the artifact changes: bindings follow the exact output', () => {
  const review = reviewV2(run(flaggedOutput).queue);
  const changed = { ...flaggedOutput, keyPoints: [...flaggedOutput.keyPoints, 'The Institute also employs 12 gardeners.'] };
  const r = run(changed, review);
  assert.equal(r.aggregate.contradictions, 1, 'the flag stands: its item id no longer exists for the new artifact');
  assert.ok(r.review.ignoredVerdicts > 0);
});

test('reviewer disagreement is honoured: contradicted or unsupported fail, and a reviewer can contradict an unflagged unit', () => {
  const first = run(flaggedOutput), id = flaggedItem(first).itemId;
  const confirmed = run(flaggedOutput, reviewV2(first.queue, (i) => (i.itemId === id ? { verdict: 'contradicted', evidence: undefined } : {})));
  assert.equal(confirmed.aggregate.verdict, 'fail');
  assert.equal(confirmed.aggregate.contradictions, 1);
  const unsupported = run(flaggedOutput, reviewV2(first.queue, (i) => (i.itemId === id ? { verdict: 'unsupported', evidence: undefined } : {})));
  assert.equal(unsupported.aggregate.verdict, 'fail');
  assert.equal(unsupported.aggregate.confirmedUnsupported, 1);
  const extra = { ...reference, keyPoints: [...reference.keyPoints, 'The Institute runs a telescope.'] };
  const q = run(extra).queue, telescope = q.items.find((i) => i.type === 'unit').itemId;
  const caught = run(extra, reviewV2(q, (i) => (i.itemId === telescope ? { verdict: 'contradicted', evidence: undefined } : {})));
  assert.equal(caught.aggregate.verdict, 'fail');
  assert.equal(caught.aggregate.contradictions, 1);
});

test('sentinels: reversed edge, wrong number, lost negation and unsupported additions fail or stay unreviewed; reviews cannot launder them', () => {
  const laundered = (out) => {
    const first = run(out);
    return run(out, reviewV2(first.queue));
  };
  const reversedEdge = { ...reference, graph: { entities: reference.graph.entities, relationships: [edge('b', 'founded', 'a')] } };
  assert.equal(run(reversedEdge).aggregate.verdict, 'fail');
  assert.equal(laundered(reversedEdge).aggregate.verdict, 'fail', 'structural graph contradictions are not adjudicable');
  assert.equal(laundered(reversedEdge).aggregate.graph.contradictedEdges, 1);
  const signature = { ...reference, keyPoints: ['Voss succeeded Ines Marlow as director in 1998.'] };
  assert.equal(run(signature).queue.items.some((i) => i.type === 'unit'), false, 'authored-signature flags are label matters, not reviewable');
  assert.equal(laundered(signature).aggregate.verdict, 'fail');
  const wrongNumber = { ...reference, keyPoints: ['Hale Voss founded the Tarn Institute in 1951.'] };
  assert.equal(run(wrongNumber).aggregate.verdict, 'fail');
  assert.equal(run(wrongNumber, blind({})).aggregate.verdict, 'fail');
  const lostNegation = { ...reference, keyPoints: ['The board approved the relocation.'] };
  assert.equal(run(lostNegation).aggregate.verdict, 'fail');
  assert.equal(run(lostNegation, reviewV2({ items: [] })).aggregate.verdict, 'fail');
  const addition = { ...reference, keyPoints: [`${reference.keyPoints[0].replace(/\.$/u, '')} and a visiting zeppelin delivered marmalade.`] };
  const unreviewed = run(addition);
  assert.notEqual(unreviewed.aggregate.verdict, 'pass');
  assert.equal(unreviewed.aggregate.targets.unsupportedUnits, false);
  assert.equal(only(unreviewed).keyPoints.soundness, 0);
  const rejected = run(addition, reviewV2(unreviewed.queue, (i) => (i.type === 'unit' ? { verdict: 'unsupported', evidence: undefined } : {})));
  assert.equal(rejected.aggregate.verdict, 'fail');
});

// A paraphrase graph: correct edges the frozen predicate list does not name.
const paraphrased = { entities: [{ id: 'a', name: 'Hale Voss' }, { id: 'c', name: 'Marlow' }, { id: 'b', name: 'the Institute' }], relationships: [edge('a', 'established', 'b'), edge('c', 'took over from', 'a'), edge('a', 'worked with', 'c')] };
const missingOut = { ...reference, graph: paraphrased };
const relationItems = (r) => r.queue.items.filter((i) => i.type === 'relation');
const edgeItem = (r, predicate) => r.queue.items.find((i) => i.type === 'edge' && i.predicate === predicate);

test('missing graph relations are queued with candidate edges and evidence, only when there is something that could cover them', () => {
  const r = run(missingOut);
  assert.deepEqual(only(r).details.graph.missing.sort(), ['r-founded', 'r-succeeded']);
  const items = relationItems(r);
  assert.equal(items.length, 2);
  const founded = items.find((i) => i.relation.predicates.includes('founded'));
  assert.equal(founded.relation.source, 'Hale Voss');
  assert.equal(founded.relation.target, 'Tarn Institute');
  assert.deepEqual(founded.relation.evidence, [QUOTE]);
  assert.deepEqual(founded.candidates.map((c) => c.predicate).sort(), ['established', 'took over from']);
  assert.equal(founded.candidates[0].edgeId, r.queue.items.find((i) => i.type === 'edge' && i.predicate === founded.candidates[0].predicate).itemId);
  assert.equal(relationItems(run({ ...reference, graph: { entities: [], relationships: [] } })).length, 0, 'an empty graph has no candidate to review');
  const reversedOnly = run({ ...reference, graph: { entities: reference.graph.entities, relationships: [edge('b', 'founded', 'a')] } });
  assert.equal(relationItems(reversedOnly).length, 0, 'a contradicted edge is never a candidate cover');
});

test('reviewer-covered relations raise recall (never precision) only through a supported covering edge; deterministic recall is kept', () => {
  const first = run(missingOut), covers = (pred) => edgeItem(first, pred).itemId;
  const pick = (i) => (i.type === 'relation' ? { coveredBy: covers(i.relation.predicates.includes('founded') ? 'established' : 'took over from') } : {});
  const r = run(missingOut, reviewV2(first.queue, pick));
  assert.deepEqual(r.review.rejected, []);
  assert.equal(only(first).graph.recall, 1 / 3);
  assert.equal(only(r).graph.recall, 1);
  assert.equal(only(r).graph.precision, 1);
  assert.equal(r.aggregate.graph.pooled.recall, 1);
  assert.equal(r.aggregate.adjudication.relationsReviewedCovered, 2);
  assert.equal(r.deterministic.graph.pooled.recall, 1 / 3);
  assert.equal(r.aggregate.verdict, 'pass');
  assert.equal(r.review.adjudications.filter((a) => a.overrides === 'relation').length, 2);
  const neg = run(missingOut, reviewV2(first.queue, (i) => (i.type === 'relation' ? { verdict: 'not-covered', coveredBy: undefined, evidence: undefined } : {})));
  assert.equal(only(neg).graph.recall, 1 / 3);
  assert.equal(neg.aggregate.verdict, 'pass', 'an explicit not-covered closes the item without credit');
});

test('relation coverage needs an exact, supported, unshared covering edge plus a verbatim source quote', () => {
  const first = run(missingOut);
  const foundedId = relationItems(first).find((i) => i.relation.predicates.includes('founded')).itemId;
  const est = edgeItem(first, 'established').itemId, took = edgeItem(first, 'took over from').itemId;
  const attempt = (patch, edgeVerdicts = {}) => run(missingOut, reviewV2(first.queue, (i) => (i.itemId === foundedId ? { coveredBy: est, ...patch } : i.type === 'edge' && edgeVerdicts[i.itemId] ? { verdict: edgeVerdicts[i.itemId], evidence: undefined } : i.type === 'relation' ? { coveredBy: took } : {})));
  const unchanged = (r) => assert.equal(only(r).graph.recall < 1, true);
  let r = attempt({ coveredBy: undefined }); unchanged(r); assert.ok(reasons(r).includes('bad-covered-by'));
  r = attempt({ coveredBy: 'nonexistent' }); unchanged(r); assert.ok(reasons(r).includes('bad-covered-by'));
  r = attempt({ evidence: undefined }); unchanged(r); assert.ok(reasons(r).includes('missing-evidence'));
  r = attempt({ evidence: ['Hale Voss abolished the Tarn Institute.'] }); unchanged(r); assert.ok(reasons(r).includes('evidence-not-in-source'));
  r = attempt({ itemSha256: undefined }); unchanged(r); assert.ok(reasons(r).includes('missing-binding'));
  r = attempt({}, { [est]: 'unsupported' }); unchanged(r); assert.ok(reasons(r).includes('covering-edge-not-supported'));
  r = attempt({ coveredBy: took }); unchanged(r); assert.ok(reasons(r).includes('edge-already-covers-another-relation'), 'one edge cannot cover two gold relations');
  const stringVerdict = { ...reviewV2(first.queue), items: { ...reviewV2(first.queue).items, [foundedId]: 'covered' } };
  assert.ok(reasons(run(missingOut, stringVerdict)).includes('missing-binding'));
});

test('review reports carry itemised adjudications and rejections; aggregate-only drops them', () => {
  const first = run(flaggedOutput);
  const r = run(flaggedOutput, reviewV2(first.queue, (i) => (i.text === PARAPHRASE ? {} : i.type === 'fact' ? { itemSha256: 'bad' } : {})));
  assert.ok(r.review.rejected.every((x) => typeof x.itemId === 'string' && typeof x.reason === 'string'));
  assert.equal(r.review.ignoredVerdicts, r.review.rejected.length);
  const text = JSON.stringify(aggregateOnly({ ...r, dataset: {}, scorer: {} }));
  assert.ok(!text.includes(PARAPHRASE) && !text.includes('independent-reviewer') && !text.includes(first.queue.items[0].itemId));
  assert.ok(text.includes('"adjudicated"'));
});

test('legacy v1 reviews keep working for units, edges and facts, with the new item types left open', () => {
  const out = { ...flaggedOutput, keyPoints: [...flaggedOutput.keyPoints, 'The Institute runs a telescope.'] };
  const first = run(out);
  const legacy = blind(Object.fromEntries(first.queue.items.filter((i) => i.text !== PARAPHRASE).map((i) => [i.itemId, POSITIVE[i.type]])));
  const r = run(out, legacy);
  assert.equal(r.review.valid, true);
  assert.equal(r.review.ignoredVerdicts, 0);
  assert.equal(r.aggregate.openReviewItems, 1, 'only the flagged unit still needs a v2 verdict');
  assert.equal(r.aggregate.verdict, 'fail');
  assert.equal(r.schema, 'docslurp-extraction-quality-report@v2');
});

// ---- strict review: nothing passes on an automatic match (requireReviewAll) ------------------
const runStrict = (output, review = null, sourceText = SOURCE) => scoreRun({ cases: [{ id: gold.id, gold, sourceText }], outputs: { cases: { [gold.id]: output } }, review, requireReviewAll: true });
const KEYWORD = { 'f-founded': 'founded', 'f-staff': 'employ', 'f-succeeded': 'succeeded', 'f-board': 'board' };
/** Answers every strict item: relations name the edge with their first predicate, facts the unit containing their keyword. */
const strictReview = (queue, pick = () => ({}), header = {}) => reviewV2(queue, (i) => ({
  ...(i.type === 'relation' ? { coveredBy: i.candidates.find((c) => c.predicate === i.relation.predicates[0])?.edgeId } : {}),
  ...(i.type === 'fact' ? { coveredBy: i.candidates.find((c) => c.text.toLowerCase().includes(KEYWORD[i.factId]))?.unitId } : {}),
  ...pick(i),
}), header);
const countBy = (r, type) => r.queue.items.filter((i) => i.type === type).length;
// Every keyword group is present and nothing is negated, yet subject and object are swapped; no authored signature covers it.
const SWAPPED = 'At least 40 researchers employ the Institute.';
const swappedOut = { ...reference, keyPoints: [...reference.keyPoints.filter((k) => !k.includes('employs')), SWAPPED] };

test('strict: a fully matched run queues every unit, fact, edge and relation and passes nothing unreviewed', () => {
  const r = runStrict(reference);
  assert.equal(r.mode, 'strict');
  assert.equal(r.queue.mode, 'strict');
  assert.equal(countBy(r, 'unit'), 4 + 1, 'every key point and the summary, matched or not');
  assert.equal(countBy(r, 'fact'), 4 + 2, 'every expected fact: all key-point facts and the salient summary facts');
  assert.equal(countBy(r, 'edge'), 3);
  assert.equal(countBy(r, 'relation'), 3, 'auto-covered relations are reviewed too');
  assert.equal(r.aggregate.verdict, 'needs-review');
  assert.equal(r.review.completeness.accepted, 0);
  assert.equal(r.review.completeness.open, r.queue.items.length);
  assert.equal(only(r).keyPoints.coverage, 0, 'a term-group match is a diagnostic and earns no coverage');
  assert.equal(only(r).graph.recall, 0);
  assert.equal(only(r).graph.precision, 0);
  assert.equal(r.aggregate.openReviewItems, r.queue.items.length);
  assert.equal(r.deterministic.keyPoints.pooledCoverage, 1, 'automated diagnostics stay beside the reviewed numbers');
  assert.equal(r.deterministic.graph.pooled.recall, 1);
  assert.equal(run(reference, blind({})).aggregate.verdict, 'pass', 'diagnostic mode still passes this run on matching alone');
  assert.ok(r.queue.items.filter((i) => i.type === 'fact').every((i) => i.statement && i.evidence.length && i.candidates.length), 'fact items carry the fact, its evidence and the candidate units');
  assert.ok(runStrict(reference).queue.items.every((i) => /^[0-9a-f]{64}$/u.test(i.itemSha256)));
});

test('strict: a complete, bound, source-quoted independent review passes and fills the reviewed numbers', () => {
  const first = runStrict(reference), r = runStrict(reference, strictReview(first.queue));
  assert.deepEqual(r.review.rejected, []);
  assert.equal(r.review.completeness.open, 0);
  assert.equal(r.review.boundVerdicts, first.queue.items.length);
  assert.equal(r.aggregate.verdict, 'pass');
  assert.equal(only(r).keyPoints.coverage, 1);
  assert.equal(only(r).summary.coverage, 1);
  assert.equal(only(r).keyPoints.soundness, 1);
  assert.equal(only(r).graph.f1, 1);
  assert.equal(r.aggregate.openReviewItems, 0);
  assert.deepEqual(r.review.completeness.byType.fact, { required: 6, accepted: 6 });
});

test('strict: an earlier or partial review does not count while any matched item is unreviewed', () => {
  const first = runStrict(reference);
  for (const type of ['unit', 'fact', 'edge', 'relation']) {
    const left = first.queue.items.find((i) => i.type === type);
    const items = strictReview(first.queue).items;
    delete items[left.itemId];
    const r = runStrict(reference, { ...strictReview(first.queue), items });
    assert.equal(r.aggregate.verdict, 'needs-review', `${type} left unreviewed`);
    assert.ok(r.review.completeness.open >= 1, `${type}: ${r.review.completeness.open} open`);
  }
  const legacy = runStrict(reference, blind(Object.fromEntries(first.queue.items.map((i) => [i.itemId, POSITIVE[i.type]]))));
  assert.equal(legacy.aggregate.verdict, 'needs-review');
  assert.ok(legacy.review.problems.includes('strict-requires-v2-schema'));
  const unbound = runStrict(reference, strictReview(first.queue, () => ({ itemSha256: undefined })));
  assert.equal(unbound.aggregate.verdict, 'needs-review');
  assert.equal(unbound.review.ignoredVerdicts, first.queue.items.length);
  assert.ok(reasons(unbound).every((x) => x === 'missing-binding'));
  assert.equal(runStrict(reference, strictReview(first.queue, undefined, { blind: false })).aggregate.verdict, 'needs-review');
  assert.equal(runStrict(reference, strictReview(first.queue, undefined, { independentOfAuthor: false })).aggregate.verdict, 'needs-review');
});

test('strict: keyword matches with reversed subject and object cannot pass without review, and a reviewer can fail them', () => {
  const diag = run(swappedOut, blind({}));
  assert.equal(unitsOf(diag, 'keyPoints').find((u) => u.text === SWAPPED).status, 'supported', 'the term-group match accepts reversed roles');
  assert.equal(diag.aggregate.verdict, 'pass', 'diagnostic mode would let it through');
  const first = runStrict(swappedOut);
  assert.equal(first.aggregate.verdict, 'needs-review');
  assert.ok(first.queue.items.some((i) => i.type === 'unit' && i.text === SWAPPED));
  const unit = first.queue.items.find((i) => i.type === 'unit' && i.text === SWAPPED);
  const failed = runStrict(swappedOut, strictReview(first.queue, (i) => (i.itemId === unit.itemId ? { verdict: 'unsupported', evidence: undefined } : {})));
  assert.equal(failed.aggregate.verdict, 'fail');
  assert.equal(failed.aggregate.confirmedUnsupported, 1);
  const contradicted = runStrict(swappedOut, strictReview(first.queue, (i) => (i.itemId === unit.itemId ? { verdict: 'contradicted', evidence: undefined } : {})));
  assert.equal(contradicted.aggregate.verdict, 'fail');
  assert.equal(contradicted.aggregate.contradictions, 1);
});

test('strict: supported and covered verdicts need verbatim source evidence on every item type', () => {
  const first = runStrict(reference);
  for (const [name, patch] of [['missing', { evidence: undefined }], ['misquoted', { evidence: ['Hale Voss abolished the Tarn Institute.'] }], ['too short', { evidence: ['Hale Voss'] }]]) {
    const r = runStrict(reference, strictReview(first.queue, () => patch));
    assert.equal(r.aggregate.verdict, 'needs-review', name);
    assert.equal(r.review.ignoredVerdicts, first.queue.items.length, name);
    assert.equal(only(r).keyPoints.coverage, 0, name);
  }
  assert.ok(reasons(runStrict(reference, strictReview(first.queue, () => ({ evidence: undefined })))).every((x) => x === 'missing-evidence'));
  const blindSource = runStrict(reference, null, null), noSource = runStrict(reference, strictReview(blindSource.queue), null);
  assert.ok(reasons(noSource).length > 0 && reasons(noSource).every((x) => x === 'source-unavailable'), 'without the source text nothing can be quoted');
  assert.equal(noSource.aggregate.verdict, 'needs-review');
});

test('strict: a stale hash is rejected when the artifact changes, and a bound verdict cannot be moved to another item', () => {
  const first = runStrict(reference), review = strictReview(first.queue);
  const changed = { ...reference, keyPoints: [...reference.keyPoints.slice(0, 3), 'The board rejected the relocation entirely.'] };
  const r = runStrict(changed, review);
  assert.equal(r.aggregate.verdict, 'needs-review');
  assert.ok(r.review.ignoredVerdicts > 0 && reasons(r).every((x) => ['stale-binding', 'unknown-item'].includes(x)));
  const [a, b] = first.queue.items.filter((i) => i.type === 'edge');
  const swapped = strictReview(first.queue, (i) => (i.itemId === a.itemId ? { itemSha256: b.itemSha256 } : {}));
  assert.ok(reasons(runStrict(reference, swapped)).includes('stale-binding'));
  const otherGraph = { ...reference, graph: { ...reference.graph, relationships: [...reference.graph.relationships, edge('c', 'admires', 'a')] } };
  const foundedEdge = (r) => r.queue.items.find((i) => i.type === 'edge' && i.predicate === 'founded');
  assert.notEqual(foundedEdge(runStrict(otherGraph)).itemSha256, foundedEdge(first).itemSha256, 'edge bindings follow the exact graph');
  assert.notEqual(foundedEdge(runStrict(otherGraph)).itemId, foundedEdge(first).itemId);
});

test('strict: fact coverage names an explicit output unit that the same review judges supported', () => {
  const first = runStrict(reference), staff = first.queue.items.find((i) => i.type === 'fact' && i.factId === 'f-staff');
  const covering = staff.candidates.find((c) => c.text.includes('employs')).unitId;
  const attempt = (patch, units = {}) => runStrict(reference, strictReview(first.queue, (i) => (i.itemId === staff.itemId ? patch : i.type === 'unit' && units[i.itemId] ? { verdict: units[i.itemId], evidence: undefined } : {})));
  let r = attempt({ coveredBy: undefined }); assert.ok(reasons(r).includes('bad-covered-by')); assert.equal(r.aggregate.verdict, 'needs-review');
  r = attempt({ coveredBy: 'nonexistent' }); assert.ok(reasons(r).includes('bad-covered-by'));
  r = attempt({ coveredBy: first.queue.items.find((i) => i.type === 'edge').itemId }); assert.ok(reasons(r).includes('bad-covered-by'), 'an edge cannot cover a prose fact');
  r = attempt({}, { [covering]: 'unsupported' }); assert.ok(reasons(r).includes('covering-unit-not-supported')); assert.equal(r.aggregate.verdict, 'fail', 'the unsupported unit fails the run');
  assert.ok(only(r).keyPoints.coverage < 1);
  r = attempt({ verdict: 'not-covered', coveredBy: undefined, evidence: undefined });
  assert.deepEqual(r.review.rejected, []);
  assert.equal(r.aggregate.verdict, 'pass', 'a bound not-covered closes the item without credit');
  assert.equal(only(r).keyPoints.coverage, 0.75);
  const other = first.queue.items.find((i) => i.type === 'fact' && i.field === 'summary').candidates[0].unitId;
  assert.ok(reasons(attempt({ coveredBy: other })).includes('bad-covered-by'), 'a unit from another artifact is not a candidate');
});

test('strict: graph edges and relations need bound evidence; a covering edge must be supported and covers one relation', () => {
  const first = runStrict(reference);
  const founded = first.queue.items.find((i) => i.type === 'relation' && i.relation.predicates.includes('founded'));
  const edgeOf = (predicate) => founded.candidates.find((c) => c.predicate === predicate).edgeId;
  const attempt = (pick) => runStrict(reference, strictReview(first.queue, pick));
  let r = attempt((i) => (i.itemId === founded.itemId ? { coveredBy: edgeOf('succeeded') } : {}));
  assert.ok(reasons(r).includes('edge-already-covers-another-relation'), 'one edge cannot cover two relations');
  assert.equal(r.aggregate.verdict, 'needs-review');
  r = attempt((i) => (i.itemId === edgeOf('founded') ? { verdict: 'unsupported', evidence: undefined } : {}));
  assert.ok(reasons(r).includes('covering-edge-not-supported'));
  assert.equal(r.aggregate.verdict, 'fail');
  assert.equal(only(r).graph.precision, 2 / 3);
  r = attempt((i) => (i.type === 'edge' && i.predicate === 'worked with' ? { verdict: 'contradicted', evidence: undefined } : {}));
  assert.equal(r.aggregate.verdict, 'fail');
  assert.equal(r.aggregate.graph.contradictedEdges, 1);
  r = attempt((i) => (i.type === 'relation' && i.relation.predicates.includes('worked with') ? { verdict: 'not-covered', coveredBy: undefined, evidence: undefined } : {}));
  assert.equal(only(r).graph.recall, 2 / 3);
  assert.equal(r.aggregate.verdict, 'pass');
  assert.equal(r.aggregate.targets.graphRecall, false, 'targets are still reported separately from the evidence verdict');
});

test('strict: structural graph contradictions and authored signatures still fail and are never queued for review', () => {
  const reversed = runStrict({ ...reference, graph: { ...reference.graph, relationships: [...reference.graph.relationships, edge('b', 'founded', 'a')] } });
  assert.equal(reversed.aggregate.verdict, 'fail');
  assert.equal(countBy(reversed, 'edge'), 3, 'the reversed edge is not offered to a reviewer');
  const authored = runStrict({ ...reference, keyPoints: ['Voss succeeded Marlow as director.'] });
  assert.equal(authored.aggregate.verdict, 'fail');
  assert.ok(!authored.queue.items.some((i) => i.text === 'Voss succeeded Marlow as director.'));
  const reviewed = runStrict({ ...reference, keyPoints: ['Voss succeeded Marlow as director.'] }, strictReview(authored.queue));
  assert.equal(reviewed.aggregate.verdict, 'fail', 'no review can clear it');
});

test('strict: true absence and empty artifacts fail instead of passing an empty review', () => {
  const noGraph = runStrict({ ...reference, graph: { entities: [], relationships: [] } }, strictReview(runStrict({ ...reference, graph: { entities: [], relationships: [] } }).queue));
  assert.equal(countBy(noGraph, 'relation'), 0, 'nothing exists that a reviewer could credit');
  assert.equal(noGraph.aggregate.verdict, 'fail');
  assert.equal(noGraph.aggregate.emptyArtifacts, 1);
  const noPoints = runStrict({ ...reference, keyPoints: [] });
  assert.equal(noPoints.aggregate.verdict, 'fail');
  assert.equal(runStrict({ ...reference, summary: '' }, strictReview(runStrict({ ...reference, summary: '' }).queue)).aggregate.verdict, 'fail');
  assert.equal(runStrict(null).aggregate.verdict, 'fail');
  const control = { ...gold, relations: [], forbiddenRelations: [], facts: [] };
  const empty = scoreRun({ cases: [{ id: gold.id, gold: control, sourceText: SOURCE }], outputs: { cases: { [gold.id]: { graph: { entities: [], relationships: [] }, keyPoints: ['The Institute exists.'], summary: 'The Institute exists.' } } }, requireReviewAll: true });
  assert.equal(empty.aggregate.emptyArtifacts, 0, 'an empty graph is the correct answer for a no-relations control');
});

test('strict: aggregate-only keeps counts and the mode but no case text, and diagnostic mode stays the library default', () => {
  const first = runStrict(reference), r = runStrict(reference, strictReview(first.queue)), text = JSON.stringify(aggregateOnly(r));
  assert.ok(text.includes('"mode":"strict"') && text.includes('"completeness"'));
  assert.ok(!text.includes('synthetic-case-01') && !text.includes('Hale Voss') && !text.includes('"queue"') && !text.includes('"details"'));
  assert.equal(run(reference).mode, 'diagnostic');
  assert.equal(run(reference).queue.mode, 'diagnostic');
});

test('strict: the CLI defaults to strict for promotion; --diagnostic opts out and the flags cannot be combined', () => {
  const dir = tmp(), file = (name, value) => { const path = join(dir, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
  const args = ['--gold', file('gold.json', gold), '--output', file('output.json', reference), '--source', file('source.txt', SOURCE)];
  const cli = (...extra) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./score.mjs', import.meta.url)), ...args, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    assert.equal(cli().mode, 'strict');
    assert.equal(cli('--require-review-all').mode, 'strict');
    assert.equal(cli().aggregate.verdict, 'needs-review');
    assert.equal(cli('--diagnostic').mode, 'diagnostic');
    const queueFile = join(dir, 'queue.json');
    cli('--review-queue', queueFile);
    const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
    assert.equal(queue.mode, 'strict');
    const reviewFile = file('review.json', strictReview(queue));
    assert.equal(cli('--review', reviewFile).aggregate.verdict, 'pass');
    assert.equal(cli('--review', reviewFile, '--aggregate-only').aggregateOnly, true);
    assert.throws(() => cli('--diagnostic', '--require-review-all'), /mutually exclusive/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- builder -------------------------------------------------------------------------
const spec = (split, source = SOURCE, extra = {}) => ({
  schema: 'docslurp-quality-authored@v1', split, author: 'test author', method: 'synthetic fixture', createdAt: '2026-10-16T00:00:00Z', requiredTags: ['alpha'],
  cases: [{
    id: split === 'development' ? 'synthetic-dev-case' : 'working-label', description: 'synthetic', language: 'en', tags: ['alpha'], noRelations: false, source, summaryWordLimit: 60,
    entities: gold.entities, relations: gold.relations, forbiddenRelations: gold.forbiddenRelations, facts: gold.facts,
    oracleChecks: {
      reference,
      defects: [
        { name: 'wrong year', expect: 'contradiction', output: { ...reference, keyPoints: ['Hale Voss founded the Tarn Institute in 1951.'] } },
        { name: 'lost negation', expect: 'contradiction', output: { ...reference, keyPoints: ['The board approved the relocation.'] } },
      ],
    },
    ...extra,
  }],
});
const tmp = () => mkdtempSync(join(tmpdir(), 'quality-builder-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('builder: compiles a frozen, hash-verified dataset and refuses to overwrite it', () => {
  const root = tmp(), dest = join(root, 'version-v1');
  const summary = buildDataset({ development: spec('development'), heldout: spec('heldout') }, dest);
  assert.deepEqual(summary.counts, { development: 1, heldout: 1 });
  const manifest = JSON.parse(readFileSync(join(dest, 'heldout', 'integrity-manifest.json'), 'utf8'));
  const [entry] = manifest.cases;
  assert.match(entry.id, /^ho-[0-9a-f]{12}$/u, 'held-out ids are opaque');
  assert.equal(sha(readFileSync(join(dest, 'heldout', entry.source.path))), entry.source.sha256);
  assert.equal(sha(readFileSync(join(dest, 'heldout', entry.labels.path))), entry.labels.sha256);
  const combined = JSON.parse(readFileSync(join(dest, 'integrity-manifest.json'), 'utf8'));
  assert.equal(combined.cases.length, 2);
  assert.ok(combined.cases.every((c) => c.provenance.kind === 'authored' && c.provenance.author === 'test author'));
  const inputs = JSON.parse(readFileSync(join(dest, 'development', 'runner-inputs.json'), 'utf8'));
  assert.equal(inputs.cases[0].source.pages, 2);
  assert.ok(!JSON.stringify(inputs).includes('relations') && !JSON.stringify(inputs).includes('facts'), 'runner inputs carry no gold');
  assert.equal(statSync(join(dest, 'heldout', entry.source.path)).mode & 0o222, 0, 'files are read-only');
  assert.throws(() => buildDataset({ development: spec('development'), heldout: spec('heldout') }, dest), /immutable/u);
  assert.ok(existsSync(join(dest, 'version.json')) && readdirSync(dest).includes('authored'));
  execFileSync('chmod', ['-R', 'u+w', root]);
  rmSync(root, { recursive: true, force: true });
});

test('builder: rejects evidence that is not in the source, missing tags, and oracles that cannot see their own reference', () => {
  const bad = (development, heldout = spec('heldout')) => () => buildDataset({ development, heldout }, join(tmp(), 'out'));
  const badEvidence = spec('development');
  badEvidence.cases[0].facts = [{ ...gold.facts[0], evidence: [q(1, 'A sentence that is not in the source.')] }, ...gold.facts.slice(1)];
  assert.throws(bad(badEvidence), /evidence quote not found/u);
  assert.throws(bad({ ...spec('development'), requiredTags: ['alpha', 'beta'] }, { ...spec('heldout'), requiredTags: ['alpha', 'beta'] }), /missing required tag beta/u);
  const blindOracle = spec('development');
  blindOracle.cases[0].facts = [{ ...gold.facts[0], variants: [{ groups: ['nothing like it'] }] }, ...gold.facts.slice(1)];
  assert.throws(bad(blindOracle), /rejects its own reference/u);
  const lenient = spec('development');
  lenient.cases[0].oracleChecks.defects = [{ name: 'harmless', expect: 'contradiction', output: reference }];
  assert.throws(bad(lenient), /failed to flag/u);
  const accented = spec('development');
  accented.cases[0].facts = [{ ...gold.facts[0], variants: [{ groups: ['hále'] }] }, ...gold.facts.slice(1)];
  assert.throws(bad(accented), /diacritic-free/u);
  const noSalient = spec('development');
  noSalient.cases[0].facts = gold.facts.map((f) => ({ ...f, salient: false }));
  assert.throws(bad(noSalient), /salient/u);
});
