#!/usr/bin/env node
/**
 * Compile authored extraction-quality specs into a frozen, hash-manifested dataset that lives
 * OUTSIDE the repository. Generic: it contains no case content, and it never overwrites a
 * destination. The compiled dataset is checked against the scorer before it is written, so an
 * oracle that cannot recognise its own reference answer, or cannot reject authored defects,
 * fails the build. Contract and layout: README.md.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fold, parseNumbers, scoreRun, tokens } from './score.mjs';

export const SPEC_SCHEMA = 'docslurp-quality-authored@v1';
export const INPUT_SCHEMA = 'docslurp-extraction-quality-inputs@v1';
const SPLITS = ['development', 'heldout'];
const GOLD_SCHEMA = 'docslurp-extraction-quality-gold@v1';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const squash = (s) => fold(s).replace(/\s+/gu, ' ').trim();
const fail = (where, what) => { throw new Error(`${where}: ${what}`); };
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
const stripMarks = (s) => s.normalize('NFKD').replace(/\p{M}+/gu, '');
const PAGE = '\f';

function checkVariants(where, variants) {
  if (!Array.isArray(variants) || !variants.length) fail(where, 'variants required');
  for (const [i, v] of variants.entries()) {
    if (!Array.isArray(v.groups) || !v.groups.length) fail(`${where}.variants[${i}]`, 'groups required');
    for (const g of v.groups) {
      if (!nonempty(g)) fail(`${where}.variants[${i}]`, 'empty group');
      try { new RegExp(g, 'giu'); } catch { fail(`${where}.variants[${i}]`, `invalid pattern ${g}`); }
      // Patterns run against folded (diacritic-free, lower-case) text.
      if (stripMarks(g) !== g) fail(`${where}.variants[${i}]`, `pattern must be diacritic-free: ${g}`);
    }
  }
}

function checkCase(split, c, requiredTags) {
  const where = `${split}:${c.id ?? '?'}`;
  if (!/^[a-z0-9-]{8,}$/u.test(c.id ?? '')) fail(where, 'id must match /^[a-z0-9-]{8,}$/');
  if (!nonempty(c.description) || !nonempty(c.source) || !nonempty(c.language)) fail(where, 'description, language and source required');
  if (!Array.isArray(c.tags) || !c.tags.length) fail(where, 'tags required');
  for (const t of c.tags) if (!requiredTags.includes(t)) fail(where, `unknown tag ${t}`);
  if (!Number.isInteger(c.summaryWordLimit) || c.summaryWordLimit < 30 || c.summaryWordLimit > 250) fail(where, 'summaryWordLimit must be 30..250');
  const pages = c.source.split(PAGE);
  if (pages.some((p) => !p.trim())) fail(where, 'empty page');
  const pageText = pages.map(squash);
  const entityIds = new Set();
  for (const e of c.entities ?? []) {
    if (!nonempty(e.id) || !nonempty(e.name) || entityIds.has(e.id)) fail(where, `bad or duplicate entity ${e.id}`);
    entityIds.add(e.id);
  }
  const relIds = new Set();
  for (const [kind, list] of [['relations', c.relations], ['forbiddenRelations', c.forbiddenRelations ?? []]]) {
    if (!Array.isArray(list)) fail(where, `${kind} must be an array`);
    for (const r of list) {
      if (!nonempty(r.id) || relIds.has(r.id)) fail(where, `bad or duplicate relation id ${r.id}`);
      relIds.add(r.id);
      if (!entityIds.has(r.source) || !entityIds.has(r.target) || r.source === r.target) fail(where, `relation ${r.id} endpoints must be distinct entity ids`);
      if (!Array.isArray(r.predicates) || !r.predicates.every(nonempty) || !r.predicates.length) fail(where, `relation ${r.id} predicates required`);
      if (kind === 'relations') {
        if (!r.evidence?.length) fail(where, `relation ${r.id} needs evidence`);
        for (const ev of r.evidence) checkEvidence(where, `relation ${r.id}`, ev, pageText);
      }
    }
  }
  if (Boolean(c.noRelations) !== (c.relations.length === 0)) fail(where, 'noRelations must be true exactly when relations is empty');
  const factIds = new Set();
  let salient = 0;
  for (const f of c.facts ?? []) {
    if (!nonempty(f.id) || !nonempty(f.statement) || factIds.has(f.id)) fail(where, `bad or duplicate fact ${f.id}`);
    factIds.add(f.id);
    if (f.polarity !== undefined && !['positive', 'negative'].includes(f.polarity)) fail(where, `fact ${f.id} polarity`);
    if (!f.evidence?.length) fail(where, `fact ${f.id} needs evidence`);
    for (const ev of f.evidence) checkEvidence(where, `fact ${f.id}`, ev, pageText);
    checkVariants(`${where} fact ${f.id}`, f.variants);
    for (const n of f.numbers ?? []) { if (!Number.isFinite(n.value)) fail(where, `fact ${f.id} number`); for (const form of n.forms ?? []) new RegExp(form, 'giu'); }
    for (const sig of f.contradictions ?? []) checkVariants(`${where} fact ${f.id} contradiction`, sig.variants);
    if (f.salient === true) salient++;
  }
  if (!factIds.size) fail(where, 'at least one fact required');
  if (!salient) fail(where, 'at least one salient fact required for the summary');
  for (const sig of c.forbiddenClaims ?? []) checkVariants(`${where} forbiddenClaims`, sig.variants);
  if ((c.oracleChecks?.defects ?? []).length < 1 || !c.oracleChecks?.reference) fail(where, 'oracleChecks.reference and at least one defect required');
  return pages.length;
}
function checkEvidence(where, label, ev, pageText) {
  if (!Number.isInteger(ev.page) || ev.page < 1 || ev.page > pageText.length || !nonempty(ev.quote)) fail(where, `${label}: evidence needs page and quote`);
  if (!pageText[ev.page - 1].includes(squash(ev.quote))) fail(where, `${label}: evidence quote not found verbatim on page ${ev.page}`);
}

/** The scorer must accept each authored reference answer and reject mechanically derived and authored defects. */
function selfCheck(split, c, id, gold) {
  const where = `${split}:${c.id}`;
  const run = (output) => scoreRun({ cases: [{ id, gold }], outputs: { cases: { [id]: output } } });
  const ref = run(c.oracleChecks.reference), a = ref.aggregate, g = ref.cases[0];
  const problems = [];
  if (a.contradictions) problems.push('reference has contradictions');
  if (g.graph.f1 !== 1) problems.push(`reference graph f1 ${g.graph.f1}`);
  if (g.keyPoints.coverage !== 1 || g.keyPoints.soundness !== 1) problems.push(`reference keyPoints coverage ${g.keyPoints.coverage} soundness ${g.keyPoints.soundness}`);
  if (g.summary.coverage !== 1 || g.summary.soundness !== 1) problems.push(`reference summary coverage ${g.summary.coverage} soundness ${g.summary.soundness}`);
  if (!g.summary.diagnostics.oneParagraph || !g.summary.diagnostics.withinWordLimit) problems.push('reference summary violates paragraph or word limit');
  if (problems.length) fail(where, `oracle rejects its own reference answer: ${problems.join('; ')}`);

  const sourceTokens = new Set(tokens(c.source));
  const rare = ['zeppelin', 'marmalade', 'tapestry', 'xylophone', 'quasar', 'gazebo', 'lighthouse'].filter((w) => !sourceTokens.has(w)).slice(0, 3);
  const refPoints = c.oracleChecks.reference.keyPoints, refSummary = c.oracleChecks.reference.summary;
  const appended = ` and a visiting ${rare[0]} delivered ${rare[1]} to the ${rare[2]}`;
  const checks = [
    ['empty answer', { graph: { entities: [], relationships: [] }, keyPoints: [], summary: '' }, (r) => r.cases[0].keyPoints.coverage === 0 && r.cases[0].summary.coverage === 0 && r.aggregate.verdict !== 'pass'],
    ['fluent irrelevant answer', { graph: { entities: [], relationships: [] }, keyPoints: ['The quarterly harvest festival drew many visitors and local vendors praised the weather.'], summary: 'The quarterly harvest festival drew many visitors and local vendors praised the weather.' }, (r) => r.cases[0].keyPoints.coverage === 0 && r.cases[0].summary.coverage === 0 && r.aggregate.verdict !== 'pass'],
    ['appended unsupported claim (key point)', { ...c.oracleChecks.reference, keyPoints: [refPoints[0].replace(/[.]+$/u, '') + appended + '.', ...refPoints.slice(1)] }, (r) => r.cases[0].details.keyPoints.units[0].status !== 'supported'],
    ['appended unsupported claim (summary)', { ...c.oracleChecks.reference, summary: refSummary.replace(/[.]+$/u, '') + appended + '.' }, (r) => r.cases[0].details.summary.units.at(-1).status !== 'supported'],
  ];
  const reversible = gold.relations.filter((r) => !r.symmetric);
  if (reversible.length) {
    const rev = reversible.map((r) => ({ source: r.target, predicate: r.predicates[0], target: r.source }));
    checks.push(['reversed edges', { ...c.oracleChecks.reference, graph: { entities: gold.entities.map((e) => ({ id: e.id, name: e.name })), relationships: rev } }, (r) => r.cases[0].graph.contradicted >= 1 || r.cases[0].graph.f1 < 1]);
  } else {
    checks.push(['hallucinated edge on a control', { ...c.oracleChecks.reference, graph: { entities: gold.entities.map((e) => ({ id: e.id, name: e.name })), relationships: [{ source: gold.entities[0].id, predicate: 'owns', target: gold.entities.at(-1).id }] } }, (r) => r.cases[0].graph.precision < 1]);
  }
  const expectations = { contradiction: (r) => r.aggregate.contradictions > 0, unverified: (r) => r.aggregate.openReviewItems > 0 && r.aggregate.verdict !== 'pass', miss: (r) => r.cases[0].keyPoints.coverage < 1 || r.cases[0].summary.coverage < 1, 'graph-drop': (r) => r.cases[0].graph.f1 < 1 };
  for (const d of c.oracleChecks.defects) {
    if (!expectations[d.expect]) fail(where, `unknown defect expectation ${d.expect}`);
    checks.push([`authored defect ${d.name}`, d.output, expectations[d.expect]]);
  }
  const failed = checks.filter(([, output, ok]) => !ok(run(output))).map(([name]) => name);
  if (failed.length) fail(where, `oracle failed to flag: ${failed.join('; ')}`);
}

