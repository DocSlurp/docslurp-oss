import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { judgeIntegrity, main } from './evaluation-integrity-judge.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'integrity-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), dataset = join(dir, 'dataset');
  mkdirSync(repo); mkdirSync(dataset);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'worker.ts'), 'export const parse = (document, workspaceSchema) => extract(document, workspaceSchema);');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const source = '%PDF-1.7\nSynthetic held-out source bytes\n%%EOF';
  const labels = JSON.stringify({ labels: [{ name: 'invoice_owner', expected: 'Distinctive Example Supplier' }, { name: 'invoice_issuer', expected: 'Unseen Example Issuer' }, { name: 'invoice_recipient', expected: 'Unseen Example Recipient' }] });
  writeFileSync(join(dataset, 'held-out-document.pdf'), source);
  writeFileSync(join(dataset, 'labels.json'), labels);
  const manifest = { schema: 'docslurp-authored-eval@v1', cases: [{ id: 'held-out-fixture-001', source: { path: 'held-out-document.pdf', sha256: sha(source) }, labels: { path: 'labels.json', sha256: sha(labels) }, provenance: { kind: 'authored', author: 'Test author', description: 'Generated test data authored for this regression.', createdAt: '2026-10-17' } }] };
  const save = () => writeFileSync(join(dataset, 'integrity-manifest.json'), JSON.stringify(manifest));
  save();
  return { repo, dataset, source, manifest, save, git, run: () => judgeIntegrity({ repo, dataset }) };
}
const rules = (report) => report.findings.map((finding) => finding.rule);

test('allows generic document logic and runtime workspace schemas without printing answers', (t) => {
  const f = fixture(t), report = f.run();
  assert.equal(report.passed, true); assert.equal(report.cases, 1); assert.equal(report.scannedProductionFiles, 1);
  assert.match(report.productionHash, /^[a-f0-9]{64}$/);
  writeFileSync(join(f.repo, 'worker.ts'), 'export const generic = 2;');
  assert.notEqual(f.run().productionHash, report.productionHash);
  assert.ok(!JSON.stringify(report).includes('Distinctive Example Supplier'));
});
test('detects fixture identifiers, copied answers, clustered labels and source hashes in production full files and edits', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'worker.ts'), `const known = "held-out-fixture-001"; const result = "Distinctive Example Supplier"; const fields = ["invoice_owner", "invoice_issuer", "invoice_recipient"]; const hash = "${sha(f.source)}";`);
  const report = f.run();
  for (const rule of ['fixture-identifier', 'labeled-answer', 'benchmark-label-cluster', 'source-recognition-hash']) assert.ok(rules(report).includes(rule), rule);
  assert.equal(report.passed, false);
  assert.ok(report.findings.every((finding) => !JSON.stringify(finding).includes('Distinctive Example Supplier')));
  f.git('add', '.'); f.git('commit', '-qm', 'contaminated baseline');
  assert.equal(f.run().passed, false, 'full-file scan catches preexisting contamination too');
});
test('excludes textual test gold and docs but never exempts copied source bytes', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repo, 'docs')); mkdirSync(join(f.repo, '__tests__'));
  writeFileSync(join(f.repo, 'docs', 'evidence.md'), 'Distinctive Example Supplier held-out-fixture-001');
  writeFileSync(join(f.repo, '__tests__', 'gold.json'), 'Distinctive Example Supplier');
  assert.equal(f.run().passed, true);
  writeFileSync(join(f.repo, '__tests__', 'copied.pdf'), f.source);
  assert.ok(rules(f.run()).includes('copied-source-artifact'));
});
test('detects untracked production leakage and permits removal of contaminated code', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'new-worker.ts'), '"Distinctive Example Supplier"');
  assert.equal(f.run().passed, false);
  f.git('add', '.'); f.git('commit', '-qm', 'bad code');
  writeFileSync(join(f.repo, 'new-worker.ts'), 'export const generic = true;');
  assert.equal(f.run().passed, true, 'removed leakage should not block a repair');
});
test('fails closed on missing expected labels, provenance, unsupported catalogs and changed artifact hashes', (t) => {
  for (const mutation of [
    (f) => { delete f.manifest.cases[0].provenance; f.save(); },
    (f) => { writeFileSync(join(f.dataset, 'labels.json'), JSON.stringify({ labels: [] })); f.manifest.cases[0].labels.sha256 = sha(readFileSync(join(f.dataset, 'labels.json'))); f.save(); },
    (f) => writeFileSync(join(f.dataset, 'catalog.json'), JSON.stringify({ schema: 'extract-eval-catalog@v1', entries: [] })),
    (f) => writeFileSync(join(f.dataset, 'held-out-document.pdf'), 'tampered'),
  ]) { const f = fixture(t); mutation(f); assert.equal(f.run().passed, false); }
});
test('rejects internal datasets, artifact traversal and symlinks outside dataset', (t) => {
  const f = fixture(t);
  assert.ok(rules(judgeIntegrity({ repo: f.repo, dataset: f.repo })).includes('dataset-must-be-external'));
  f.manifest.cases[0].source.path = '../repo/worker.ts'; f.save();
  assert.ok(rules(f.run()).includes('artifact-outside-dataset'));
  symlinkSync(join(f.repo, 'worker.ts'), join(f.dataset, 'escape.txt'));
  f.manifest.cases[0].source.path = 'escape.txt'; f.save();
  assert.ok(rules(f.run()).includes('artifact-outside-dataset'));
});
test('CLI report returns nonzero on failure and writes a standalone JSON artifact', (t) => {
  const f = fixture(t), output = join(f.dataset, 'report.json');
  assert.equal(main(['--dataset', f.dataset, '--repo', f.repo, '--output', output]), 0);
  assert.equal(JSON.parse(readFileSync(output)).passed, true);
  writeFileSync(join(f.repo, 'worker.ts'), '"held-out-document.pdf"');
  assert.equal(main(['--dataset', f.dataset, '--repo', f.repo, '--output', output]), 1);
  assert.throws(() => main(['--dataset']), /Expected/);
});

