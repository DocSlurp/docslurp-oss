#!/usr/bin/env node
/** Deterministic leakage screening; independent from extraction quality scoring.
 * Supported external manifest: integrity-manifest.json, schema docslurp-authored-eval@v1
 * or docslurp-source-derived-eval@v1. Source-derived provenance records question
 * author, derivation time and publisher/HTTPS URL/PDF hash/extraction/page hashes.
 * Each case has id, source:{path,sha256}, labels:{path,sha256}, and
 * provenance:{kind:"authored",author,description,createdAt}. Label files contain
 * {labels:[{name:string,expected:JSON}]}. Unsupported catalogs fail closed.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const within = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const productFile = (path) => !/(^|\/)(docs|research|__tests__|__fixtures__|fixtures|test|tests|gold|goldens)(\/|$)|\.(test|spec)\.[^/]+$|(^|\/)(README|AGENTS|CLAUDE)\.md$/i.test(path);
const strings = (value) => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : typeof value === 'number' ? [String(value)] : [];
const pattern = (term) => new RegExp(`(?<![\\p{L}\\p{N}_])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu');

// A length threshold alone confuses ordinary predicates with held-out answers.
// Require a proper multiword value or an identifier-shaped value for a standalone finding.
function distinctiveAnswer(value) {
  if (value.length < 8) return false;
  return (/\s/u.test(value) && /\p{Lu}/u.test(value))
    || /[\p{L}\p{N}][_.:/@-][\p{L}\p{N}]/u.test(value)
    || /\p{L}.*\p{N}|\p{N}.*\p{L}/u.test(value)
    || /\p{Ll}\p{Lu}/u.test(value)
    || /^\d{8,}$/.test(value);
}

// Only proven executable statements may explain an API-shaped answer match.
// Strings, templates, comments, unsupported languages and parse errors stay strong.
function executableCallOffsets(file, text) {
  const offsets = new Set();
  if (!/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(file)) return offsets;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) return offsets;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length === 0
      && ts.isPropertyAccessExpression(node.expression) && ts.isExpressionStatement(node.parent)) {
      offsets.add(node.getStart(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offsets;
}

export function judgeIntegrity({ dataset, repo = process.cwd(), base = 'HEAD' }) {
  const findings = [];
  const add = (rule, detail = {}) => findings.push({ rule, ...detail });
  const result = { schema: 'docslurp-evaluation-integrity@v1', passed: false, datasetHash: null, productionHash: null, gitHead: null, base, repositories: [], scannedFiles: 0, scannedProductionFiles: 0, cases: 0, findings };
  try {
    repo = realpathSync(repo);
    dataset = realpathSync(dataset);
    if (within(repo, dataset)) throw new Error('dataset-must-be-external');
    if (existsSync(resolve(dataset, 'catalog.json'))) throw new Error('unsupported-catalog-schema');
    const manifestPath = resolve(dataset, 'integrity-manifest.json');
    if (!within(dataset, realpathSync(manifestPath))) throw new Error('manifest-outside-dataset');
    const manifestBytes = readFileSync(manifestPath);
    result.datasetHash = hash(manifestBytes);
    const manifest = JSON.parse(manifestBytes);
    if (!['docslurp-authored-eval@v1', 'docslurp-source-derived-eval@v1'].includes(manifest.schema) || !Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error('unsupported-or-empty-manifest');
    const identifiers = new Set(), labelNames = new Set(), expected = new Set(), weakAnswers = new Set(), sourceHashes = new Set();
    const load = (entry) => {
      if (!entry || !nonempty(entry.path) || isAbsolute(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error('missing-artifact-provenance');
      const path = realpathSync(resolve(dataset, entry.path));
      if (!within(dataset, path)) throw new Error('artifact-outside-dataset');
      const bytes = readFileSync(path);
      if (!bytes.length || hash(bytes) !== entry.sha256) throw new Error('artifact-hash-mismatch');
      return bytes;
    };
    for (const entry of manifest.cases) {
      if (!nonempty(entry.id) || entry.id.length < 12 || identifiers.has(entry.id)) throw new Error('invalid-or-duplicate-case-id');
      const provenance = entry.provenance;
      if (manifest.schema === 'docslurp-authored-eval@v1') {
        if (provenance?.kind !== 'authored' || !nonempty(provenance.author) || !nonempty(provenance.description) || !nonempty(provenance.createdAt) || !Number.isFinite(Date.parse(provenance.createdAt))) throw new Error('missing-authored-provenance');
      } else {
        if (provenance?.kind !== 'source-derived' || !nonempty(provenance.questionAuthor) || !nonempty(provenance.description) || !nonempty(provenance.derivedAt) || !Number.isFinite(Date.parse(provenance.derivedAt)) || !Array.isArray(provenance.sources) || !provenance.sources.length) throw new Error('missing-source-derived-provenance');
        const sourceIdentities = new Set();
        for (const source of provenance.sources) {
          let url;
          try { url = new URL(source.sourceUrl); } catch { throw new Error('invalid-source-url'); }
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid-source-url');
          if (!nonempty(source.publisher) || !nonempty(source.extractionMethod) || !/^[a-f0-9]{64}$/.test(source.originalPdfSha256 ?? '') || !Array.isArray(source.pages) || !source.pages.length) throw new Error('missing-source-derived-provenance');
          if (sourceIdentities.has(source.originalPdfSha256)) throw new Error('duplicate-source-provenance');
          sourceIdentities.add(source.originalPdfSha256);
          const pages = new Set();
          for (const page of source.pages) {
            if (!Number.isSafeInteger(page.page) || page.page < 1 || pages.has(page.page) || !/^[a-f0-9]{64}$/.test(page.excerptSha256 ?? '')) throw new Error('invalid-source-page-provenance');
            pages.add(page.page);
            sourceHashes.add(page.excerptSha256);
          }
          sourceHashes.add(source.originalPdfSha256);
        }
      }
      const source = load(entry.source), labelsBytes = load(entry.labels);
      const labels = JSON.parse(labelsBytes);
      if (!Array.isArray(labels.labels) || !labels.labels.length) throw new Error('missing-labels');
      identifiers.add(entry.id);
      if (nonempty(entry.originalCaseId)) identifiers.add(entry.originalCaseId);
      identifiers.add(entry.source.path);
      identifiers.add(basename(entry.source.path));
      sourceHashes.add(hash(source));
      // Label artifacts also carry answers and must not be copied into product files.
      const localNames = new Set();
      for (const label of labels.labels) {
        if (!nonempty(label.name) || localNames.has(label.name) || !Object.hasOwn(label, 'expected')) throw new Error('missing-or-duplicate-label');
        const values = strings(label.expected).map((value) => value.trim()).filter(Boolean);
        if (!values.length) throw new Error('missing-expected-values');
        localNames.add(label.name); labelNames.add(label.name);
        for (const value of values) {
          if (distinctiveAnswer(value)) expected.add(value);
          else if (value.length >= 3) weakAnswers.add(value);
        }
      }
      result.cases++;
    }
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    git('rev-parse', '--verify', `${base}^{commit}`);
    result.gitHead = git('rev-parse', 'HEAD').trim();
    const productionDigest = createHash('sha256');
    // Gitlinks are coverage boundaries, not ordinary files. Require their exact
    // indexed revision; dirty files are allowed but scanned and hashed below.
    const files = [];
    const visit = (root, prefix, revision, expectedHead) => {
      const run = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (realpathSync(run('rev-parse', '--show-toplevel').trim()) !== root) throw new Error('nested-repository-uninitialized');
      const head = run('rev-parse', 'HEAD').trim();
      if (expectedHead && head !== expectedHead) add('nested-repository-head-mismatch', { file: prefix, expectedHead, head });
      run('rev-parse', '--verify', `${revision}^{commit}`);
      const coverage = { path: prefix || '.', head, base: revision, scannedFiles: 0, dirty: false };
      result.repositories.push(coverage);
      productionDigest.update(JSON.stringify({ path: coverage.path, head, base: revision })).update('\0');
      const entries = new Map();
      for (const entry of run('ls-files', '--stage', '-z').split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t');
        const [mode, oid, stage] = entry.slice(0, tab).split(' ');
        if (stage !== '0') throw new Error('unmerged-repository-index');
        entries.set(entry.slice(tab + 1), { mode, oid });
      }
      for (const [name, entry] of entries) {
        if (entry.mode !== '160000') continue;
        const path = resolve(root, name);
        if (!existsSync(path)) throw new Error('nested-repository-missing');
        if (lstatSync(path).isSymbolicLink() || !within(root, realpathSync(path))) throw new Error('repository-symlink-escape');
        if (!existsSync(resolve(path, '.git'))) throw new Error('nested-repository-uninitialized');
      }
      coverage.dirty = Boolean(run('status', '--porcelain').trim());
      const names = [...new Set([...entries.keys(), ...run('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)])].sort();
      const changed = new Set(run('diff', '--name-only', '-z', revision, '--').split('\0'));
      for (const name of names) {
        const file = prefix + name, path = resolve(root, name), entry = entries.get(name);
        if (entry?.mode === '160000') {
          if (!existsSync(path)) throw new Error('nested-repository-missing');
          if (lstatSync(path).isSymbolicLink() || !within(root, realpathSync(path))) throw new Error('repository-symlink-escape');
          if (!existsSync(resolve(path, '.git'))) throw new Error('nested-repository-uninitialized');
          visit(realpathSync(path), file + '/', entry.oid, entry.oid);
        } else {
          files.push({ file, path, root, name, run, revision, changed: changed.has(name), coverage });
        }
      }
    };
    visit(repo, '', base);
    // Expand aliases explicitly: classify each leaf by its reachable alias path.
    // Walk even ignored targets; never treat Git's inventory as proof of coverage.
    const expanded = [];
    const expand = (item, ancestors = new Set()) => {
      let actual;
      try { actual = realpathSync(item.path); }
      catch (error) {
        if (!existsSync(item.path) && !lstatSync(item.path, { throwIfNoEntry: false })) {
          expanded.push(item); return; // Ordinary tracked deletion.
        }
        throw error;
      }
      if (!within(item.root, actual)) throw new Error('repository-symlink-escape');
      if (!statSync(actual).isDirectory()) { expanded.push(item); return; }
      if (ancestors.has(actual)) throw new Error('repository-directory-symlink-cycle');
      const next = new Set(ancestors).add(actual);
      const children = readdirSync(actual).sort();
      productionDigest.update(JSON.stringify({ alias: item.file, target: relative(item.root, actual), children })).update('\0');
      (item.coverage.directoryAliases ??= []).push({ path: item.file, target: relative(item.root, actual), entries: children.length });
      for (const child of children) {
        if (child === '.git') throw new Error('repository-directory-alias-uncovered-git');
        expand({ ...item, path: resolve(actual, child), file: item.file + '/' + child, name: item.name + '/' + child, changed: false }, next);
      }
    };
    for (const item of files) expand(item);
    files.splice(0, files.length, ...expanded);
    const terms = [...identifiers].map((value) => ({ rule: 'fixture-identifier', value }));
    for (const value of sourceHashes) terms.push({ rule: 'source-recognition-hash', value });
    for (const value of expected) terms.push({ rule: 'labeled-answer', value });
    const seen = new Set();
    const executableAnswers = new Set();
    const match = (file, text, origin) => {
      let callOffsets;
      for (const { rule, value } of terms) {
        const key = `${file}:${rule}:${hash(value)}`;
        if (seen.has(key)) continue;
        let found = pattern(value).exec(text);
        if (!found) continue;
        if (rule === 'labeled-answer' && /^[a-z_$][a-z0-9_$]*\.[a-z_$][a-z0-9_$]*\(\)$/i.test(value)) {
          if (origin === 'working-tree') {
            callOffsets ??= executableCallOffsets(file, text);
            const expression = pattern(value);
            found = [...text.matchAll(new RegExp(expression.source, expression.flags + 'g'))]
              .find((occurrence) => !callOffsets.has(occurrence.index));
            if (!found) { executableAnswers.add(key); continue; }
          } else if (executableAnswers.has(key)) {
            // The complete current file was already checked, including every
            // occurrence. Diff fragments need not form valid standalone code.
            continue;
          }
        }
        seen.add(key);
        add(rule, { file, origin, line: text.slice(0, found.index).split('\n').length, evidenceHash: hash(value) });
      }
      const labels = [...labelNames].filter((value) => pattern(value).test(text));
      const weakMatches = labels.length >= 2 ? [...weakAnswers].filter((value) => pattern(value).test(text)) : [];
      if (weakMatches.length && !seen.has(`${file}:weak-answers`)) {
        seen.add(`${file}:weak-answers`);
        add('answer-label-combination', { file, origin, labelCount: labels.length, answerCount: weakMatches.length, evidenceHash: hash([...labels, ...weakMatches].sort().join('\0')) });
      }
      if (labels.length >= 3 && !seen.has(`${file}:labels`)) {
        seen.add(`${file}:labels`);
        add('benchmark-label-cluster', { file, origin, count: labels.length, evidenceHash: hash(labels.sort().join('\0')) });
      }
    };
    for (const { file, path, root, name, run, revision, changed, coverage } of files) {
      if (!existsSync(path)) continue; // Deleted tracked files are still inspected in the diff.
      const actual = realpathSync(path);
      if (!within(root, actual)) { add('repository-symlink-escape', { file }); continue; }
      const bytes = readFileSync(actual);
      result.scannedFiles++;
      coverage.scannedFiles++;
      if (sourceHashes.has(hash(bytes))) add('copied-source-artifact', { file, evidenceHash: hash(bytes) });
      if (!productFile(name)) continue; // Classify relative to the owning repository.
      result.scannedProductionFiles++;
      productionDigest.update(file).update('\0').update(hash(bytes)).update('\0');
      if (!bytes.includes(0)) match(file, bytes.toString('utf8'), 'working-tree');
      // Inspect additions only: removed leaked logic must not prevent a clean repair.
      if (!changed) continue;
      const diff = run('diff', '--no-ext-diff', '--no-textconv', '--unified=0', revision, '--', name);
      const additions = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1)).join('\n');
      match(file, additions, 'diff-additions');
    }
    result.productionHash = productionDigest.digest('hex');
    if (!result.scannedProductionFiles) throw new Error('no-production-files-scanned');
  } catch (error) {
    // Do not echo dataset content, git stderr, absolute paths or labeled answers.
    const known = /^[a-z][a-z-]+$/.test(error.message ?? '') ? error.message : 'unreadable-or-invalid-input';
    add(known);
  }
  result.passed = findings.length === 0;
  return result;
}

export function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--dataset', '--repo', '--base', '--output'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Expected --dataset <path> [--repo <path>] [--base <commit>] [--output <path>]');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  if (!options.dataset) throw new Error('--dataset is required');
  const report = judgeIntegrity(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) { mkdirSync(dirname(resolve(options.output)), { recursive: true }); writeFileSync(options.output, json); }
  else process.stdout.write(json);
  return report.passed ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
