import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { judgeIntegrity, main } from './evaluation-integrity-judge.mjs';
import { LIMITS, parseContract, projectLabels } from './evaluation-integrity-v2.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
// Only newly invented controls; these tests never open a corpus, PDF or saved report.
const contract = () => ({ schema: 'docslurp-integrity-projection@v2', document: {
  author: 'Sample Draft Team', status: 'Ready For Review', item: 'Larch pump',
  serial: 'VellumRotor-847-TK', equation: { label: '(17)', expression: 'q = m * c' },
  edge: { from: 'cedar', relation: 'supplies', to: 'brass' }, header: 'Release status',
}, fields: [
  { pointer: '/author', role: 'metadata' },
  { pointer: '/status', role: 'answer', match: 'contextual' },
  { pointer: '/item', role: 'content', match: 'contextual' },
  { pointer: '/serial', role: 'answer', match: 'standalone' },
  { pointer: '/equation/label', role: 'content', match: 'contextual' },
  { pointer: '/equation/expression', role: 'answer', match: 'contextual' },
  { pointer: '/edge/from', role: 'content', match: 'contextual' },
  { pointer: '/edge/relation', role: 'answer', match: 'contextual' },
  { pointer: '/edge/to', role: 'content', match: 'contextual' },
  { pointer: '/header', role: 'content', match: 'contextual' },
], units: [
  { kind: 'row', anchor: '/item', values: ['/status'] },
  { kind: 'header-value', header: '/header', value: '/status' },
  { kind: 'equation', label: '/equation/label', expression: '/equation/expression' },
  { kind: 'graph', from: '/edge/from', relation: '/edge/relation', to: '/edge/to' },
] });
function setup(t) {
  const scratchRoot = '/home/dan/tmp/agents'; mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, 'integrity-v2-test.'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'repo'), dataset = join(scratch, 'dataset'); mkdirSync(repo); mkdirSync(dataset);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 'control@example.invalid'); git('config', 'user.name', 'Control');
  writeFileSync(join(repo, 'worker.ts'), 'export const process = input => genericExtract(input);');
  git('add', '.'); git('commit', '-qm', 'invented baseline');
  const source = 'Invented authored source bytes, no customer document.';
  writeFileSync(join(dataset, 'invented-larch-source.txt'), source);
  const manifest = { schema: 'docslurp-authored-eval@v2', cases: [{ id: 'invented-larch-control-821',
    source: { path: 'invented-larch-source.txt', sha256: sha(source) }, labels: { path: 'labels.json', sha256: '' },
    provenance: { kind: 'authored', author: 'Control writer', description: 'Invented control', createdAt: '2026-10-27' },
  }] };
  const f = { repo, dataset, source, git, manifest, contract: contract(),
    saveManifest: () => writeFileSync(join(dataset, 'integrity-manifest.json'), JSON.stringify(manifest)),
    save: () => { const bytes = JSON.stringify(f.contract); writeFileSync(join(dataset, 'labels.json'), bytes); manifest.cases[0].labels.sha256 = sha(bytes); f.saveManifest(); },
    write: text => writeFileSync(join(repo, 'worker.ts'), text),
    run: () => judgeIntegrity({ repo, dataset, version: 'v2' }),
  };
  f.save(); return f;
}
const rules = report => report.findings.map(f => f.rule);