test('ordinary single-word answers alone do not implicate unrelated production code, but label combinations do', (t) => {
  const f = fixture(t);
  const labels = JSON.stringify({ labels: [{ name: 'measured_action', expected: 'organizes' }, { name: 'measured_relation', expected: 'connects' }] });
  writeFileSync(join(f.dataset, 'labels.json'), labels);
  f.manifest.cases[0].labels.sha256 = sha(labels); f.save();
  writeFileSync(join(f.repo, 'worker.ts'), '// This module organizes tasks and connects service clients.');
  assert.equal(f.run().passed, true);
  writeFileSync(join(f.repo, 'worker.ts'), 'const output = {measured_action: "organizes", measured_relation: "connects"};');
  assert.ok(rules(f.run()).includes('answer-label-combination'));
});
test('structured identifiers and proper multiword answers remain individual leakage findings', (t) => {
  for (const expected of ['ZX-923841-A', 'UniqueBusinessName', 'Northwind Research Group']) {
    const f = fixture(t), labels = JSON.stringify({ labels: [{ name: 'measured_value', expected }] });
    writeFileSync(join(f.dataset, 'labels.json'), labels);
    f.manifest.cases[0].labels.sha256 = sha(labels); f.save();
    writeFileSync(join(f.repo, 'worker.ts'), `const answer = ${JSON.stringify(expected)};`);
    assert.ok(rules(f.run()).includes('labeled-answer'), expected);
  }
});