/** Build both splits into `destination`. Returns a summary without case content. */
export function buildDataset({ development, heldout }, destination) {
  const specs = { development, heldout };
  const requiredTags = development?.requiredTags;
  for (const split of SPLITS) {
    const s = specs[split];
    if (s?.schema !== SPEC_SCHEMA || s.split !== split || !nonempty(s.author) || !nonempty(s.method) || !Number.isFinite(Date.parse(s.createdAt)) || !s.cases?.length) fail(split, 'spec needs schema, split, author, method, createdAt and cases');
    if (JSON.stringify(s.requiredTags) !== JSON.stringify(requiredTags) || !requiredTags?.length) fail(split, 'requiredTags must be identical across splits');
  }
  if (existsSync(destination)) fail('destination', 'already exists; frozen datasets are immutable');
  const ids = new Set();
  const prepared = {};
  for (const split of SPLITS) {
    prepared[split] = specs[split].cases.map((c) => {
      const pages = checkCase(split, c, requiredTags);
      // Held-out ids are opaque so a case id reveals nothing about its content or category.
      const id = split === 'heldout' ? `ho-${sha(c.source).slice(0, 12)}` : c.id;
      if (ids.has(id)) fail(split, 'duplicate case id or source');
      ids.add(id);
      const { source, oracleChecks, ...rest } = c;
      const gold = { ...rest, id, split, pages, relations: c.relations, forbiddenRelations: c.forbiddenRelations ?? [], forbiddenClaims: c.forbiddenClaims ?? [], allowedTerms: c.allowedTerms ?? [], allowedNumbers: c.allowedNumbers ?? [] };
      selfCheck(split, c, id, gold);
      return { id, gold, source: source.endsWith('\n') ? source : `${source}\n`, oracleChecks, pages, spec: c };
    });
    for (const t of requiredTags) if (!prepared[split].some((x) => x.spec.tags.includes(t))) fail(split, `missing required tag ${t}`);
  }
  const out = {}, counts = {}, manifestHashes = {}, combined = { schema: 'docslurp-authored-eval@v1', cases: [] };
  for (const split of SPLITS) {
    const dir = join(destination, split);
    mkdirSync(join(dir, 'oracle-checks'), { recursive: true });
    const manifest = { schema: 'docslurp-authored-eval@v1', cases: [] }, inputs = { schema: INPUT_SCHEMA, version: 'v1', split, cases: [] };
    for (const c of prepared[split]) {
      const labels = json({ schema: GOLD_SCHEMA, labels: [{ name: `quality_gold_${c.id.replaceAll('-', '_')}`, expected: c.gold }] });
      writeFileSync(join(dir, `${c.id}.txt`), c.source);
      writeFileSync(join(dir, `${c.id}.gold.json`), labels);
      writeFileSync(join(dir, 'oracle-checks', `${c.id}.json`), json(c.oracleChecks));
      const provenance = { kind: 'authored', author: specs[split].author, description: c.spec.description, createdAt: specs[split].createdAt };
      const entry = (prefix) => ({ id: c.id, source: { path: `${prefix}${c.id}.txt`, sha256: sha(c.source) }, labels: { path: `${prefix}${c.id}.gold.json`, sha256: sha(labels) }, provenance });
      manifest.cases.push(entry(''));
      combined.cases.push(entry(`${split}/`));
      inputs.cases.push({ id: c.id, source: { path: `${c.id}.txt`, sha256: sha(c.source), bytes: Buffer.byteLength(c.source), pages: c.pages, pageSeparator: '\\f' }, summaryWordLimit: c.gold.summaryWordLimit });
    }
    writeFileSync(join(dir, 'integrity-manifest.json'), json(manifest));
    writeFileSync(join(dir, 'runner-inputs.json'), json(inputs));
    manifestHashes[split] = sha(json(manifest));
    counts[split] = manifest.cases.length;
    mkdirSync(join(destination, 'authored'), { recursive: true });
    out[split] = json(specs[split]);
    writeFileSync(join(destination, 'authored', `${split}.spec.json`), out[split]);
  }
  writeFileSync(join(destination, 'integrity-manifest.json'), json(combined));
  const here = (name) => sha(readFileSync(join(dirname(fileURLToPath(import.meta.url)), name)));
  writeFileSync(join(destination, 'version.json'), json({
    schema: 'docslurp-extraction-quality-dataset@v1', version: 'v1', frozen: true, createdAt: specs.development.createdAt,
    author: specs.development.author, method: specs.development.method, requiredTags, counts,
    specSha256: Object.fromEntries(SPLITS.map((s) => [s, sha(out[s])])), splitManifestSha256: manifestHashes, combinedManifestSha256: sha(json(combined)),
    tools: { 'build-dataset.mjs': here('build-dataset.mjs'), 'score.mjs': here('score.mjs') },
  }));
  freeze(destination);
  return { destination, counts, manifestHashes, combinedManifestSha256: sha(json(combined)) };
}

function freeze(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) { for (const name of readdirSync(path)) freeze(join(path, name)); chmodSync(path, 0o555); } else chmodSync(path, 0o444);
}

export function main(argv = process.argv.slice(2)) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--development', '--heldout', '--out'].includes(argv[i]) || !argv[i + 1]) throw new Error('Expected --development <spec.json> --heldout <spec.json> --out <new directory>');
    o[argv[i].slice(2)] = argv[i + 1];
  }
  if (!o.development || !o.heldout || !o.out) throw new Error('Expected --development <spec.json> --heldout <spec.json> --out <new directory>');
  const destination = resolve(o.out);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const parent = existsSync(dirname(destination)) ? realpathSync(dirname(destination)) : dirname(destination);
  if (`${parent}${sep}`.startsWith(`${repo}${sep}`)) throw new Error('The dataset must live outside the repository');
  const summary = buildDataset({ development: JSON.parse(readFileSync(o.development, 'utf8')), heldout: JSON.parse(readFileSync(o.heldout, 'utf8')) }, destination);
  process.stdout.write(json(summary));
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