test('v2 generic comments, enums, title-case phrases, metadata and equation counters are observations, not answers', t => {
  const f = setup(t);
  f.write('// Ready For Review is an ordinary workflow state. Sample Draft Team\nconst states = ["Ready For Review", "Pending"];\nconst equationNumber = "(17)";');
  const report = f.run(); assert.equal(report.passed, true, JSON.stringify(report.findings));
  assert.equal(report.projection[0].fields.length, 10);
  assert.equal(report.projection[0].fields.find(f => f.pointer === '/author').role, 'metadata');
  assert.ok(report.observations.some(o => o.reason === 'authoring-metadata'));
  assert.ok(report.observations.some(o => o.reason === 'requires-bounded-context'));
  assert.ok(!JSON.stringify(report).includes('Sample Draft Team'));
  assert.equal(judgeIntegrity({ repo: f.repo, dataset: f.dataset }).passed, false, 'v1 never silently accepts v2');
});
test('standalone distinctive answers, recognition IDs and artifact hashes remain strong', t => {
  for (const [text, rule] of [
    ['// VellumRotor-847-TK', 'labeled-answer'], ['// invented-larch-control-821', 'fixture-identifier'],
    ['// invented-larch-source.txt', 'fixture-identifier'],
  ]) { const f = setup(t); f.write(text); assert.ok(rules(f.run()).includes(rule), text); }
  const f = setup(t);
  for (const digest of [sha(f.source), f.manifest.cases[0].labels.sha256]) {
    f.write(`const recognition = "${digest}";`); assert.ok(rules(f.run()).includes('source-recognition-hash'));
  }
  f.contract.document.recognize = 'indigo-control-72'; f.contract.fields.push({ pointer: '/recognize', role: 'recognition' }); f.save();
  f.write('// indigo-control-72'); assert.ok(rules(f.run()).includes('fixture-identifier'));
});
test('bounded partial rows, header-value, equation and graph associations block with pointer provenance', t => {
  for (const [text, kind] of [
    ['const status = ["Larch pump", "Ready For Review"];', 'row'],
    ['// Release status: Ready For Review', 'header-value'],
    ['// Equation (17): q = m * c', 'equation'],
    ['// cedar supplies brass', 'graph'],
  ]) {
    const f = setup(t); f.write(text); const report = f.run();
    const finding = report.findings.find(f => f.rule === 'contextual-answer' && f.kind === kind);
    assert.ok(finding, JSON.stringify(report.findings));
    assert.ok(finding.observations.every(i => report.observations[i].pointer));
  }
  const f = setup(t); f.contract.document.other = 'Sealed';
  f.contract.fields.push({ pointer: '/other', role: 'answer', match: 'contextual' });
  f.contract.units[0].values.push('/other'); f.save();
  f.write('// Larch pump: Ready For Review');
  assert.ok(rules(f.run()).includes('contextual-answer'), 'one copied cell/identity pair is enough; no complete-row requirement');
});
test('whole-file and distant line cooccurrence cannot satisfy bounded context', t => {
  const f = setup(t);
  for (const text of [
    `// Larch pump ${'.'.repeat(LIMITS.spanChars)} Ready For Review`,
    '// Larch pump\n// unrelated\n// unrelated\n// Ready For Review',
    '// cedar supplies\n' + '// separate code\n'.repeat(8) + '// brass',
  ]) { f.write(text); assert.equal(f.run().passed, true); }
  f.write('// Larch pump\n// Ready For Review'); assert.equal(f.run().passed, false);
});
test('all current files count: comments, Markdown, tests, untracked and committed baseline have no exemption', t => {
  for (const file of ['new-worker.ts', 'notes.md', 'docs/notes.md', '__tests__/control.test.ts']) {
    const f = setup(t); mkdirSync(join(f.repo, 'docs')); mkdirSync(join(f.repo, '__tests__'));
    writeFileSync(join(f.repo, file), '// VellumRotor-847-TK');
    assert.ok(rules(f.run()).includes('labeled-answer'), file);
    f.git('add', '.'); f.git('commit', '-qm', 'invented contamination');
    assert.equal(f.run().passed, false, 'HEAD already contaminated');
    writeFileSync(join(f.repo, file), 'export const fixed = true;');
    assert.equal(f.run().passed, true, 'removed contamination can be repaired');
  }
});
test('byte copies of both source and labels fail even in excluded v1 paths or binary files', t => {
  for (const [artifact, rule] of [['invented-larch-source.txt', 'copied-source-artifact'], ['labels.json', 'copied-label-artifact']]) {
    const f = setup(t); mkdirSync(join(f.repo, 'docs'));
    writeFileSync(join(f.repo, 'docs/copied.bin'), readFileSync(join(f.dataset, artifact)));
    assert.ok(rules(f.run()).includes(rule));
  }
});
test('complete leaf accounting includes escaped pointers, numbers, booleans, null and empty containers', () => {
  const p = contract(); p.document['a/b~c'] = [0, false, null, '', {}, []];
  for (let i = 0; i < 6; i++) p.fields.push({ pointer: `/a~1b~0c/${i}`, role: 'metadata' });
  const projected = projectLabels(p);
  assert.equal(projected.fields.length, 16);
  assert.deepEqual(projected.fields.slice(-6).map(f => f.value), [0, false, null, '', {}, []]);
  assert.ok(projected.members.some(m => m.pointer === '/a~1b~0c' && m.value === 'a/b~c'));
});
test('unsupported, omitted, duplicate, malformed or unclassified projections fail closed', t => {
  const mutations = [
    p => { p.schema = 'unknown'; }, p => { p.extra = 1; }, p => { p.fields.pop(); },
    p => { p.fields.push({ ...p.fields[0] }); }, p => { p.fields[0].pointer = '/absent'; },
    p => { p.fields[0].role = 'ignore'; }, p => { p.fields[0].match = 'standalone'; },
    p => { delete p.fields[1].match; }, p => { p.fields[1].match = 'standalone'; },
    p => { p.units = []; }, p => { p.units[0].kind = 'semantic'; },
    p => { p.units[0].anchor = '/author'; }, p => { p.units[0].values = ['/item']; },
    p => { p.units[0].values = ['/missing']; }, p => { p.units.push({ ...p.units[0] }); },
    p => { p.document.item = 'Review'; }, // substring-equivalent members are ambiguous
    p => { p.fields[0].role = 'recognition'; p.document.author = 'short'; },
  ];
  for (const mutate of mutations) { const f = setup(t); mutate(f.contract); f.save(); assert.equal(f.run().passed, false, mutate.toString()); }
});
test('raw candidate observations are retained when overlapping occurrences are unresolved', t => {
  const f = setup(t); f.contract.document.item = 'ab cd'; f.contract.document.status = 'cd ef'; f.save();
  f.write('// ab cd ef'); const report = f.run();
  assert.ok(rules(report).includes('unresolved-context-ambiguity'));
  assert.ok(report.observations.some(o => o.pointer === '/item'));
  assert.ok(report.observations.some(o => o.pointer === '/status'));
});
test('strict JSON grammar rejects duplicate keys, trailing junk, invalid UTF8 and nesting limits', () => {
  for (const text of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '[1,]', '{"a":1}x', '1e9999', '"\\x"', '[', ' '.repeat(3), '['.repeat(40) + '0' + ']'.repeat(40)]) {
    assert.throws(() => parseContract(Buffer.from(text)), undefined, text);
  }
  assert.throws(() => parseContract(Buffer.from([0xff])));
  assert.throws(() => parseContract(Buffer.alloc(LIMITS.jsonBytes + 1)));
  assert.equal(parseContract(Buffer.from('{"__proto__":1}')).__proto__, 1);
});
test('provenance, hash, path and version errors fail closed', t => {
  for (const mutate of [
    f => { f.manifest.schema = 'docslurp-authored-eval@v1'; },
    f => { delete f.manifest.cases[0].provenance; },
    f => { f.manifest.cases[0].provenance.createdAt = 'bad'; },
    f => { f.manifest.cases[0].source.sha256 = 'bad'; },
    f => { f.manifest.cases[0].labels.path = '../repo/worker.ts'; },
    f => { f.manifest.cases.push({ ...f.manifest.cases[0] }); },
  ]) { const f = setup(t); mutate(f); f.saveManifest(); assert.equal(f.run().passed, false); }
  const f = setup(t); symlinkSync(join(f.repo, 'worker.ts'), join(f.dataset, 'escape'));
  f.manifest.cases[0].source.path = 'escape'; f.saveManifest(); assert.ok(rules(f.run()).includes('artifact-outside-dataset'));
  f.manifest.cases[0].source.path = 'invented-larch-source.txt'; f.saveManifest();
  symlinkSync(join(f.dataset, 'labels.json'), join(f.repo, 'outside')); assert.ok(rules(f.run()).includes('repository-symlink-escape'));
  assert.equal(judgeIntegrity({ repo: f.repo, dataset: f.dataset, version: 'v3' }).passed, false);
});
test('oversized fields, files and artifact inputs stop at documented resource limits', t => {
  const f = setup(t); f.contract.document.author = 'x'.repeat(LIMITS.valueChars + 1); f.save();
  assert.ok(rules(f.run()).includes('resource-limit'));
  f.contract = contract(); f.save();
  truncateSync(join(f.dataset, 'labels.json'), LIMITS.artifactBytes + 1);
  assert.ok(rules(f.run()).includes('resource-limit'));
  f.save(); writeFileSync(join(f.repo, 'large.txt'), ''); truncateSync(join(f.repo, 'large.txt'), LIMITS.artifactBytes + 1);
  assert.ok(rules(f.run()).includes('resource-limit'));
  const p = contract(); p.fields = Array(LIMITS.fields + 1).fill(p.fields[0]);
  assert.throws(() => projectLabels(p), /resource-limit/);
});
test('source-derived v2 retains source/excerpt recognition and strict provenance', t => {
  const f = setup(t); f.manifest.schema = 'docslurp-source-derived-eval@v2';
  f.manifest.cases[0].provenance = { kind: 'source-derived', questionAuthor: 'Invented writer', description: 'Invented derivation', derivedAt: '2026-10-27',
    sources: [{ publisher: 'Invented publisher', sourceUrl: 'https://example.invalid/control', originalPdfSha256: sha('invented original'),
      extractionMethod: 'invented method', pages: [{ page: 1, excerptSha256: sha('invented excerpt') }] }] };
  f.saveManifest(); assert.equal(f.run().passed, true);
  f.write(`// ${sha('invented excerpt')}`); assert.ok(rules(f.run()).includes('source-recognition-hash'));
  f.manifest.cases[0].provenance.sources[0].sourceUrl = 'http://example.invalid/control'; f.saveManifest();
  assert.ok(rules(f.run()).includes('invalid-source-url'));
});
test('v2 CLI is explicitly selected and reports nonzero on contextual contamination', t => {
  const f = setup(t), output = join(f.dataset, 'invented-output.json');
  assert.equal(main(['--version', 'v2', '--repo', f.repo, '--dataset', f.dataset, '--output', output]), 0);
  f.write('// Larch pump Ready For Review');
  assert.equal(main(['--version', 'v2', '--repo', f.repo, '--dataset', f.dataset, '--output', output]), 1);
  assert.equal(JSON.parse(readFileSync(output)).schema, 'docslurp-evaluation-integrity@v2');
});