test('only executable API call statements explain technical-answer matches', (t) => {
  const f = fixture(t);
  const labels = JSON.stringify({ labels: [{ name: 'document_markdown', expected: 'transport.disconnect()' }] });
  writeFileSync(join(f.dataset, 'labels.json'), labels);
  f.manifest.cases[0].labels.sha256 = sha(labels); f.save();
  writeFileSync(join(f.repo, 'worker.ts'), 'try { run(); } finally { transport.disconnect(); }');
  assert.equal(f.run().passed, true, 'ordinary lifecycle statement, including its diff');
  for (const source of [
    'const answer = "transport.disconnect()";',
    'const document_markdown = "transport.disconnect()";',
    'transport.disconnect(); const answer = "transport.disconnect()";',
    'const answer = `transport.disconnect()`;',
    '// transport.disconnect()',
    'function broken( { transport.disconnect();',
  ]) {
    writeFileSync(join(f.repo, 'worker.ts'), source);
    assert.ok(rules(f.run()).includes('labeled-answer'), source);
  }
  writeFileSync(join(f.repo, 'worker.ts'), 'export const generic = true;');
  writeFileSync(join(f.repo, 'unknown.txt'), 'transport.disconnect();');
  assert.ok(rules(f.run()).includes('labeled-answer'), 'unknown syntax stays strong');
});

function sourceDerivedFixture(t) {
  const f = fixture(t);
  f.manifest.schema = 'docslurp-source-derived-eval@v1';
  f.manifest.cases[0].provenance = {
    kind: 'source-derived', questionAuthor: 'Test question writer',
    description: 'Questions derived from a third-party synthetic source; no claim of source authorship.',
    derivedAt: '2026-10-17', sources: [{
      publisher: 'Synthetic publisher', sourceUrl: 'https://example.invalid/source.pdf',
      originalPdfSha256: sha(f.source), extractionMethod: 'Synthetic text extraction',
      pages: [{ page: 1, excerptSha256: sha('Synthetic excerpt') }],
    }],
  };
  f.save(); return f;
}
test('accepts honest source-derived provenance without changing leakage checks', (t) => {
  const f = sourceDerivedFixture(t);
  assert.equal(f.run().passed, true);
  writeFileSync(join(f.repo, 'worker.ts'), 'const answer = "Distinctive Example Supplier";');
  const report = f.run();
  assert.equal(report.passed, false);
  assert.ok(rules(report).includes('labeled-answer'));
  assert.ok(!JSON.stringify(report).includes('Distinctive Example Supplier'));
});
test('source-derived manifests fail closed on missing provenance, invalid URLs, pages and hashes', (t) => {
  for (const mutation of [
    p => { delete p.questionAuthor; }, p => { delete p.derivedAt; },
    p => { p.kind = 'authored'; }, p => { p.sources = []; },
    p => { p.sources.push({ ...p.sources[0] }); },
    p => { delete p.sources[0].publisher; }, p => { delete p.sources[0].extractionMethod; },
    p => { p.sources[0].sourceUrl = 'http://example.invalid/source.pdf'; },
    p => { p.sources[0].sourceUrl = 'https://name:secret@example.invalid/source.pdf'; },
    p => { p.sources[0].originalPdfSha256 = 'not-a-hash'; },
    p => { p.sources[0].pages = []; },
    p => { p.sources[0].pages[0].page = 0; },
    p => { p.sources[0].pages[0].page = 1.5; },
    p => { p.sources[0].pages.push({ ...p.sources[0].pages[0] }); },
    p => { p.sources[0].pages[0].excerptSha256 = 'bad'; },
  ]) {
    const f = sourceDerivedFixture(t); mutation(f.manifest.cases[0].provenance); f.save();
    assert.equal(f.run().passed, false);
  }
  const f = sourceDerivedFixture(t);
  writeFileSync(join(f.dataset, 'held-out-document.pdf'), 'changed bytes');
  assert.ok(rules(f.run()).includes('artifact-hash-mismatch'));
});
test('source-derived PDF and excerpt recognition hashes remain leakage evidence', (t) => {
  const f = sourceDerivedFixture(t);
  const source = f.manifest.cases[0].provenance.sources[0];
  writeFileSync(join(f.repo, 'worker.ts'), `const known = "${source.originalPdfSha256}"; const excerpt = "${source.pages[0].excerptSha256}";`);
  const report = f.run();
  assert.equal(report.passed, false);
  assert.equal(report.findings.filter(f => f.rule === 'source-recognition-hash').length, 2);
});

test('original case IDs are recognized when source-derived cases receive namespaced IDs', (t) => {
  const f = sourceDerivedFixture(t);
  f.manifest.cases[0].originalCaseId = 'sample-01'; f.save();
  writeFileSync(join(f.repo, 'worker.ts'), 'const known = "sample-01";');
  assert.ok(rules(f.run()).includes('fixture-identifier'));
});

