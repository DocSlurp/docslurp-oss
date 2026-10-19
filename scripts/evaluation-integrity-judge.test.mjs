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