test('metadata cannot clear manifest recognition findings', t => {
  const f = setup(t);
  f.contract.document.author = f.manifest.cases[0].id; f.save();
  f.write(`// ${f.manifest.cases[0].id}`);
  const report = f.run(); assert.ok(rules(report).includes('fixture-identifier'));
  assert.ok(report.observations.some(o => o.role === 'metadata' && o.reason === 'authoring-metadata'));
  assert.equal(report.projection[0].fields[0].sourcePointer, '/document/author');
});
test('observation and scan-work budgets fail rather than silently truncating evidence', t => {
  const f = setup(t);
  f.write(('Ready For Review\n').repeat(LIMITS.observations + 1));
  assert.ok(rules(f.run()).includes('resource-limit'));
  f.write('export const generic = true;');
  for (let i = 0; i < 800; i++) {
    f.contract.document[`meta${i}`] = `invented-metadata-${i}`;
    f.contract.fields.push({ pointer: `/meta${i}`, role: 'metadata' });
  }
  f.save(); writeFileSync(join(f.repo, 'text.txt'), 'z'.repeat(2 * 1024 * 1024));
  assert.ok(rules(f.run()).includes('resource-limit'));
});
test('dangling untracked symlinks block rather than masquerading as removed files', t => {
  const f = setup(t); symlinkSync(join(f.dataset, 'absent'), join(f.repo, 'dangling'));
  assert.ok(rules(f.run()).includes('repository-symlink-escape'));
});

