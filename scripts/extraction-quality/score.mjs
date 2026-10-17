#!/usr/bin/env node
/**
 * Deterministic extraction-quality scorer: graph edges, key points, summary.
 * Offline only (no network, no model calls). Contract and rubric: README.md.
 *
 * Deterministic matching cannot prove arbitrary claim support. Anything it cannot
 * verify is labelled `unverified` and queued for independent blind review; only a
 * valid review file can move a run from `needs-review` to `pass`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPORT_SCHEMA = 'docslurp-extraction-quality-report@v1';
export const OUTPUT_SCHEMA = 'docslurp-extraction-quality-outputs@v1';
export const REVIEW_SCHEMA = 'docslurp-quality-review@v1';
/** Frozen acceptance targets from the experiment plan; reported, never applied per case. */
export const TARGETS = { graphPrecision: 0.95, graphRecall: 0.9, keyPointCoverage: 0.9, summaryCoverage: 0.9, contradictions: 0, unsupportedUnits: 0 };

const sha = (value) => createHash('sha256').update(value).digest('hex');
/** NFKD, strip combining marks, lower-case. Gold patterns are written against this form. */
export const fold = (value) => String(value ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase();
const f1 = (a, b) => (a + b ? (2 * a * b) / (a + b) : 0);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const wordSet = (s) => new Set(s.split(/\s+/u).filter(Boolean));

// ---- lexical helpers ------------------------------------------------------------------
const STOP = wordSet(`the and for are but not you all any can had her was one our out has his how its may new now old see two way who did get let put say she too use that this with from have been were will would could should there their they them then than what when where which while into onto over under about after before between during through within without also such each other some more most much many very just only both either neither being does done doing your these those whose whom here said says
el la los las un una unos unas de del que y o en por con para sin sobre entre como pero mas muy ya fue ser era son han hay este esta estos estas ese esa eso se su sus lo al le les
der die das den dem des ein eine einen einem einer und oder mit von zu im am ist sind war waren wurde wurden hat haben auch nicht auf aus bei nach uber fur als wie aber dass sich seine ihre
le les des du une est sont etait dans pour par avec sur sous mais ont aux ses leur
os as um uma uns umas do da dos das em no na nos nas foi sao tem`);
const GENERIC = wordSet(`document text article report reports reported states stated according notes noted note describes described describing says mentions mentioned summary overall additionally however therefore thus including included includes include later earlier former current currently now then still already first second third finally together stating following several various given same another because since although whereas whether per via`);
const NEGATION = /\b(?:not|no|never|neither|nor|none|cannot|without|nobody|nothing|nunca|nada|ningun\w*|jamas|sin|ni|nicht|kein\w*|nie|niemals|ohne|niemand|ne|pas|jamais|aucun\w*|sans|nao|sem)\b|n['’]t\b/iu;
/** Phrases that contain a negation word but express a quantity bound, not polarity. */
const NEGATION_IDIOMS = /\b(?:no|not) (?:more|less|fewer|later|earlier|greater|higher|lower|sooner) than\b|\bnot exceed\w*|\bnot only\b|\bsin embargo\b|\bno obstante\b|\bnicht nur\b/giu;
const CJK = '\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}';
const TOKEN = new RegExp(`${CJK}|(?:(?!${CJK})[\\p{L}\\p{N}])+`, 'gu');
const CJK_ONE = new RegExp(`^(?:${CJK})$`, 'u');

export const tokens = (text) => fold(text).match(TOKEN) ?? [];
export const contentTokens = (text) => tokens(text).filter((t) => !/\d/u.test(t) && (CJK_ONE.test(t) || t.length >= 3) && !STOP.has(t) && !GENERIC.has(t) && !isNumberWord(t));

/** Token allow-list with light inflection tolerance: plural stripping and a shared 5-letter stem. */
class Lexicon {
  constructor(list) {
    this.exact = new Set(list);
    this.prefix = new Set(list.filter((t) => t.length >= 5).map((t) => t.slice(0, 5)));
  }
  has(t) {
    return this.exact.has(t) || this.exact.has(t.replace(/(?:es|s)$/u, '')) || (t.length >= 5 && this.prefix.has(t.slice(0, 5)));
  }
}

// ---- numbers --------------------------------------------------------------------------
const isNumberWord = (t) => Object.hasOwn(WORDS, t);
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const MAGNITUDE = new Set(['thousand', 'million', 'billion', 'trillion']);
function digitValue(raw) {
  const s = raw.replace(/[   ]/gu, '');
  const dots = (s.match(/\./gu) ?? []).length, commas = (s.match(/,/gu) ?? []).length;
  if (dots && commas) { const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ','; return Number(s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.')); }
  const sep = dots ? '.' : commas ? ',' : '';
  if (!sep) return Number(s);
  const parts = s.split(sep);
  if (parts.length > 2) return Number(parts.join(''));
  return parts[1].length === 3 && parts[0] !== '0' ? Number(parts.join('')) : Number(`${parts[0]}.${parts[1]}`);
}
/** Numbers in already-folded text: digits (separators, "2.5 million") and English number words. A lone "one" is ignored. */
export function parseNumbers(text) {
  const out = [], used = [];
  for (const m of text.matchAll(/\d[\d.,  ]*\d|\d/gu)) {
    let end = m.index + m[0].length;
    if (/^(?:st|nd|rd|th)\b/u.test(text.slice(end))) continue;
    let value = digitValue(m[0]);
    const mag = /^\s*(thousand|million|billion|trillion|hundred|millones|millon)\b/u.exec(text.slice(end));
    if (mag) { value *= isNumberWord(mag[1]) ? WORDS[mag[1]] : 1e6; end += mag[0].length; }
    if (Number.isFinite(value)) { out.push(value); used.push([m.index, end]); }
  }
  const toks = [...text.matchAll(/[a-z]+/gu)];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i][0];
    if (!isNumberWord(w) || w === 'one' || used.some(([a, b]) => toks[i].index >= a && toks[i].index < b)) continue;
    let total = 0, current = 0, j = i;
    for (; j < toks.length; j++) {
      const t = toks[j][0];
      if (j > i && !/^[\s-]+$/u.test(text.slice(toks[j - 1].index + toks[j - 1][0].length, toks[j].index))) break;
      if (t === 'and' && j > i && toks[j + 1] && isNumberWord(toks[j + 1][0]) && (toks[j - 1][0] === 'hundred' || MAGNITUDE.has(toks[j - 1][0]))) continue;
      if (!isNumberWord(t)) break;
      if (t === 'hundred') current = (current || 1) * 100;
      else if (MAGNITUDE.has(t)) { total += (current || 1) * WORDS[t]; current = 0; } else current += WORDS[t];
    }
    out.push(total + current);
    i = j - 1;
  }
  return out;
}
const sameNumber = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const hasNumber = (list, value) => list.some((v) => sameNumber(v, value));

// ---- units ----------------------------------------------------------------------------
const ABBREVIATION = /\b(Dr|Mr|Mrs|Ms|Prof|St|Mt|Jr|Sr|vs|Inc|Ltd|Co|No|approx|ca|etc)\./gu;
/** Split text (or list items) into sentence-level units; ';' and newlines also split. */
export function splitUnits(input) {
  const units = [];
  for (const part of Array.isArray(input) ? input : [input]) {
    const text = String(part && typeof part === 'object' ? part.text ?? '' : part ?? '').normalize('NFKC').replace(ABBREVIATION, '$1\u0001');
    for (const raw of text.split(/(?<=[.!?。！？])\s+|(?<=[。！？])|[;\n]+/u)) {
      const unit = raw.replaceAll('\u0001', '.').replace(/^\s*(?:[-*•–]|\d{1,2}[.)])\s+/u, '').trim();
      if (/\p{L}/u.test(unit)) units.push(unit);
    }
  }
  return units;
}
const plainText = (input) => (Array.isArray(input) ? input.map((x) => (x && typeof x === 'object' ? x.text ?? '' : x)).join('\n') : String(input ?? ''));

// ---- gold preparation -----------------------------------------------------------------
const rxCache = new Map();
const rx = (source) => { let r = rxCache.get(source); if (!r) { r = new RegExp(source, 'giu'); rxCache.set(source, r); } r.lastIndex = 0; return r; };
const formHit = (source, text) => rx(source).test(text);
function matchVariant(variant, text) {
  const spans = [];
  let from = 0;
  for (const group of variant.groups) {
    const r = rx(group);
    r.lastIndex = variant.ordered ? from : 0;
    const m = r.exec(text);
    if (!m) return null;
    spans.push([m.index, m.index + m[0].length]);
    if (variant.ordered) from = m.index + Math.max(m[0].length, 1);
  }
  return { start: Math.min(...spans.map((s) => s[0])), end: Math.max(...spans.map((s) => s[1])), terms: spans.map(([a, b]) => text.slice(a, b)).join(' ') };
}
/** Negation cue in the same clause as the matched span (cue may precede it by up to 40 characters). */
function negated(text, span) {
  const cleaned = text.replace(NEGATION_IDIOMS, (m) => ' '.repeat(m.length));
  const before = cleaned.slice(Math.max(0, span.start - 40), span.start);
  let cut = 0;
  for (const m of before.matchAll(/[,;:]|\b(?:but|however|although|while|whereas|yet)\b/giu)) cut = m.index + m[0].length;
  return NEGATION.test(before.slice(cut) + cleaned.slice(span.start, span.end));
}
const prepared = new WeakMap();
function prepare(gold) {
  let p = prepared.get(gold);
  if (p) return p;
  const entityTokens = (gold.entities ?? []).flatMap((e) => [e.name, ...(e.aliases ?? [])]).flatMap(tokens);
  const extraTokens = (gold.allowedTerms ?? []).flatMap(tokens);
  const facts = (gold.facts ?? []).map((fact) => {
    const text = [fact.statement, ...(fact.evidence ?? []).map((e) => e.quote), ...(fact.lexicon ?? [])].join(' ');
    return { fact, lexicon: contentTokens(text), numbers: [...parseNumbers(fold(text)), ...(fact.numbers ?? []).map((n) => n.value)] };
  });
  p = {
    facts, entity: new Lexicon(entityTokens), extra: new Lexicon(extraTokens),
    caseLexicon: new Lexicon([...entityTokens, ...extraTokens, ...facts.flatMap((f) => f.lexicon)]),
    caseNumbers: (gold.allowedNumbers ?? []).map(Number),
  };
  prepared.set(gold, p);
  return p;
}

/** One fact against one folded unit: covered | contradiction | partial, or null when its anchors are absent. */
function evalFact(fact, text, nums) {
  for (const variant of fact.variants) {
    const span = matchVariant(variant, text);
    if (!span) continue;
    if (!variant.ignoreNegation) {
      const observedNegative = Boolean(Number(negated(text, span)) ^ Number(Boolean(variant.inherentNegation)));
      if (observedNegative !== (fact.polarity === 'negative')) return { status: 'contradiction', kind: 'polarity' };
    }
    const required = fact.numbers ?? [];
    const missing = required.filter((n) => !hasNumber(nums, n.value) && !(n.forms ?? []).some((f) => formHit(f, text)));
    if (missing.length) {
      // Anchors present with a different number: a wrong value, not merely an incomplete statement.
      return nums.some((v) => !hasNumber(required.map((n) => n.value), v)) ? { status: 'contradiction', kind: 'numeric' } : { status: 'partial' };
    }
    return { status: 'covered', terms: span.terms };
  }
  return null;
}
const signatureHit = (sig, text) => (sig.variants ?? []).some((v) => matchVariant(v, text));

/** Score a prose artifact: key points (array) or summary (string). Summary coverage counts salient facts only. */
export function scoreProse(gold, input, field = 'keyPoints') {
  const p = prepare(gold);
  const units = [], covered = new Set();
  for (const text of splitUnits(input)) {
    const t = fold(text), nums = parseNumbers(t);
    const hits = p.facts.map((entry) => ({ entry, r: evalFact(entry.fact, t, nums) })).filter((h) => h.r);
    const contradictions = hits.filter((h) => h.r.status === 'contradiction').map((h) => ({ factId: h.entry.fact.id, kind: h.r.kind }));
    for (const { fact } of p.facts) for (const sig of fact.contradictions ?? []) if (signatureHit(sig, t)) contradictions.push({ factId: fact.id, kind: sig.id ?? 'contradiction', reason: sig.reason });
    for (const sig of gold.forbiddenClaims ?? []) if (signatureHit(sig, t)) contradictions.push({ kind: sig.id ?? 'forbidden', reason: sig.reason });
    const coveredHits = hits.filter((h) => h.r.status === 'covered');
    const matched = coveredHits.map((h) => h.entry);
    const unit = { id: sha(`unit|${field}|${text}`).slice(0, 16), text, status: 'neutral', reason: null, facts: matched.map((e) => e.fact.id), contradictions };
    units.push(unit);
    if (contradictions.length) { unit.status = 'contradicted'; continue; }
    const content = contentTokens(text);
    // Words the author's own patterns matched are vetted paraphrases of the fact, so they are allowed too.
    const lexicon = new Lexicon([...matched.flatMap((e) => e.lexicon), ...coveredHits.flatMap((h) => contentTokens(h.r.terms))]);
    const allowedNumbers = [...matched.flatMap((e) => e.numbers), ...p.caseNumbers];
    const residualTerms = content.filter((tok) => !lexicon.has(tok) && !p.entity.has(tok) && !p.extra.has(tok));
    const unsupportedNumbers = nums.filter((v) => !hasNumber(allowedNumbers, v));
    if (matched.length) {
      for (const e of matched) covered.add(e.fact.id);
      // A fact match must not launder an appended claim: leftovers make the whole unit unverified.
      if (residualTerms.length || unsupportedNumbers.length) Object.assign(unit, { status: 'unverified', reason: 'terms-beyond-matched-facts', residualTerms, unsupportedNumbers });
      else unit.status = 'supported';
    } else if (content.length || nums.length) {
      Object.assign(unit, { status: 'unverified', reason: hits.length ? 'incomplete-fact' : 'no-matching-fact', novelTerms: content.filter((tok) => !p.caseLexicon.has(tok)), unsupportedNumbers });
    }
  }
  const expected = p.facts.filter(({ fact }) => field !== 'summary' || fact.salient === true).map((e) => e.fact.id);
  const text = plainText(input);
  const wordCount = text.trim() ? text.trim().split(/\s+/u).length : 0;
  const keyPointNorm = Array.isArray(input) ? input.map((x) => fold(x && typeof x === 'object' ? x.text : x).replace(/\W+/gu, ' ').trim()) : [];
  return {
    field, expected, covered: expected.filter((id) => covered.has(id)), missing: expected.filter((id) => !covered.has(id)), units,
    artifactText: text, artifactSha256: sha(text),
    diagnostics: field === 'summary'
      ? { words: wordCount, oneParagraph: text.trim() !== '' && !/\n|^\s*(?:[-*•]|\d+[.)])\s/u.test(text.trim()), withinWordLimit: wordCount <= (gold.summaryWordLimit ?? Infinity) }
      : { keyPoints: keyPointNorm.length, duplicates: keyPointNorm.length - new Set(keyPointNorm).size },
  };
}

