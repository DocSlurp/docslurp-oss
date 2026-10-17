// Sentinel tests for the extraction-quality scorer and dataset builder.
// Fixtures are synthetic and invented here; no authored dataset content appears in this file.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const run = (output, review = null) => scoreRun({ cases: [{ id: gold.id, gold }], outputs: { cases: { [gold.id]: output } }, review });
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

test('negation: lost or added negation contradicts, bounds like "no more than" are not negation', () => {
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['The board approved the relocation.'] }), 'keyPoints')[0].status, 'contradicted');
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['The board did not reject the relocation.'] }), 'keyPoints')[0].status, 'contradicted');
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['The board declined the relocation.'] }), 'keyPoints')[0].status, 'supported');
  assert.equal(unitsOf(run({ ...reference, keyPoints: ['Hale Voss did not found the Tarn Institute in 1961.'] }), 'keyPoints')[0].status, 'contradicted');
  const bound = { ...gold, facts: [{ id: 'cap', statement: 'The Institute employs no more than 40 researchers.', evidence: [q(1, 'The Institute employs at least 40 researchers.')], salient: true, variants: [{ groups: ['institute', 'employ', 'researchers'] }], numbers: [{ value: 40 }] }] };
  assert.equal(scoreProse(bound, ['The Institute employs no more than 40 researchers.']).units[0].status, 'supported');
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
  assert.deepEqual(Object.keys(item).sort(), ['caseId', 'field', 'itemId', 'text', 'type']);
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
  assert.deepEqual(splitUnits(['- first item', '2) second item']), ['first item', 'second item']);
  assert.deepEqual(tokens('東京は首都'), ['東', '京', 'は', '首', '都'].map((t) => t));
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