test('noncanonical or rounded numeric literals fail rather than corrupting projected values', () => {
  for (const value of ['9007199254740993', '0.10000000000000000001', '-0', '1.0', '1e3']) {
    assert.throws(() => parseContract(Buffer.from(value)), /unsupported-json-number/);
  }
  assert.equal(parseContract(Buffer.from('0.125')), 0.125);
});
test('contextual-search budget bounds repeated far-apart candidates', t => {
  const f = setup(t);
  f.write(('Larch pump' + '.'.repeat(LIMITS.spanChars + 1) + 'Ready For Review' + '.'.repeat(LIMITS.spanChars + 1)).repeat(2000));
  assert.ok(rules(f.run()).includes('resource-limit'));
});
test('explicit v1 selection is identical to the default v1 report', t => {
  const f = setup(t); f.manifest.schema = 'docslurp-authored-eval@v1';
  f.contract = { labels: [{ name: 'invented_output', expected: 'Unseen Copper Supplier' }] }; f.save();
  assert.deepEqual(judgeIntegrity({ repo: f.repo, dataset: f.dataset, version: 'v1' }), judgeIntegrity({ repo: f.repo, dataset: f.dataset }));
});


test('NUL-bearing files cannot disable distinctive answer or ID recognition', t => {
  const f = setup(t);
  writeFileSync(join(f.repo, 'payload.bin'), Buffer.concat([Buffer.from([0, 255]), Buffer.from(' VellumRotor-847-TK invented-larch-control-821 ')]));
  const report = f.run();
  assert.ok(rules(report).includes('labeled-answer'));
  assert.ok(rules(report).includes('fixture-identifier'));
  assert.ok(report.observations.some(o => o.decoding === 'utf8-replacement'));
});