// ---- graph ----------------------------------------------------------------------------
const norm = (value) => fold(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const edgeKeyOf = (s, p, t) => `${s}\u0000${p}\u0000${t}`;
/** Score relationships. Reversed, forbidden and unlisted edges are never counted as supported. */
export function scoreGraph(gold, graph = {}) {
  const alias = new Map();
  for (const e of gold.entities ?? []) for (const name of [e.name, ...(e.aliases ?? [])]) { alias.set(norm(name), e.id); alias.set(norm(name).replace(/^the /u, ''), e.id); }
  const given = new Map((graph?.entities ?? []).filter((e) => e && typeof e === 'object' && e.id != null).map((e) => [String(e.id), e]));
  const resolveEndpoint = (value) => {
    const entry = given.get(String(value));
    for (const name of [entry?.name, ...(entry?.aliases ?? []), value]) {
      const n = norm(name), id = alias.get(n) ?? alias.get(n.replace(/^the /u, ''));
      if (id) return { id, label: String(entry?.name ?? value) };
    }
    return { id: null, label: String(entry?.name ?? value) };
  };
  const accepted = (r) => {
    const set = new Set();
    for (const p of r.predicates ?? []) set.add(edgeKeyOf(r.source, norm(p), r.target));
    for (const p of r.inversePredicates ?? []) set.add(edgeKeyOf(r.target, norm(p), r.source));
    if (r.symmetric) for (const p of r.predicates ?? []) set.add(edgeKeyOf(r.target, norm(p), r.source));
    return set;
  };
  const reversedOf = (r) => {
    const set = new Set();
    if (!r.symmetric) {
      for (const p of r.predicates ?? []) set.add(edgeKeyOf(r.target, norm(p), r.source));
      for (const p of r.inversePredicates ?? []) set.add(edgeKeyOf(r.source, norm(p), r.target));
    }
    return set;
  };
  const relations = (gold.relations ?? []).map((r) => ({ r, ok: accepted(r), reversed: reversedOf(r) }));
  const forbidden = (gold.forbiddenRelations ?? []).map((r) => accepted(r));
  const distinct = new Map();
  for (const edge of graph?.relationships ?? []) {
    if (!edge || typeof edge !== 'object') continue;
    const source = resolveEndpoint(edge.source), target = resolveEndpoint(edge.target), p = norm(edge.predicate);
    const k = edgeKeyOf(source.id ?? `?${norm(source.label)}`, p, target.id ?? `?${norm(target.label)}`);
    if (!distinct.has(k)) distinct.set(k, { source, target, predicate: String(edge.predicate ?? ''), k });
  }
  const supportedBy = new Map(), unsupported = [];
  let redundantEdges = 0;
  for (const e of distinct.values()) {
    const base = { id: sha(`edge|${e.k}`).slice(0, 16), source: e.source.label, predicate: e.predicate, target: e.target.label };
    if (!e.source.id || !e.target.id) { unsupported.push({ ...base, class: 'unmatched', reason: 'unresolved-endpoint' }); continue; }
    const idx = relations.findIndex((x) => x.ok.has(e.k));
    if (idx >= 0) { if (supportedBy.has(idx)) redundantEdges++; else supportedBy.set(idx, e); continue; }
    const reason = e.source.id === e.target.id ? 'self-loop' : relations.some((x) => x.reversed.has(e.k)) ? 'reversed' : forbidden.some((set) => set.has(e.k)) ? 'forbidden' : null;
    unsupported.push({ ...base, class: reason ? 'contradicted' : 'unmatched', reason: reason ?? undefined });
  }
  const outEntityIds = new Set((graph?.entities ?? []).filter((e) => e && typeof e === 'object').map((e) => resolveEndpoint(e.name).id).filter(Boolean));
  const goldIds = (gold.entities ?? []).map((e) => e.id);
  return {
    expected: relations.length, covered: relations.filter((_, i) => supportedBy.has(i)).map((x) => x.r.id), missing: relations.filter((_, i) => !supportedBy.has(i)).map((x) => x.r.id),
    supportedEdges: supportedBy.size, redundantEdges, unsupported,
    diagnostics: { entityRecall: goldIds.length ? goldIds.filter((id) => outEntityIds.has(id)).length / goldIds.length : 1, noRelationsControl: relations.length === 0 },
  };
}

// ---- views: deterministic, or with blind-review verdicts applied -----------------------
const hashKey = (...parts) => sha(parts.join('|')).slice(0, 16);
const unitKey = (caseId, u) => hashKey(caseId, u.id);
const edgeKey = (caseId, e) => hashKey(caseId, e.id);
const factKey = (caseId, r, factId) => hashKey(caseId, 'fact', r.field, factId, r.artifactSha256);

function proseView(r, verdicts, caseId) {
  const c = { supported: 0, openUnverified: 0, confirmedUnsupported: 0, contradicted: 0 };
  for (const u of r.units) {
    const v = verdicts[unitKey(caseId, u)];
    if (u.status === 'contradicted') c.contradicted++;
    else if (u.status === 'supported' || (u.status === 'unverified' && v === 'supported')) c.supported++;
    else if (u.status === 'unverified') c[v === 'unsupported' ? 'confirmedUnsupported' : 'openUnverified']++;
  }
  const askable = r.artifactText.trim() ? r.missing : [];
  const reviewedCovered = askable.filter((id) => verdicts[factKey(caseId, r, id)] === 'covered').length;
  const openFacts = askable.filter((id) => verdicts[factKey(caseId, r, id)] === undefined).length;
  const covered = r.covered.length + reviewedCovered;
  const scored = c.supported + c.openUnverified + c.confirmedUnsupported + c.contradicted;
  const coverage = r.expected.length ? covered / r.expected.length : 1;
  const soundness = scored ? c.supported / scored : 0;
  return { ...c, expected: r.expected.length, covered, coverage, soundness, score: f1(coverage, soundness), empty: scored === 0, openItems: c.openUnverified + openFacts, diagnostics: r.diagnostics };
}
function graphView(g, verdicts, caseId) {
  const n = { open: 0, confirmed: 0, reviewedSupported: 0, contradicted: 0 };
  for (const e of g.unsupported) {
    const v = verdicts[edgeKey(caseId, e)];
    if (e.class === 'contradicted') n.contradicted++;
    else if (e.class === 'unmatched' && v === 'supported') n.reviewedSupported++;
    else if (e.class === 'unmatched' && v === 'unsupported') n.confirmed++;
    else n.open++;
  }
  const predicted = g.supportedEdges + g.unsupported.length;
  const precision = predicted ? (g.supportedEdges + n.reviewedSupported) / predicted : 1;
  const recall = g.expected ? g.supportedEdges / g.expected : 1;
  return { tp: g.supportedEdges, predicted, expected: g.expected, precision, recall, f1: f1(precision, recall), contradicted: n.contradicted, openItems: g.unsupported.filter((e) => e.class === 'unmatched' && verdicts[edgeKey(caseId, e)] === undefined).length, confirmedUnsupported: n.confirmed, reviewedSupported: n.reviewedSupported, unsupportedEdges: n.open + n.confirmed, diagnostics: g.diagnostics };
}

export function envelopeDiagnostics(output) {
  const problems = [];
  if (!output || typeof output !== 'object') return { valid: false, problems: ['missing-output'] };
  if (!Array.isArray(output.graph?.relationships)) problems.push('graph.relationships');
  if (!Array.isArray(output.keyPoints) || output.keyPoints.some((k) => typeof k !== 'string' && typeof k?.text !== 'string')) problems.push('keyPoints');
  if (typeof output.summary !== 'string') problems.push('summary');
  return { valid: !problems.length, problems };
}
/** Raw (verdict-free) result for one generation. */
export function scoreCase(gold, output) {
  return {
    missing: !output || typeof output !== 'object', envelope: envelopeDiagnostics(output),
    graph: scoreGraph(gold, output?.graph),
    keyPoints: scoreProse(gold, output?.keyPoints, 'keyPoints'),
    summary: scoreProse(gold, typeof output?.summary === 'string' ? output.summary : '', 'summary'),
  };
}
function caseView(caseId, result, verdicts) {
  const graph = graphView(result.graph, verdicts, caseId), keyPoints = proseView(result.keyPoints, verdicts, caseId), summary = proseView(result.summary, verdicts, caseId);
  return {
    caseId, graph, keyPoints, summary, missing: result.missing, envelope: result.envelope,
    contradictions: graph.contradicted + keyPoints.contradicted + summary.contradicted,
    confirmedUnsupported: graph.confirmedUnsupported + keyPoints.confirmedUnsupported + summary.confirmedUnsupported,
    openItems: graph.openItems + keyPoints.openItems + summary.openItems,
    score: mean([graph.f1, keyPoints.score, summary.score]),
  };
}

function proseAggregate(views, field) {
  const sum = (f) => views.reduce((s, v) => s + f(v[field]), 0);
  const scored = sum((x) => x.supported + x.openUnverified + x.confirmedUnsupported + x.contradicted);
  return {
    pooledCoverage: sum((x) => x.expected) ? sum((x) => x.covered) / sum((x) => x.expected) : 1, macroCoverage: mean(views.map((v) => v[field].coverage)),
    pooledSoundness: scored ? sum((x) => x.supported) / scored : 0, score: mean(views.map((v) => v[field].score)),
    covered: sum((x) => x.covered), expected: sum((x) => x.expected), supported: sum((x) => x.supported),
    openUnverified: sum((x) => x.openUnverified), confirmedUnsupported: sum((x) => x.confirmedUnsupported), contradicted: sum((x) => x.contradicted),
  };
}
function aggregateViews(views, reviewValid) {
  const sum = (f) => views.reduce((s, v) => s + f(v), 0);
  const ratio = (a, b) => (b ? a / b : 1);
  const agg = {
    cases: new Set(views.map((v) => v.caseId)).size, generations: views.length, missingCases: sum((v) => Number(v.missing)),
    primary: mean(views.map((v) => v.score)),
    graph: {
      pooled: { precision: ratio(sum((v) => v.graph.tp + v.graph.reviewedSupported), sum((v) => v.graph.predicted)), recall: ratio(sum((v) => v.graph.tp), sum((v) => v.graph.expected)), tp: sum((v) => v.graph.tp), predicted: sum((v) => v.graph.predicted), expected: sum((v) => v.graph.expected) },
      macro: { precision: mean(views.map((v) => v.graph.precision)), recall: mean(views.map((v) => v.graph.recall)), f1: mean(views.map((v) => v.graph.f1)) },
      contradictedEdges: sum((v) => v.graph.contradicted), unsupportedEdges: sum((v) => v.graph.unsupportedEdges),
      controls: { cases: views.filter((v) => v.graph.diagnostics.noRelationsControl).length, withEdges: views.filter((v) => v.graph.diagnostics.noRelationsControl && v.graph.predicted > 0).length },
    },
    keyPoints: proseAggregate(views, 'keyPoints'),
    summary: { ...proseAggregate(views, 'summary'), oneParagraphRate: mean(views.map((v) => Number(v.summary.diagnostics.oneParagraph))), withinWordLimitRate: mean(views.map((v) => Number(v.summary.diagnostics.withinWordLimit))) },
    emptyArtifacts: sum((v) => Number(v.keyPoints.empty) + Number(v.summary.empty)),
    contradictions: sum((v) => v.contradictions), confirmedUnsupported: sum((v) => v.confirmedUnsupported), openReviewItems: sum((v) => v.openItems),
    envelopeValidRate: mean(views.map((v) => Number(v.envelope.valid))),
  };
  agg.unsupportedUnits = agg.keyPoints.openUnverified + agg.keyPoints.confirmedUnsupported + agg.summary.openUnverified + agg.summary.confirmedUnsupported + agg.graph.unsupportedEdges;
  agg.targets = {
    graphPrecision: agg.graph.pooled.precision >= TARGETS.graphPrecision, graphRecall: agg.graph.pooled.recall >= TARGETS.graphRecall,
    keyPointCoverage: agg.keyPoints.pooledCoverage >= TARGETS.keyPointCoverage, summaryCoverage: agg.summary.pooledCoverage >= TARGETS.summaryCoverage,
    contradictions: agg.contradictions <= TARGETS.contradictions, unsupportedUnits: agg.unsupportedUnits <= TARGETS.unsupportedUnits,
  };
  agg.verdict = !views.length || agg.missingCases || agg.emptyArtifacts || agg.contradictions || agg.confirmedUnsupported ? 'fail' : reviewValid && !agg.openReviewItems ? 'pass' : 'needs-review';
  return agg;
}

// ---- blind review ---------------------------------------------------------------------
export function validateReview(review) {
  const problems = [];
  if (review?.schema !== REVIEW_SCHEMA) problems.push('schema');
  if (typeof review?.reviewer !== 'string' || !review.reviewer.trim()) problems.push('reviewer');
  if (review?.blind !== true) problems.push('blind');
  if (review?.independentOfAuthor !== true) problems.push('independentOfAuthor');
  if (!review?.items || typeof review.items !== 'object') problems.push('items');
  return { valid: !problems.length, problems };
}
const VERDICTS = { unit: ['supported', 'unsupported'], edge: ['supported', 'unsupported'], fact: ['covered', 'not-covered'] };

/** Deduplicated items (identical text across candidates shares one verdict), in a stable pseudo-random order. */
export function reviewQueue(results) {
  const byId = new Map();
  for (const { id: caseId, result } of results) {
    for (const field of ['keyPoints', 'summary']) {
      const r = result[field];
      for (const u of r.units) if (u.status === 'unverified') byId.set(unitKey(caseId, u), { type: 'unit', caseId, field, text: u.text });
      if (r.artifactText.trim()) for (const factId of r.missing) byId.set(factKey(caseId, r, factId), { type: 'fact', caseId, field, factId, artifactText: r.artifactText });
    }
    for (const e of result.graph.unsupported) if (e.class === 'unmatched') byId.set(edgeKey(caseId, e), { type: 'edge', caseId, source: e.source, predicate: e.predicate, target: e.target });
  }
  const items = [...byId].map(([itemId, item]) => ({ itemId, ...item })).sort((a, b) => sha(`${a.itemId}order`).localeCompare(sha(`${b.itemId}order`)));
  return { schema: 'docslurp-quality-review-queue@v1', verdicts: VERDICTS, items };
}

/**
 * Score a run. `cases`: [{id, gold}]; `outputs`: {runId?, cases:{id: output | output[]}}.
 * An array value is a list of independent generations of that case.
 */
export function scoreRun({ cases, outputs, review = null }) {
  const check = review ? validateReview(review) : { valid: false, problems: ['no-review'] };
  const results = [];
  for (const { id, gold } of cases) {
    const raw = outputs?.cases?.[id];
    for (const [index, output] of (Array.isArray(raw) ? raw : [raw]).entries()) results.push({ id, index, result: scoreCase(gold, output) });
  }
  const queue = reviewQueue(results);
  const kinds = new Map(queue.items.map((i) => [i.itemId, i.type]));
  const verdicts = {};
  let invalidVerdicts = 0;
  if (check.valid) for (const [k, v] of Object.entries(review.items)) { if (kinds.has(k) && VERDICTS[kinds.get(k)].includes(v)) verdicts[k] = v; else invalidVerdicts++; }
  const views = results.map((r) => caseView(r.id, r.result, verdicts));
  return {
    schema: REPORT_SCHEMA, runId: outputs?.runId ?? null,
    aggregate: aggregateViews(views, check.valid),
    deterministic: check.valid ? aggregateViews(results.map((r) => caseView(r.id, r.result, {})), false) : undefined,
    review: { supplied: Boolean(review), valid: check.valid, problems: check.problems, queued: queue.items.length, ignoredVerdicts: invalidVerdicts },
    cases: views.map((v, i) => ({ ...v, generation: results[i].index, details: results[i].result })),
    queue,
  };
}

/** Pooled numbers only: the form used for every held-out report. */
export function aggregateOnly(report) {
  return { schema: report.schema, runId: report.runId, dataset: report.dataset, scorer: report.scorer, aggregate: report.aggregate, deterministic: report.deterministic, review: report.review, aggregateOnly: true };
}

// ---- dataset loading and CLI ----------------------------------------------------------
export function loadSplit(datasetDir, split) {
  const dir = resolve(datasetDir, split);
  const manifestBytes = readFileSync(join(dir, 'integrity-manifest.json'));
  const cases = JSON.parse(manifestBytes).cases.map((entry) => {
    const labels = readFileSync(join(dir, entry.labels.path));
    if (sha(labels) !== entry.labels.sha256) throw new Error(`label hash mismatch for case ${entry.id}`);
    if (sha(readFileSync(join(dir, entry.source.path))) !== entry.source.sha256) throw new Error(`source hash mismatch for case ${entry.id}`);
    return { id: entry.id, gold: JSON.parse(labels).labels[0].expected };
  });
  return { cases, manifestSha256: sha(manifestBytes) };
}

export function main(argv = process.argv.slice(2)) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--aggregate-only') o.aggregateOnly = true;
    else if (['--dataset', '--split', '--outputs', '--review', '--review-queue', '--out', '--gold', '--output'].includes(a) && argv[i + 1]) o[a.slice(2)] = argv[++i];
    else throw new Error(`Unknown or incomplete option ${a}`);
  }
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const write = (p, v) => { mkdirSync(dirname(resolve(p)), { recursive: true }); writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`); };
  const review = o.review ? read(o.review) : null;
  let report;
  if (o.gold) {
    const labels = read(o.gold);
    report = scoreRun({ cases: [{ id: 'single', gold: labels.labels?.[0]?.expected ?? labels }], outputs: { cases: { single: read(o.output) } }, review });
  } else {
    if (!o.dataset || !o.split || !o.outputs) throw new Error('Expected --dataset <dir> --split development|heldout --outputs <file> (or --gold <file> --output <file>)');
    const { cases, manifestSha256 } = loadSplit(o.dataset, o.split);
    const outputs = read(o.outputs);
    if (outputs.split && outputs.split !== o.split) throw new Error(`outputs declare split ${outputs.split}, scoring ${o.split}`);
    report = scoreRun({ cases, outputs, review });
    report.dataset = { split: o.split, manifestSha256 };
  }
  report.scorer = { sha256: sha(readFileSync(fileURLToPath(import.meta.url))) };
  if (o['review-queue']) write(o['review-queue'], report.queue);
  const { queue: _queue, ...rest } = report;
  const printed = o.aggregateOnly ? aggregateOnly(rest) : rest;
  if (o.out) write(o.out, printed); else process.stdout.write(`${JSON.stringify(printed, null, 2)}\n`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