function nestedFixture(t, name = 'core') {
  const f = fixture(t), nested = join(f.repo, name);
  mkdirSync(nested, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', nested, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(nested, 'engine.ts'), 'export const generic = true;');
  git('add', '.'); git('commit', '-qm', 'nested baseline');
  f.git('add', name); f.git('commit', '-qm', 'pin nested repository');
  return { ...f, nested, nestedGit: git };
}
test('scans pinned nested repositories and hashes dirty production content', (t) => {
  const f = nestedFixture(t), initial = f.run();
  assert.equal(initial.passed, true);
  assert.equal(initial.repositories.length, 2);
  assert.equal(initial.scannedProductionFiles, 2);
  writeFileSync(join(f.nested, 'engine.ts'), 'const leaked = "Distinctive Example Supplier";');
  const dirty = f.run();
  assert.ok(dirty.findings.some(x => x.rule === 'labeled-answer' && x.file === 'core/engine.ts'));
  assert.notEqual(dirty.productionHash, initial.productionHash);
  assert.equal(dirty.repositories[1].dirty, true);
  assert.equal(f.run().productionHash, dirty.productionHash);
  f.nestedGit('add', '.'); f.nestedGit('commit', '-qm', 'changed nested head');
  const mismatch = f.run();
  assert.ok(rules(mismatch).includes('nested-repository-head-mismatch'));
  assert.ok(rules(mismatch).includes('labeled-answer'));
});
test('fails closed for absent, uninitialized and escaping nested repositories', (t) => {
  for (const state of ['missing', 'uninitialized', 'escape']) {
    const f = nestedFixture(t);
    rmSync(f.nested, { recursive: true });
    if (state === 'uninitialized') mkdirSync(f.nested);
    if (state === 'escape') symlinkSync(f.dataset, f.nested);
    const report = f.run();
    assert.equal(report.passed, false);
    assert.ok(rules(report).includes(state === 'escape' ? 'repository-symlink-escape' : `nested-repository-${state}`));
  }
});

test('nested production code cannot inherit a parent documentation exclusion', (t) => {
  const f = nestedFixture(t, 'docs/engine');
  writeFileSync(join(f.nested, 'engine.ts'), 'const answer = "Distinctive Example Supplier";');
  const report = f.run();
  assert.equal(report.passed, false);
  assert.equal(report.scannedProductionFiles, 2);
  assert.ok(report.findings.some(x => x.rule === 'labeled-answer' && x.file === 'docs/engine/engine.ts'));
});

test('directory aliases scan ignored and untracked targets, classify aliases and hash deterministically', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repo, 'docs'));
  writeFileSync(join(f.repo, '.gitignore'), 'docs/hidden.ts\n');
  writeFileSync(join(f.repo, 'docs', 'hidden.ts'), 'export const safe = 1;');
  symlinkSync('docs', join(f.repo, 'runtime'));
  f.git('add', '.');
  const first = f.run();
  assert.equal(first.passed, true);
  assert.equal(first.productionHash, f.run().productionHash);
  assert.ok(first.repositories[0].directoryAliases.length);
  writeFileSync(join(f.repo, 'docs', 'hidden.ts'), 'export const safe = 2;');
  assert.notEqual(first.productionHash, f.run().productionHash);
  writeFileSync(join(f.repo, 'docs', 'hidden.ts'), '"Distinctive Example Supplier"');
  assert.ok(f.run().findings.some(x => x.file === 'runtime/hidden.ts' && x.rule === 'labeled-answer'));
  writeFileSync(join(f.repo, 'docs', 'other.ts'), '"Distinctive Example Supplier"');
  assert.ok(f.run().findings.some(x => x.file === 'runtime/other.ts'));
});

test('directory aliases fail closed on cycles, escapes and broken links', (t) => {
  for (const target of ['.', '../dataset', 'missing']) {
    const f = fixture(t);
    symlinkSync(target, join(f.repo, 'alias'));
    f.git('add', '.');
    assert.equal(f.run().passed, false, target);
  }
});