// R1 evidence below is copied from the two explicitly authorized, invented-only
// council reviews. No test reads those reports or any external evaluation input.
const methodsR1Projection = (item = 'Birch valve', status = 'Ready For Dispatch') => ({
  schema: 'docslurp-integrity-projection@v2', document: { author: 'Methods Draft Group', item, status },
  fields: [{ pointer: '/author', role: 'metadata' }, { pointer: '/item', role: 'content', match: 'contextual' },
    { pointer: '/status', role: 'answer', match: 'contextual' }],
  units: [{ kind: 'row', anchor: '/item', values: ['/status'] }],
});
const adversarialR1Projection = (item = 'Copper valve', value = 'Ready for shipment') => ({
  schema: 'docslurp-integrity-projection@v2', document: { item, value },
  fields: [{ pointer: '/item', role: 'content', match: 'contextual' }, { pointer: '/value', role: 'answer', match: 'contextual' }],
  units: [{ kind: 'header-value', header: '/item', value: '/value' }],
});

test('R1 P1 exact supplied impossible units refuse before scanning clean or copied text', t => {
  const cases = [
    ['methods single width', methodsR1Projection('Scope', 'calibrated '.repeat(28).trim()), p => 'Scope: ' + p.document.status],
    ['methods combined width', methodsR1Projection('a'.repeat(140), 'b'.repeat(140)), p => p.document.item + ' ' + p.document.status],
    ['methods single lines', methodsR1Projection('Scope', 'first\nsecond\nthird\nfourth'), p => 'Scope: ' + p.document.status],
    ['methods combined lines', methodsR1Projection('first\nsecond', 'third\nfourth\nfifth'), p => p.document.item + ' ' + p.document.status],
    ['adversarial single width', adversarialR1Projection('Copper valve', 'copper '.repeat(45).trim()), p => '// ' + p.document.item + ': ' + p.document.value],
    ['adversarial combined width', adversarialR1Projection('a'.repeat(130), 'b'.repeat(130)), p => '// ' + p.document.item + ' ' + p.document.value],
    ['adversarial single lines', adversarialR1Projection('Copper valve', 'one\ntwo\nthree\nfour'), p => p.document.item + '\n' + p.document.value],
  ];
  for (const [name, projection, copy] of cases) {
    const f = setup(t); f.contract = projection; f.save();
    for (const text of ['export const generic = true;', copy(projection)]) {
      f.write(text); const report = f.run();
      assert.deepEqual(rules(report), ['infeasible-evidence-unit'], name);
      assert.equal(report.scannedFiles, 0, name); assert.equal(report.observations.length, 0, name);
    }
  }
});

