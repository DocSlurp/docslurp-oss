/** V2 is an authored, literal projection contract, not a semantic/NLP classifier.
 * These artifacts are trusted evaluation authoring inputs, never customer bytes.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export const LIMITS = Object.freeze({ jsonBytes: 2 * 1024 * 1024, artifactBytes: 16 * 1024 * 1024,
  repoBytes: 128 * 1024 * 1024, files: 20000, cases: 200, fields: 5000, units: 10000,
  depth: 32, nodes: 50000, valueChars: 2048, observations: 50000, scanWork: 2_000_000_000,
  spanChars: 256, spanLines: 3, contextWork: 2_000_000 });
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = reason => { throw new Error(reason); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const assertLiteralTarget = value => {
  // UTF-8 decoding cannot emit isolated UTF-16 surrogates. Refuse an
  // unobservable target; never repair it into a different declared literal.
  if (!value.isWellFormed()) fail('ill-formed-unicode-target');
};
const within = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
const exact = (object, keys, optional = []) => {
  if (!object || Array.isArray(object) || typeof object !== 'object'
    || keys.some(key => !Object.hasOwn(object, key))
    || Object.keys(object).some(key => !keys.includes(key) && !optional.includes(key))) fail('unsupported-contract');
};
const list = (value, max, empty = false) => {
  if (!Array.isArray(value) || (!empty && !value.length)) fail('unsupported-contract');
  if (value.length > max) fail('resource-limit');
};
const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');
const pointerPart = value => value.replace(/~/g, '~0').replace(/\//g, '~1');
const literalSource = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = value => new RegExp(`(?<![\\p{L}\\p{N}_])${literalSource(value)}(?![\\p{L}\\p{N}_])`, 'giu');

// At most three members: enumerate the <=6 literal layouts, including the
// separators required by the same word boundaries used during scanning. This
// proves only a representable literal window, never a semantic association.
function feasibleUnit(texts) {
  const width = texts.reduce((sum, text) => sum + text.length, 0);
  if (width > LIMITS.spanChars) return false;
  const newlines = texts.reduce((sum, text) => sum + text.split('\n').length - 1, 0);
  const fits = (order, remaining) => {
    if (remaining.length) return remaining.some((text, i) => fits([...order, text], remaining.filter((_, j) => i !== j)));
    const separators = order.slice(1).reduce((sum, text, i) => sum
      + Number(/[\p{L}\p{N}_]$/iu.test(order[i]) || /^[\p{L}\p{N}_]/iu.test(text)), 0);
    // The runtime counts lines through the last included code unit (end - 1).
    // A final LF therefore does not add another occupied physical line.
    const lines = newlines + 1 - Number(order.at(-1).endsWith('\n'));
    return width + separators <= LIMITS.spanChars && lines <= LIMITS.spanLines;
  };
  return fits([], texts);
}

// JSON.parse alone discards duplicate keys. Parse with a bounded grammar first;
// duplicate, oversized and deeply nested contracts must not lose provenance.
export function parseContract(bytes) {
  if (bytes.length > LIMITS.jsonBytes) fail('resource-limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let i = 0, nodes = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      const char = text[i++];
      if (char === '\\') { i++; continue; }
      if (char === '"') return JSON.parse(text.slice(start, i));
    }
    fail('invalid-json');
  };
  const value = depth => {
    if (depth > LIMITS.depth || ++nodes > LIMITS.nodes) fail('resource-limit');
    ws();
    if (text[i] === '"') return string();
    if (text[i] === '{' || text[i] === '[') {
      const object = text[i++] === '{', end = object ? '}' : ']';
      const out = object ? Object.create(null) : [], keys = new Set();
      ws(); if (text[i] === end) { i++; return out; }
      while (i < text.length) {
        ws(); let key;
        if (object) {
          if (text[i] !== '"') fail('invalid-json');
          key = string(); if (keys.has(key)) fail('duplicate-json-key'); keys.add(key);
          ws(); if (text[i++] !== ':') fail('invalid-json');
        }
        const child = value(depth + 1);
        if (object) out[key] = child; else out.push(child);
        ws(); if (text[i] === end) { i++; return out; }
        if (text[i++] !== ',') fail('invalid-json');
      }
      fail('invalid-json');
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!token) fail('invalid-json');
    i += token[0].length;
    const out = JSON.parse(token[0]);
    if (typeof out === 'number') {
      if (!Number.isFinite(out)) fail('invalid-json');
      if ((Number.isInteger(out) && !Number.isSafeInteger(out)) || JSON.stringify(out) !== token[0]) fail('unsupported-json-number');
    }
    return out;
  };
  const out = value(0); ws(); if (i !== text.length) fail('invalid-json'); return out;
}

// Standalone eligibility is mechanical, NOT a uniqueness claim. Short ordinary
// phrases (whatever their capitalization) must use authored contextual units.
export function standaloneEligible(value) {
  return value.length >= 8 && (
    /[\p{L}\p{N}][_.:/@-][\p{L}\p{N}]/u.test(value)
    || /\p{L}.*\p{N}|\p{N}.*\p{L}/u.test(value)
    || /\p{Ll}\p{Lu}/u.test(value)
    || /^\d{8,}$/.test(value)
    || (value.length >= 48 && value.split(/\s+/u).length >= 8));
}

export function projectLabels(contract) {
  exact(contract, ['schema', 'document', 'fields', 'units']);
  if (contract.schema !== 'docslurp-integrity-projection@v2') fail('unsupported-projection');
  list(contract.fields, LIMITS.fields); list(contract.units, LIMITS.units, true);
  const leaves = new Map(), members = [];
  const visit = (value, pointer = '', depth = 0) => {
    if (depth > LIMITS.depth || leaves.size + members.length > LIMITS.nodes) fail('resource-limit');
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value);
      // Empty containers are accounted for as leaves; they have no literal target.
      if (!entries.length) leaves.set(pointer, { pointer, value, text: '' });
      for (const [key, child] of entries) {
        const childPointer = `${pointer}/${pointerPart(key)}`;
        if (!Array.isArray(value)) members.push({ pointer: childPointer, value: key });
        visit(child, childPointer, depth + 1);
      }
    } else {
      const text = value === null ? 'null' : String(value);
      if (text.length > LIMITS.valueChars) fail('resource-limit');
      leaves.set(pointer, { pointer, value, text });
    }
  };
  visit(contract.document);
  const fields = new Map();
  for (const field of contract.fields) {
    exact(field, ['pointer', 'role'], ['match']);
    if (typeof field.pointer !== 'string' || !leaves.has(field.pointer) || fields.has(field.pointer)) fail('invalid-field-provenance');
    if (!['content', 'answer', 'metadata', 'recognition'].includes(field.role)) fail('unclassified-role');
    const leaf = leaves.get(field.pointer);
    if (field.role !== 'metadata') assertLiteralTarget(leaf.text);
    if (['content', 'answer'].includes(field.role)) {
      if (!['standalone', 'contextual'].includes(field.match) || !leaf.text.trim()) fail('unclassified-evidence');
      if (field.match === 'standalone' && !standaloneEligible(leaf.text)) fail('unsupported-standalone-target');
    } else if (Object.hasOwn(field, 'match')) fail('unsupported-contract');
    if (field.role === 'recognition' && (!leaf.text.trim() || leaf.text.length < 8)) fail('invalid-recognition-target');
    fields.set(field.pointer, { ...leaf, ...field });
  }
  if (fields.size !== leaves.size) fail('incomplete-field-accounting');
  if (![...fields.values()].some(field => field.role === 'answer')) fail('missing-answer-target');
  const units = [], covered = new Set(), signatures = new Set(), rowAnchors = new Map();
  let validationWork = 0;
  const equivalent = (left, right, whole = false) => {
    validationWork += left.length + right.length;
    if (validationWork > LIMITS.contextWork) fail('resource-limit');
    // Use /iu literal equivalence, exactly as the scanner does, without its
    // boundaries for conservative substring rejection. Locale lowercasing is
    // not equivalent (e.g. long s and ASCII s). Whole matches identify rows.
    const source = whole ? `^(?:${literalSource(left)})(?![\\s\\S])` : literalSource(left);
    return new RegExp(source, 'iu').test(right);
  };
  const add = (kind, pointers) => {
    if (new Set(pointers).size !== pointers.length || pointers.some(p => !fields.has(p))) fail('invalid-unit-provenance');
    const parts = pointers.map(p => fields.get(p));
    if (parts.some(p => !['content', 'answer'].includes(p.role)) || !parts.some(p => p.role === 'answer')) fail('invalid-unit-roles');
    // Repeated or substring-equivalent members cannot prove an association.
    const texts = parts.map(p => p.text);
    if (texts.some((text, i) => texts.some((other, j) => i !== j && equivalent(text, other)))) fail('ambiguous-unit-members');
    if (!feasibleUnit(texts)) fail('infeasible-evidence-unit');
    const signature = JSON.stringify([kind, ...pointers]);
    if (signatures.has(signature)) fail('duplicate-evidence-unit');
    signatures.add(signature); pointers.forEach(p => covered.add(p));
    units.push({ kind, pointers });
    if (units.length > LIMITS.units) fail('resource-limit');
  };
  for (const unit of contract.units) {
    switch (unit.kind) {
      case 'row':
        exact(unit, ['kind', 'anchor', 'values']); list(unit.values, 16);
        if (!fields.has(unit.anchor)) fail('invalid-unit-provenance');
        if (!rowAnchors.has(unit.anchor)) {
          const text = fields.get(unit.anchor).text;
          if ([...rowAnchors.values()].some(other => equivalent(text, other, true))) fail('ambiguous-row-identity');
          rowAnchors.set(unit.anchor, text);
        }
        for (const pointer of unit.values) add('row', [unit.anchor, pointer]);
        break;
      case 'header-value':
        exact(unit, ['kind', 'header', 'value']); add(unit.kind, [unit.header, unit.value]); break;
      case 'equation':
        exact(unit, ['kind', 'label', 'expression']); add(unit.kind, [unit.label, unit.expression]); break;
      case 'graph':
        exact(unit, ['kind', 'from', 'relation', 'to']); add(unit.kind, [unit.from, unit.relation, unit.to]); break;
      default: fail('unsupported-evidence-unit');
    }
  }
  for (const field of fields.values()) if (field.match === 'contextual' && !covered.has(field.pointer)) fail('uncovered-contextual-field');
  return { fields: [...fields.values()], members, units };
}

function validateProvenance(manifest, entry) {
  const provenance = entry.provenance, hashes = [];
  const date = value => nonempty(value) && Number.isFinite(Date.parse(value));
  if (manifest.schema === 'docslurp-authored-eval@v2') {
    exact(provenance, ['kind', 'author', 'description', 'createdAt']);
    if (provenance.kind !== 'authored' || !nonempty(provenance.author) || !nonempty(provenance.description) || !date(provenance.createdAt)) fail('missing-authored-provenance');
  } else {
    exact(provenance, ['kind', 'questionAuthor', 'description', 'derivedAt', 'sources']);
    if (provenance.kind !== 'source-derived' || !nonempty(provenance.questionAuthor) || !nonempty(provenance.description) || !date(provenance.derivedAt)) fail('missing-source-derived-provenance');
    list(provenance.sources, LIMITS.cases);
    const identities = new Set();
    for (const source of provenance.sources) {
      exact(source, ['publisher', 'sourceUrl', 'originalPdfSha256', 'extractionMethod', 'pages']);
      let url; try { url = new URL(source.sourceUrl); } catch { fail('invalid-source-url'); }
      if (url.protocol !== 'https:' || url.username || url.password) fail('invalid-source-url');
      if (!nonempty(source.publisher) || !nonempty(source.extractionMethod) || !digest(source.originalPdfSha256) || identities.has(source.originalPdfSha256)) fail('missing-source-derived-provenance');
      identities.add(source.originalPdfSha256); hashes.push(source.originalPdfSha256);
      list(source.pages, LIMITS.fields); const pages = new Set();
      for (const page of source.pages) {
        exact(page, ['page', 'excerptSha256']);
        if (!Number.isSafeInteger(page.page) || page.page < 1 || pages.has(page.page) || !digest(page.excerptSha256)) fail('invalid-source-page-provenance');
        pages.add(page.page); hashes.push(page.excerptSha256);
      }
    }
  }
  return hashes;
}

export function judgeIntegrityV2({ dataset, repo = process.cwd(), base = 'HEAD' }) {
  const report = { schema: 'docslurp-evaluation-integrity@v2', passed: false, datasetHash: null,
    productionHash: null, gitHead: null, base, scannedFiles: 0, scannedProductionFiles: 0,
    cases: 0, limits: LIMITS, projection: [], observations: [], findings: [] };
  const add = (rule, detail = {}) => report.findings.push({ rule, ...detail });
  const observation = value => {
    if (report.observations.length >= LIMITS.observations) fail('resource-limit');
    report.observations.push(value);
    return report.observations.length - 1;
  };
  try {
    repo = realpathSync(repo); dataset = realpathSync(dataset);
    if (within(repo, dataset)) fail('dataset-must-be-external');
    if (existsSync(resolve(dataset, 'catalog.json'))) fail('unsupported-catalog-schema');
    const read = (path, limit) => {
      const stat = statSync(path);
      if (!stat.isFile()) fail('unsupported-artifact-type');
      if (stat.size > limit) fail('resource-limit');
      const bytes = readFileSync(path);
      if (bytes.length > limit) fail('resource-limit');
      return bytes;
    };
    const manifestPath = realpathSync(resolve(dataset, 'integrity-manifest.json'));
    if (!within(dataset, manifestPath)) fail('manifest-outside-dataset');
    const manifestBytes = read(manifestPath, LIMITS.jsonBytes), manifest = parseContract(manifestBytes);
    report.datasetHash = hash(manifestBytes);
    exact(manifest, ['schema', 'cases']);
    if (!['docslurp-authored-eval@v2', 'docslurp-source-derived-eval@v2'].includes(manifest.schema)) fail('unsupported-manifest-version');
    list(manifest.cases, LIMITS.cases);
    const terms = new Map(), copyHashes = new Map(), cases = [], ids = new Set();
    let artifactBytes = 0, detailCount = 0;
    const term = (value, detail) => {
      if (value.length > LIMITS.valueChars) fail('resource-limit');
      if (detail.rule) assertLiteralTarget(value); // Includes authored manifest recognition IDs.
      if (!value.trim()) return;
      if (!terms.has(value)) terms.set(value, []);
      if (++detailCount > LIMITS.nodes) fail('resource-limit');
      terms.get(value).push(detail);
    };
    const load = entry => {
      exact(entry, ['path', 'sha256']);
      if (!nonempty(entry.path) || isAbsolute(entry.path) || !digest(entry.sha256)) fail('missing-artifact-provenance');
      const path = realpathSync(resolve(dataset, entry.path));
      if (!within(dataset, path)) fail('artifact-outside-dataset');
      const bytes = read(path, LIMITS.artifactBytes);
      artifactBytes += bytes.length; if (artifactBytes > LIMITS.repoBytes) fail('resource-limit');
      if (!bytes.length || hash(bytes) !== entry.sha256) fail('artifact-hash-mismatch');
      return bytes;
    };
    for (const [caseIndex, entry] of manifest.cases.entries()) {
      exact(entry, ['id', 'source', 'labels', 'provenance'], ['originalCaseId']);
      if (!nonempty(entry.id) || entry.id.length < 12 || ids.has(entry.id)) fail('invalid-or-duplicate-case-id');
      ids.add(entry.id);
      for (const value of validateProvenance(manifest, entry)) term(value, { rule: 'source-recognition-hash', caseIndex });
      const source = load(entry.source), labels = load(entry.labels);
      const projection = projectLabels(parseContract(labels));
      for (const [bytes, rule] of [[source, 'copied-source-artifact'], [labels, 'copied-label-artifact']]) {
        const key = hash(bytes);
        if (!copyHashes.has(key)) copyHashes.set(key, []);
        copyHashes.get(key).push({ rule, caseIndex });
        term(key, { rule: 'source-recognition-hash', caseIndex });
      }
      const identifiers = [entry.id, entry.source.path, basename(entry.source.path)];
      if (Object.hasOwn(entry, 'originalCaseId')) {
        if (!nonempty(entry.originalCaseId)) fail('invalid-recognition-target');
        identifiers.push(entry.originalCaseId);
      }
      for (const value of identifiers) term(value, { rule: 'fixture-identifier', caseIndex });
      for (const field of projection.fields) term(field.text, { caseIndex, pointer: field.pointer, sourcePointer: `/document${field.pointer}`, role: field.role,
        rule: field.role === 'recognition' ? 'fixture-identifier' : field.match === 'standalone' ? 'labeled-answer' : null });
      // Object keys remain visible in accounting and raw observations, but are
      // never guessed to be answers. Full artifact copies are always blocking.
      for (const member of projection.members) term(member.value, { caseIndex, pointer: member.pointer, sourcePointer: `/document${member.pointer}`, role: 'member-name', rule: null });
      report.projection.push({ caseIndex, artifactHash: hash(labels), provenanceHash: hash(JSON.stringify(entry.provenance)), fields: projection.fields.map(({ pointer, role, match, value }) => ({
        pointer, sourcePointer: `/document${pointer}`, role, ...(match ? { match } : {}), valueHash: hash(JSON.stringify(value)) })),
      members: projection.members.map(({ pointer, value }) => ({ pointer, sourcePointer: `/document${pointer}`, valueHash: hash(value) })), units: projection.units });
      cases.push(projection); report.cases++;
    }
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    git('rev-parse', '--verify', `${base}^{commit}`);
    report.gitHead = git('rev-parse', 'HEAD').trim();
    // Full current files deliberately include unchanged baseline, comments,
    // Markdown and tests. History or a directory name cannot grant an exemption.
    const files = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort();
    if (files.length > LIMITS.files) fail('resource-limit');
    const contentHash = createHash('sha256'); let totalBytes = 0, work = 0, contextWork = 0;
    const contextStep = (count = 1) => { contextWork += count; if (contextWork > LIMITS.contextWork) fail('resource-limit'); };
    for (const file of files) {
      const path = resolve(repo, file);
      const link = lstatSync(path, { throwIfNoEntry: false });
      if (!link) continue; // Removed tracked files no longer contaminate the current tree.
      if (link.isSymbolicLink() && !existsSync(path)) { add('repository-symlink-escape', { file }); continue; }
      const actual = realpathSync(path);
      if (!within(repo, actual)) { add('repository-symlink-escape', { file }); continue; }
      const bytes = read(actual, LIMITS.artifactBytes);
      totalBytes += bytes.length; if (totalBytes > LIMITS.repoBytes) fail('resource-limit');
      report.scannedFiles++; report.scannedProductionFiles++;
      contentHash.update(file).update('\0').update(hash(bytes)).update('\0');
      for (const detail of copyHashes.get(hash(bytes)) ?? []) add(detail.rule, { file, ...detail, evidenceHash: hash(bytes) });
      const binary = bytes.includes(0);
      // NUL-bearing files still expose literal IDs/answers; a binary marker must
      // not disable recognition. Invalid sequences become replacement characters.
      const text = new TextDecoder('utf-8', { fatal: !binary }).decode(bytes);
      work += Math.max(text.length, 1) * terms.size; if (work > LIMITS.scanWork) fail('resource-limit');
      const lineStarts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
      const lineAt = offset => {
        let lo = 0, hi = lineStarts.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid] <= offset) lo = mid + 1; else hi = mid; }
        return lo;
      };
      const occurrences = new Map();
      for (const [value, details] of terms) {
        const expression = pattern(value);
        for (let found; (found = expression.exec(text));) {
          // Resume beyond the previous start, not its end: every boundary-valid
          // self-overlap remains evidence. Advance a full code point under /u.
          expression.lastIndex = found.index + (text.codePointAt(found.index) > 0xffff ? 2 : 1);
          work += found[0].length; if (work > LIMITS.scanWork) fail('resource-limit');
          const position = { offset: found.index, end: found.index + found[0].length,
            line: lineAt(found.index), evidenceHash: hash(found[0]) };
          for (const detail of details) {
            const reason = detail.rule ? 'standalone-literal' : detail.role === 'metadata' ? 'authoring-metadata'
              : detail.role === 'member-name' ? 'member-name-only' : 'requires-bounded-context';
            const index = observation({ file, origin: 'working-tree', decoding: binary ? 'utf8-replacement' : 'utf8', ...detail, ...position, reason });
            if (detail.rule) add(detail.rule, { file, ...detail, ...position, observation: index });
            if (detail.pointer !== undefined && detail.role !== 'member-name') {
              const key = `${detail.caseIndex}:${detail.pointer}`;
              if (!occurrences.has(key)) occurrences.set(key, []);
              occurrences.get(key).push({ ...position, observation: index });
            }
          }
        }
      }
      if (!occurrences.size) continue;
      for (const [caseIndex, projection] of cases.entries()) {
        for (const [unitIndex, unit] of projection.units.entries()) {
          contextStep(unit.pointers.length);
          const groups = unit.pointers.map(pointer => occurrences.get(`${caseIndex}:${pointer}`) ?? []);
          if (groups.some(group => !group.length)) continue;
          // Search anchored windows, never a Cartesian product or whole-file bag.
          let matched = false, ambiguous = false;
          contextStep(groups.reduce((sum, group) => sum + group.length, 0));
          const all = groups.flat().sort((a, b) => { contextStep(); return a.offset - b.offset; });
          for (const anchor of all) {
            const selected = groups.map(group => group.find(hit => {
              contextStep();
              return hit.offset >= anchor.offset && hit.end - anchor.offset <= LIMITS.spanChars
                && lineAt(hit.end - 1) - lineAt(anchor.offset) + 1 <= LIMITS.spanLines;
            }));
            if (selected.some(hit => !hit)) continue;
            const sorted = [...selected].sort((a, b) => a.offset - b.offset);
            if (sorted.some((hit, i) => i && hit.offset < sorted[i - 1].end)) { ambiguous = true; continue; }
            add('contextual-answer', { file, caseIndex, unitIndex, kind: unit.kind, origin: 'working-tree',
              line: sorted[0].line, observations: selected.map(hit => hit.observation) });
            matched = true; break;
          }
          if (!matched && ambiguous) add('unresolved-context-ambiguity', { file, caseIndex, unitIndex });
        }
      }
    }
    report.productionHash = contentHash.digest('hex');
    if (!report.scannedFiles) fail('no-production-files-scanned');
  } catch (error) {
    // No input values, git stderr or absolute paths in error messages.
    add(/^[a-z][a-z-]+$/.test(error.message ?? '') ? error.message : 'unreadable-or-invalid-input');
  }
  report.passed = report.findings.length === 0;
  return report;
}