test('quantity prose in proven comments is a candidate, executable dependence still blocks', (t) => {
  const f = fixture(t);
  const expected = '37 millimeters';
  const labels = JSON.stringify({ labels: [{ name: 'measured_span', expected }] });
  writeFileSync(join(f.dataset, 'labels.json'), labels);
  f.manifest.cases[0].labels.sha256 = sha(labels); f.save();
  for (const source of ['// Allow 37 millimeters of clearance.\nexport const size = 37;', 'export const size = 37; /* Allow 37 millimeters. */']) {
    writeFileSync(join(f.repo, 'worker.ts'), source);
    const report = f.run();
    assert.equal(report.passed, false);
    assert.equal(report.status, 'needs-review');
    assert.equal(report.findings.length, 0);
    assert.equal(report.candidates[0].rule, 'comment-quantity-overlap');
    assert.ok(!JSON.stringify(report).includes(expected));
  }
  for (const source of [
    'if (input === "37 millimeters") route();',
    'const prompt = `Return 37 millimeters`;',
    'const prompt = "// 37 millimeters";',
    '// 37 millimeters\nconst answer = "37 millimeters";',
    'function broken( { /* 37 millimeters */',
  ]) {
    writeFileSync(join(f.repo, 'worker.ts'), source);
    assert.ok(rules(f.run()).includes('labeled-answer'), source);
  }
  writeFileSync(join(f.repo, 'worker.ts'), '// Distinctive Example Supplier');
  const original = JSON.stringify({ labels: [{ name: 'owner', expected: 'Distinctive Example Supplier' }] });
  writeFileSync(join(f.dataset, 'labels.json'), original);
  f.manifest.cases[0].labels.sha256 = sha(original); f.save();
  assert.ok(rules(f.run()).includes('labeled-answer'));
});


test('comment classification varies quantities and fails closed outside supported syntax', (t) => {
  for (const expected of ['12 radians', '4.25 centimeters', '800 pixels']) {
    const f = fixture(t);
    const labels = JSON.stringify({ labels: [{ name: 'field_alpha', expected }, { name: 'field_beta', expected: 'ordinary' }] });
    writeFileSync(join(f.dataset, 'labels.json'), labels);
    f.manifest.cases[0].labels.sha256 = sha(labels); f.save();
    writeFileSync(join(f.repo, 'worker.ts'), `/* Generic geometry: ${expected}. */`);
    assert.equal(f.run().status, 'needs-review');
    writeFileSync(join(f.repo, 'unknown.py'), `# ${expected}`);
    assert.ok(rules(f.run()).includes('labeled-answer'));
    rmSync(join(f.repo, 'unknown.py'));
    writeFileSync(join(f.repo, 'worker.ts'), `/* ${expected}; field_alpha field_beta ordinary */`);
    assert.ok(rules(f.run()).includes('answer-label-combination'));
    writeFileSync(join(f.repo, 'worker.ts'), `/* ${expected}; held-out-fixture-001 */`);
    assert.ok(rules(f.run()).includes('fixture-identifier'));
    writeFileSync(join(f.repo, 'worker.ts'), `const prompt = \`/* ${expected} */\`;`);
    assert.ok(rules(f.run()).includes('labeled-answer'));
  }
});

test('literal ranges cannot masquerade as comments in staged or untracked TSX', (t) => {
  for (const staged of [false, true]) for (const expected of ['37 millimeters', '62 hectares']) {
    const f = fixture(t);
    const labels = JSON.stringify({ labels: [{ name: 'synthetic_extent', expected }] });
    writeFileSync(join(f.dataset, 'labels.json'), labels);
    f.manifest.cases[0].labels.sha256 = sha(labels); f.save();
    writeFileSync(join(f.repo, 'view.tsx'), `export const x = <div>// ${expected}</div>;`);
    if (staged) f.git('add', 'view.tsx');
    const report = f.run();
    assert.equal(report.passed, false);
    assert.ok(rules(report).includes('labeled-answer'));
    assert.equal(report.candidates.length, 0);
  }
});

