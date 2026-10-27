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