test('R1 P1 feasibility includes required boundary separators and UTF16 widths', t => {
  for (const [item, value] of [
    ['a'.repeat(128), 'b'.repeat(128)], // Width 256 still needs a separating code unit.
    ['😀'.repeat(65), 'b'.repeat(130)], // 260 UTF16 units, not 195 code points.
    ['\u0345' + '!'.repeat(126) + '\u0345', '?'.repeat(128)], // /iu requires a gap in either order.
  ]) {
    const f = setup(t); f.contract = adversarialR1Projection(item, value); f.save();
    assert.deepEqual(rules(f.run()), ['infeasible-evidence-unit']);
  }
  for (const [item, value, separator] of [
    ['a'.repeat(128), 'b'.repeat(127), ' '], // Exactly 256 with the necessary gap.
    ['.'.repeat(128), ','.repeat(128), ''], // Nonword boundaries can touch at 256.
    ['?'.repeat(128), '!'.repeat(127) + '\u0345', ''], // Only this ordering fits without a gap.
    ['😀'.repeat(64), 'b'.repeat(127), ' '],
    ['first\nsecond', 'third\nfourth', ' '], // Combined exactly three occupied lines.
    ['Copper valve', 'one\ntwo\nthree\n', ' '], // Terminal LF occupies the preceding line.
    ['first\nsecond', 'third\nfourth\n', ' '],
  ]) {
    const f = setup(t); f.contract = adversarialR1Projection(item, value); f.save();
    assert.equal(f.run().passed, true, JSON.stringify([item, value]));
    f.write(item + separator + value);
    assert.ok(rules(f.run()).includes('contextual-answer'), JSON.stringify([item, value]));
  }
  const f = setup(t);
  f.contract = methodsR1Projection('Scope', 'This sentence contains a deliberately distinctive complete invented semantic answer for review.'); f.save();
  assert.equal(f.run().passed, true);
  f.write('Scope: ' + f.contract.document.status); assert.ok(rules(f.run()).includes('contextual-answer'));
});