test('comments block promotion including toString and self-source consumption', (t) => {
  for (const source of [
    "function answer(){ //62 hectares\n return 0;} export const prompt=answer.toString().split('//')[1].split('\\n')[0];",
    "import {readFileSync} from 'node:fs'; //62 hectares\nexport const prompt = readFileSync(import.meta.filename, 'utf8');",
    "//62 hectares\nexport const size = 62;",
  ]) {
    const f = fixture(t);
    const labels = JSON.stringify({ labels: [{ name: 'synthetic_extent', expected: '62 hectares' }] });
    writeFileSync(join(f.dataset, 'labels.json'), labels);
    f.manifest.cases[0].labels.sha256 = sha(labels); f.save();
    writeFileSync(join(f.repo, 'worker.ts'), source);
    const report = f.run();
    assert.equal(report.passed, false);
    assert.equal(report.status, 'needs-review');
    assert.equal(report.findings.length, 0);
    assert.ok(report.candidates.length);
    const output = join(f.dataset, 'report.json');
    assert.equal(main(['--dataset', f.dataset, '--repo', f.repo, '--output', output]), 1);
  }
});


test('empty-body comments remain unresolved candidates', (t) => {
  const f = fixture(t);
  const labels = JSON.stringify({ labels: [{ name: 'span', expected: '93 furlongs' }] });
  writeFileSync(join(f.dataset, 'labels.json'), labels);
  f.manifest.cases[0].labels.sha256 = sha(labels); f.save();
  writeFileSync(join(f.repo, 'worker.ts'), 'function a(){/*93 furlongs*/} export const prompt=a.toString();');
  const report = f.run();
  assert.equal(report.passed, false);
  assert.equal(report.status, 'needs-review');
  assert.ok(report.candidates.length > 0);
});


test('blocks index-only leakage while allowing matching staged changes', (t) => {
  for (const fresh of [false, true]) {
    const f = fixture(t), name = fresh ? 'new-worker.ts' : 'worker.ts';
    writeFileSync(join(f.repo, name), 'export const prompt = "Distinctive Example Supplier";');
    f.git('add', name);
    writeFileSync(join(f.repo, name), 'export const generic = true;');
    assert.ok(rules(f.run()).includes('index-working-tree-mismatch'));
    rmSync(join(f.repo, name));
    assert.ok(rules(f.run()).includes('index-working-tree-mismatch'));
    writeFileSync(join(f.repo, name), 'export const generic = true;');
    f.git('add', name);
    assert.equal(f.run().passed, true);
  }
});

test('blocks partially staged nested repository paths', (t) => {
  const f = nestedFixture(t);
  writeFileSync(join(f.nested, 'engine.ts'), '"Distinctive Example Supplier"');
  f.nestedGit('add', 'engine.ts');
  writeFileSync(join(f.nested, 'engine.ts'), 'export const generic = true;');
  assert.ok(f.run().findings.some(x => x.rule === 'index-working-tree-mismatch' && x.file === 'core/engine.ts'));
});


test('index flags cannot hide staged prompts behind comment candidates', (t) => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const f = fixture(t);
    const labels = JSON.stringify({ labels: [{ name: 'area', expected: '71 hectares' }] });
    writeFileSync(join(f.dataset, 'labels.json'), labels);
    f.manifest.cases[0].labels.sha256 = sha(labels); f.save();
    writeFileSync(join(f.repo, 'worker.ts'), 'export const prompt="71 hectares";');
    f.git('add', 'worker.ts'); f.git('update-index', flag, 'worker.ts');
    writeFileSync(join(f.repo, 'worker.ts'), '//71 hectares\nexport const safe=1;');
    const report = f.run();
    assert.equal(report.passed, false);
    assert.equal(report.status, 'blocked');
    assert.ok(rules(report).includes('unverified-index-flags'));
  }
});

