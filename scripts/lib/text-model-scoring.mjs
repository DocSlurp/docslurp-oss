const normalized = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\b(days|hours|minutes|seconds|months|years)\b/g, unit => unit.slice(0, -1)).trim();
const negativePredicate = predicate => /\bnot\b|\bdenied\b|\brumor\b|\bunconfirmed\b/i.test(normalized(predicate));
function objectFrom(text) {
 const start = text.indexOf('{'), end = text.lastIndexOf('}');
 if (start < 0 || end <= start) return null;
 try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
function equivalent(actual, expected) {
 if (expected === null) return actual === null || /^(?:null|not specified|unspecified|unknown|not provided|no .* (?:specified|provided|given)|not .* (?:specified|provided)|not applicable|n\/a)$/i.test(String(actual));
 if (typeof expected === 'number') return Number(String(actual).replace(/[^0-9.-]/g,'')) === expected;
 return normalized(actual) === normalized(expected);
}
export function scoreTextCase(fixture, text) {
 let correct = 0, total = 0, criticalError = false, formatValid = true, criticalPatternMatch = false;
 const output = normalized(text);
 if (fixture.format === 'structured') {
  const parsed = objectFrom(text);
  const fields = parsed?.fields ?? parsed;
  formatValid = Boolean(parsed?.fields);
  for (const [key, expected] of Object.entries(fixture.gold)) {
   total++;
   const field = fields?.[key];
   let actual = field && typeof field === 'object' && 'value' in field ? field.value : field;
   // Effectively correct labeled text counts even when the JSON envelope fails.
   if (actual === undefined) {
    const match = text.match(new RegExp(`(?:"|\\b)${key}(?:"|\\b)\\s*[:=]\\s*(?:\\{\\s*"value"\\s*:\\s*)?("[^"\\n]*"|null|[-\\d.]+)`, 'i'));
    if (match) { try { actual = JSON.parse(match[1]); } catch { actual = match[1]; } }
   }
   if (actual !== undefined && equivalent(actual, expected)) correct++;
  }
 } else if (fixture.format === 'graph') {
  const parsed = objectFrom(text);
  const relations = parsed?.relationships;
  formatValid = Array.isArray(parsed?.entities) && Array.isArray(relations);
  const edges = Array.isArray(relations) ? relations : [];
  for (const [subject, object] of fixture.links) {
   total++;
   if (edges.some(e => normalized(e.subject) === normalized(subject) && normalized(e.object) === normalized(object)
       && !negativePredicate(e.predicate))) correct++;
  }
  const [subject, object] = fixture.deniedLink;
  criticalError = edges.some(e => normalized(e.subject) === normalized(subject) && normalized(e.object) === normalized(object)
    && !negativePredicate(e.predicate));
 } else {
  for (const alternatives of fixture.facts) {
   total++;
   if (alternatives.some(value => output.includes(normalized(value)))) correct++;
  }
  // Lexical matches are review candidates: quoting a malicious note or
  // negating a claim is not an assertion. Do not zero quality from a substring.
  criticalPatternMatch = (fixture.banned ?? []).some(alternatives => alternatives.some(value => output.includes(normalized(value))));
  if (fixture.format === 'sentence') formatValid = text.length <= 420 && !/^\s*[-#*]/m.test(text) && !/\n\s*\n/.test(text);
 }
 const coverage = total ? correct / total : 0;
 return { quality: criticalError ? 0 : coverage, coverage, correct, total, criticalError, criticalPatternMatch, formatValid, empty: !text.trim(),
   usable: Boolean(text.trim()) && coverage >= .8 && !criticalError };
}
const percentile = (values, q) => {
 const sorted = [...values].sort((a,b) => a-b);
 return sorted[Math.max(0, Math.ceil(sorted.length*q)-1)] ?? null;
};
export function summarizeTextResults(results) {
 const groups = new Map();
 for (const r of results) {
  if (r.skipped) continue;
  const key = `${r.arm}:${r.model}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
 }
 return [...groups].map(([key, rows]) => {
  const times = rows.map(r => r.latencyMs).filter(Number.isFinite);
  const providerCosts = rows.filter(r => r.usage?.metadata?.costSource === 'provider');
  const costUsd = providerCosts.reduce((sum,r) => sum+(r.usage.costCents ?? 0)/100,0);
  const successes = rows.filter(r => r.scores?.usable).length;
  const facts = rows.reduce((sum,r) => sum+(r.scores?.total ?? 0),0);
  const correct = rows.reduce((sum,r) => sum+(r.scores?.criticalError ? 0 : r.scores?.correct ?? 0),0);
  return { key, model: rows[0].model, arm: rows[0].arm, calls: rows.length, qualityMacro: rows.reduce((sum,r) => sum+(r.scores?.quality ?? 0),0)/rows.length,
   labeledFactAccuracy: facts ? correct/facts : 0, usable: successes, empty: rows.filter(r => r.scores?.empty).length, errors: rows.filter(r => r.error).length,
   formatValid: rows.filter(r => r.scores?.formatValid).length, medianLatencyMs: percentile(times,.5), p90LatencyMs: percentile(times,.9),
   lengthLimited: rows.filter(r => r.finishReason === 'length').length,
   costUsd, providerCostCalls: providerCosts.length, inputTokens: rows.reduce((s,r)=>s+(r.usage?.inputTokens ?? 0),0), outputTokens: rows.reduce((s,r)=>s+(r.usage?.outputTokens ?? 0),0),
   costPerUsableUsd: successes && providerCosts.length === rows.length ? costUsd/successes : null,
   byTask: Object.fromEntries([...new Set(rows.map(r=>r.operation))].map(task => {
    const slice=rows.filter(r=>r.operation===task);
    return [task,{calls:slice.length,quality:slice.reduce((s,r)=>s+(r.scores?.quality ?? 0),0)/slice.length,usable:slice.filter(r=>r.scores?.usable).length}];
   })) };
 });
}