test('R1 P1 all unit kinds validate feasibility even when other units already cover their fields', () => {
  const p = adversarialR1Projection('a'.repeat(130), 'b'.repeat(130));
  for (const unit of [
    { kind: 'row', anchor: '/item', values: ['/value'] },
    { kind: 'header-value', header: '/item', value: '/value' },
    { kind: 'equation', label: '/item', expression: '/value' },
  ]) {
    p.units = [unit]; assert.throws(() => projectLabels(p), /infeasible-evidence-unit/);
  }
  const graph = { schema: 'docslurp-integrity-projection@v2', document: { from: 'a'.repeat(90), relation: 'b'.repeat(90), to: 'c'.repeat(90) },
    fields: ['from', 'relation', 'to'].map(key => ({ pointer: '/' + key, role: key === 'relation' ? 'answer' : 'content', match: 'contextual' })),
    units: [{ kind: 'graph', from: '/from', relation: '/relation', to: '/to' }] };
  assert.throws(() => projectLabels(graph), /infeasible-evidence-unit/);
  graph.document = { from: 'first\nsecond', relation: 'third\nfourth', to: 'fifth\nsixth' };
  assert.throws(() => projectLabels(graph), /infeasible-evidence-unit/);
  p.document.extra = 'scope'; p.fields.push({ pointer: '/extra', role: 'content', match: 'contextual' });
  p.units = [{ kind: 'header-value', header: '/extra', value: '/value' }, { kind: 'header-value', header: '/item', value: '/value' }];
  assert.throws(() => projectLabels(p), /infeasible-evidence-unit/, 'one feasible unit cannot excuse an impossible declaration');
});

test('R1 P2 exact go go self-overlaps remain observations near and at the window edge', t => {
  const f = setup(t); f.contract = adversarialR1Projection('go go', 'Ready'); f.save();
  for (const text of ['go go go Ready', 'go go go' + '.'.repeat(246) + 'Ready']) {
    f.write(text); const report = f.run();
    assert.deepEqual(report.observations.filter(o => o.pointer === '/item').map(o => o.offset), [0, 3]);
    assert.ok(rules(report).includes('contextual-answer'));
    if (text.includes('.')) {
      const finding = report.findings.find(f => f.rule === 'contextual-answer');
      assert.equal(report.observations[finding.observations[0]].offset, 3);
    }
  }
  for (const text of ['go go go', 'go go go' + '.'.repeat(247) + 'Ready']) {
    f.write(text); const report = f.run(); assert.equal(report.passed, true);
    assert.deepEqual(report.observations.filter(o => o.pointer === '/item').map(o => o.offset), [0, 3]);
  }
});

test('R1 P2 exact aba aba overlap bypass and shifted positive block; distant counterpart stays observable', t => {
  const f = setup(t); f.contract = methodsR1Projection('aba aba', 'z'); f.save();
  f.write('aba aba aba' + ' '.repeat(245) + 'z');
  const report = f.run();
  assert.deepEqual(report.observations.filter(o => o.pointer === '/item').map(o => o.offset), [0, 4]);
  const finding = report.findings.find(f => f.rule === 'contextual-answer'); assert.ok(finding);
  assert.equal(report.observations[finding.observations[0]].offset, 4);
  assert.equal(report.observations[finding.observations[1]].offset, 256);
  f.write('aba aba' + ' '.repeat(249 - 7) + 'z'); assert.ok(rules(f.run()).includes('contextual-answer'));
  f.write('aba aba aba' + ' '.repeat(249) + 'z');
  const distant = f.run(); assert.equal(distant.passed, true);
  assert.deepEqual(distant.observations.filter(o => o.pointer === '/item').map(o => o.offset), [0, 4]);
});

test('R1 P2 overlapping enumeration respects Unicode starts, literal boundaries and the observation budget', t => {
  const f = setup(t); f.contract = adversarialR1Projection('😀 😀', 'Ready'); f.save();
  f.write('😀 😀 😀 Ready'); const report = f.run();
  assert.ok(rules(report).includes('contextual-answer'));
  assert.deepEqual(report.observations.filter(o => o.pointer === '/item').map(o => o.offset), [0, 3]);
  f.contract = adversarialR1Projection('go go', 'Ready'); f.save();
  f.write('xgo go gox');
  assert.equal(f.run().observations.filter(o => o.pointer === '/item').length, 0);
  f.write('go '.repeat(LIMITS.observations + 2) + 'go'); const limited = f.run();
  assert.ok(rules(limited).includes('resource-limit')); assert.equal(limited.observations.length, LIMITS.observations);
});