test('operator adjudication binds the entire scan and never waives findings', (t) => {
  const f = fixture(t);
  const labels = JSON.stringify({ labels: [{ name: 'span', expected: '37 millimeters' }] });
  writeFileSync(join(f.dataset, 'labels.json'), labels);
  f.manifest.cases[0].labels.sha256 = sha(labels); f.save();
  const source = '// clearance 37 millimeters\nexport const size = 37;';
  writeFileSync(join(f.repo, 'worker.ts'), source);
  const reviewContext = 'synthetic-review-001';
  const initial = judgeIntegrity({ repo: f.repo, dataset: f.dataset, reviewContext });
  assert.equal(initial.status, 'needs-review');
  const record = { schema: 'docslurp-integrity-adjudication@v1', datasetHash: initial.datasetHash,
    productionHash: initial.productionHash, candidateSetHash: initial.candidateSetHash, reviewContext,
    reviewer: { identity: 'synthetic-independent-reviewer', independent: true, provenance: 'Separate synthetic test review session' },
    decisions: initial.candidates.map((candidate) => ({ candidate, decision: 'accept', reason: 'Synthetic generic clearance comment', reviewedAt: '2026-01-01T00:00:00.000Z' })) };
  const adjudication = join(f.dataset, 'review.json');
  const run = (value = record, context = reviewContext) => {
    writeFileSync(adjudication, JSON.stringify(value));
    return judgeIntegrity({ repo: f.repo, dataset: f.dataset, adjudication, reviewContext: context });
  };
  assert.equal(run().passed, true);
  assert.ok(!JSON.stringify(run()).includes('Synthetic generic clearance'));
  for (const mutate of [
    (r) => { r.datasetHash = '0'.repeat(64); }, (r) => { r.productionHash = '0'.repeat(64); },
    (r) => { r.candidateSetHash = '0'.repeat(64); }, (r) => { r.decisions = []; },
    (r) => { r.decisions.push(r.decisions[0]); }, (r) => { r.extra = true; },
    (r) => { r.reviewer.independent = false; }, (r) => { delete r.reviewer.provenance; },
    (r) => { r.decisions[0].decision = 'reject'; }, (r) => { r.decisions[0].decision = 'maybe'; },
    (r) => { r.decisions[0].reason = ''; }, (r) => { r.decisions[0].reviewedAt = 'tomorrow'; },
    ...['file', 'line', 'origin', 'evidenceHash', 'candidateId', 'rule'].map((key) => (r) => { r.decisions[0].candidate[key] = 'changed'; }),
  ]) {
    const changed = structuredClone(record); mutate(changed); assert.equal(run(changed).passed, false);
  }
  assert.equal(run(record, 'another-review').passed, false, 'cross-context replay');
  assert.equal(run(record, '').passed, false);
  writeFileSync(join(f.repo, 'worker.ts'), source + '\nexport const other = 1;');
  assert.equal(run().passed, false, 'changed production');
  writeFileSync(join(f.repo, 'worker.ts'), source + '\n// clearance 37 millimeters');
  assert.equal(run().passed, false, 'changed candidate set');
  writeFileSync(join(f.repo, 'worker.ts'), source);
  f.manifest.cases[0].provenance.description = 'Changed synthetic dataset'; f.save();
  assert.equal(run().passed, false, 'changed dataset');
  writeFileSync(join(f.repo, 'worker.ts'), source + '\nconst leaked = "held-out-fixture-001";');
  const blocked = judgeIntegrity({ repo: f.repo, dataset: f.dataset, reviewContext });
  const updated = { ...record, datasetHash: blocked.datasetHash, productionHash: blocked.productionHash,
    candidateSetHash: blocked.candidateSetHash, decisions: blocked.candidates.map((candidate) => ({ ...record.decisions[0], candidate })) };
  assert.equal(run(updated).passed, false, 'fresh valid candidate acceptance cannot waive finding');
  assert.ok(rules(run(updated)).includes('fixture-identifier'));
  writeFileSync(adjudication, '{');
  assert.equal(judgeIntegrity({ repo: f.repo, dataset: f.dataset, adjudication, reviewContext }).passed, false);
  assert.throws(() => main(['--dataset', f.dataset, '--dataset', f.dataset]));
  assert.throws(() => main(['--dataset', f.dataset, '--unknown', 'value']));
});
