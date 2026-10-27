#!/usr/bin/env node
/** Deterministic leakage screening; independent from extraction quality scoring.
 * Supported external manifest: integrity-manifest.json, schema docslurp-authored-eval@v1
 * or docslurp-source-derived-eval@v1. Source-derived provenance records question
 * author, derivation time and publisher/HTTPS URL/PDF hash/extraction/page hashes.
 * Each case has id, source:{path,sha256}, labels:{path,sha256}, and
 * provenance:{kind:"authored",author,description,createdAt}. Label files contain
 * {labels:[{name:string,expected:JSON}]}. Optional categoricalFields bind specific
 * expected-value paths to a hash-pinned, baseline Git enum contract; see
 * docs/evaluation-integrity-categorical-contracts.md. Unsupported catalogs fail closed.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Typed category declarations are scoped paths, never global value exemptions.
// JSON Pointer uses an array-only * extension; missing fields fail closed.
function categoricalValues(label, ontology) {
  if (!Object.hasOwn(label, 'categoricalFields')) return strings(label.expected);
  if (!Array.isArray(label.categoricalFields) || !label.categoricalFields.length
      || Object.keys(label).some(key => !['name', 'expected', 'categoricalFields'].includes(key))) throw new Error('invalid-categorical-fields');
  const excluded = new Set();
  for (const field of label.categoricalFields) {
    if (!field || Object.keys(field).some(key => !['pointer', 'ontology'].includes(key))
        || typeof field.pointer !== 'string' || !field.pointer.startsWith('/')
        || /~(?![01])/u.test(field.pointer)) throw new Error('invalid-categorical-fields');
    const parts = field.pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    const values = ontology(field.ontology);
    const visit = (value, depth, path) => {
      if (depth === parts.length) {
        if (typeof value !== 'string' || !values.has(value)) throw new Error('unknown-categorical-value');
        const key = JSON.stringify(path);
        if (excluded.has(key)) throw new Error('overlapping-categorical-fields');
        excluded.add(key); return;
      }
      const part = parts[depth];
      if (part === '*') {
        if (!Array.isArray(value) || !value.length) throw new Error('missing-categorical-field');
        value.forEach((child, index) => visit(child, depth + 1, [...path, String(index)]));
      } else {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new Error('missing-categorical-field');
        visit(value[part], depth + 1, [...path, part]);
      }
    };
    visit(label.expected, 0, []);
  }
  const collect = (value, path) => {
    if (excluded.has(JSON.stringify(path))) return [];
    if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => collect(child, [...path, key]));
    return strings(value);
  };
  return collect(label.expected, []);
}

export function judgeIntegrity({ dataset, repo = process.cwd(), base = 'HEAD' }) {
  const findings = [];
  const add = (rule, detail = {}) => findings.push({ rule, ...detail });
  const result = { schema: 'docslurp-evaluation-integrity@v1', passed: false, datasetHash: null, productionHash: null, gitHead: null, base, scannedFiles: 0, scannedProductionFiles: 0, cases: 0, findings };
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
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    git('rev-parse', '--verify', `${base}^{commit}`);
    const identifiers = new Set(), labelNames = new Set(), expected = new Set(), weakAnswers = new Set(), sourceHashes = new Set();
    const load = (entry) => {
      if (!entry || !nonempty(entry.path) || isAbsolute(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error('missing-artifact-provenance');
      const path = realpathSync(resolve(dataset, entry.path));
      if (!within(dataset, path)) throw new Error('artifact-outside-dataset');
      const bytes = readFileSync(path);
      if (!bytes.length || hash(bytes) !== entry.sha256) throw new Error('artifact-hash-mismatch');
      return bytes;
    };
    const ontologyCache = new Map();
    const ontology = (reference) => {
      if (!reference || Object.keys(reference).some(key => !['path', 'sha256'].includes(key))) throw new Error('invalid-ontology-reference');
      const key = JSON.stringify(reference);
      if (ontologyCache.has(key)) return ontologyCache.get(key);
      const declaration = JSON.parse(load(reference));
      const { contract, values, provenance } = declaration;
      if (declaration.schema !== 'docslurp-categorical-ontology@v1'
          || Object.keys(declaration).some(key => !['schema', 'values', 'contract', 'provenance'].includes(key))
          || !Array.isArray(values) || values.length < 2 || !values.every(nonempty) || new Set(values).size !== values.length
          || !nonempty(provenance?.author) || !nonempty(provenance?.description)
          || !Number.isFinite(Date.parse(provenance?.createdAt))) throw new Error('invalid-ontology-declaration');
      if (!contract || !/^[a-f0-9]{40}$/.test(contract.gitCommit ?? '') || !/^[a-f0-9]{64}$/.test(contract.sha256 ?? '')
          || !/^[A-Za-z_$][\w$]*$/.test(contract.exportName ?? '') || !nonempty(contract.path)
          || isAbsolute(contract.path) || contract.path.split('/').some(part => part === '..' || !part)) throw new Error('invalid-ontology-contract');
      // The reviewer chooses the pre-evaluation baseline. A future or unrelated
      // commit cannot authorize an ontology, and all contract bytes are pinned.
      try { git('merge-base', '--is-ancestor', contract.gitCommit, base); }
      catch { throw new Error('ontology-contract-not-in-baseline'); }
      const content = git('show', `${contract.gitCommit}:${contract.path}`);
      if (hash(content) !== contract.sha256) throw new Error('ontology-contract-hash-mismatch');
      // Deliberately narrow, non-executable contract syntax: exported JSON string
      // array, optionally `as const`. Do not eval arbitrary repository code.
      const escaped = contract.exportName.replace(/[$]/g, '\\$');
      const matches = [...content.matchAll(new RegExp(`export\\s+const\\s+${escaped}\\s*=\\s*(\\[[^;]*?\\])\\s*(?:as\\s+const\\s*)?;`, 'g'))];
      if (matches.length !== 1) throw new Error('unsupported-ontology-contract');
      let declared;
      try { declared = JSON.parse(matches[0][1]); } catch { throw new Error('unsupported-ontology-contract'); }
      if (!Array.isArray(declared) || declared.length !== values.length
          || !declared.every(value => typeof value === 'string' && values.includes(value))
          || new Set(declared).size !== declared.length) throw new Error('ontology-contract-values-mismatch');
      const allowed = new Set(values);
      ontologyCache.set(key, allowed);
      (result.ontologies ??= []).push({ artifactSha256: reference.sha256, contract });
      return allowed;
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
        if (!strings(label.expected).map(value => value.trim()).filter(Boolean).length) throw new Error('missing-expected-values');
        const values = categoricalValues(label, ontology).map(value => value.trim()).filter(Boolean);
        localNames.add(label.name); labelNames.add(label.name);
        for (const value of values) {
          if (distinctiveAnswer(value)) expected.add(value);
          else if (value.length >= 3) weakAnswers.add(value);
        }
      }
      result.cases++;
    }
    result.gitHead = git('rev-parse', 'HEAD').trim();
    const productionDigest = createHash('sha256');
    const files = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort();
    const changed = new Set(git('diff', '--name-only', '-z', base, '--').split('\0'));
    const terms = [...identifiers].map((value) => ({ rule: 'fixture-identifier', value }));
    for (const value of sourceHashes) terms.push({ rule: 'source-recognition-hash', value });
    for (const value of expected) terms.push({ rule: 'labeled-answer', value });
    // Patterns depend only on the frozen manifest, not on the file being scanned.
    // None has g/y flags, so reusing exec/test preserves matching and line numbers.
    const patternCache = new Map();
    const cachedPattern = (value) => {
      if (!patternCache.has(value)) patternCache.set(value, pattern(value));
      return patternCache.get(value);
    };
    const compiledTerms = terms.map((term) => ({
      ...term, expression: /^[0-9.+-]+$/.test(term.value) ? null : cachedPattern(term.value),
      // Numeric literals have no Unicode case folds. Absence is a strict miss;
      // presence still uses the original expression for boundaries and evidence.
      numericLiteral: /^[0-9.+-]+$/.test(term.value),
    }));
    const compiledLabels = [...labelNames].map((value) => ({ value, expression: cachedPattern(value) }));
    const compiledWeakAnswers = [...weakAnswers].map((value) => ({ value, expression: cachedPattern(value) }));
    const seen = new Set();
    const match = (file, text, origin) => {
      for (const { rule, value, expression, numericLiteral } of compiledTerms) {
        if (numericLiteral && !text.includes(value)) continue;
        const found = (expression ?? cachedPattern(value)).exec(text);
        if (!found) continue;
        const key = `${file}:${rule}:${hash(value)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        add(rule, { file, origin, line: text.slice(0, found.index).split('\n').length, evidenceHash: hash(value) });
      }
      const labels = compiledLabels.filter(({ expression }) => expression.test(text)).map(({ value }) => value);
      const weakMatches = labels.length >= 2 ? compiledWeakAnswers.filter(({ expression }) => expression.test(text)).map(({ value }) => value) : [];
      if (weakMatches.length && !seen.has(`${file}:weak-answers`)) {
        seen.add(`${file}:weak-answers`);
        add('answer-label-combination', { file, origin, labelCount: labels.length, answerCount: weakMatches.length, evidenceHash: hash([...labels, ...weakMatches].sort().join('\0')) });
      }
      if (labels.length >= 3 && !seen.has(`${file}:labels`)) {
        seen.add(`${file}:labels`);
        add('benchmark-label-cluster', { file, origin, count: labels.length, evidenceHash: hash(labels.sort().join('\0')) });
      }
    };
    for (const file of files) {
      const path = resolve(repo, file);
      if (!existsSync(path)) continue; // Deleted tracked files are still inspected in the diff.
      const actual = realpathSync(path);
      if (!within(repo, actual)) { add('repository-symlink-escape', { file }); continue; }
      const bytes = readFileSync(actual);
      result.scannedFiles++;
      if (sourceHashes.has(hash(bytes))) add('copied-source-artifact', { file, evidenceHash: hash(bytes) });
      if (!productFile(file)) continue;
      result.scannedProductionFiles++;
      productionDigest.update(file).update('\0').update(hash(bytes)).update('\0');
      if (!bytes.includes(0)) match(file, bytes.toString('utf8'), 'working-tree');
      // Inspect additions only: removed leaked logic must not prevent a clean repair.
      if (!changed.has(file)) continue;
      const diff = git('diff', '--no-ext-diff', '--no-textconv', '--unified=0', base, '--', file);
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