function repeatedR1Rows(item = 'Birch valve', secondItem = item, firstStatus = 'Ready For Dispatch') {
  return { schema: 'docslurp-integrity-projection@v2', document: { rows: [{ item, status: firstStatus }, { item: secondItem, status: 'Blocked' }] },
    fields: [0, 1].flatMap(i => [{ pointer: `/rows/${i}/item`, role: 'content', match: 'contextual' }, { pointer: `/rows/${i}/status`, role: 'answer', match: 'contextual' }]),
    units: [0, 1].map(i => ({ kind: 'row', anchor: `/rows/${i}/item`, values: [`/rows/${i}/status`] })) };
}

test('R1 methods P2 indistinguishable row identities fail before clean or contaminated scans', t => {
  for (const p of [repeatedR1Rows(), repeatedR1Rows('Copper valve', 'Copper valve', 'Ready'),
    repeatedR1Rows('Birch valve', 'BIRCH VALVE'), repeatedR1Rows('soup valve', 'ſoup valve')]) {
    const f = setup(t); f.contract = p; f.save();
    for (const text of ['export const generic = true;', p.document.rows[0].item + ': ' + p.document.rows[0].status]) {
      f.write(text); const report = f.run(); assert.deepEqual(rules(report), ['ambiguous-row-identity']);
      assert.equal(report.scannedFiles, 0); assert.equal(report.observations.length, 0);
    }
  }
  for (const p of [repeatedR1Rows('Birch valve east', 'Birch valve west'), repeatedR1Rows('soup valve east', 'ſoup valve west')]) {
    const f = setup(t); f.contract = p; f.save(); assert.equal(f.run().passed, true);
    f.write(p.document.rows[0].item + ': ' + p.document.rows[0].status); assert.ok(rules(f.run()).includes('contextual-answer'));
  }
});

test('R1 methods P2 ambiguity uses the literal matcher Unicode equivalence, not locale lowercasing', t => {
  for (const [item, status] of [['soup', 'ſoup'], ['ſoup', 'soup'], ['Kelp', 'kelp'], ['σoup', 'ςoup']]) {
    const f = setup(t); f.contract = methodsR1Projection(item, status); f.save();
    for (const text of ['export const generic = true;', item]) {
      f.write(text); const report = f.run(); assert.deepEqual(rules(report), ['ambiguous-unit-members']); assert.equal(report.scannedFiles, 0);
    }
  }
  for (const [item, status] of [['soup', 'ſalad'], ['soup.', 'soup?'], ['İoup', 'ioup']]) {
    const f = setup(t); f.contract = methodsR1Projection(item, status); f.save();
    assert.equal(f.run().passed, true);
    f.write(item + ' ' + status); assert.ok(rules(f.run()).includes('contextual-answer'));
  }
  const f = setup(t); f.contract = methodsR1Projection('ſalad', 'ready'); f.save();
  f.write('SALAD: READY'); assert.ok(rules(f.run()).includes('contextual-answer'), 'Unicode literal case folding remains active');
});

test('R1 methods P2 repeated-row validation has a fail-closed comparison budget', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ item: `Unique row ${i}`, status: 'Ready' }));
  const p = { schema: 'docslurp-integrity-projection@v2', document: { rows },
    fields: rows.flatMap((_, i) => [{ pointer: `/rows/${i}/item`, role: 'content', match: 'contextual' }, { pointer: `/rows/${i}/status`, role: 'answer', match: 'contextual' }]),
    units: rows.map((_, i) => ({ kind: 'row', anchor: `/rows/${i}/item`, values: [`/rows/${i}/status`] })) };
  assert.throws(() => projectLabels(p), /resource-limit/);
});
