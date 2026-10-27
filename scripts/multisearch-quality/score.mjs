/** Deterministic screening only; semantic correctness still needs independent review. */
export function scoreCase(gold, response, documents) {
  const answer = typeof response.answer === 'string' ? response.answer : '';
  const citations = Array.isArray(response.citations) ? response.citations : [];
  const markers = [...answer.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
  const cited = markers.map(n => citations[n - 1]);
  const pages = c => [...new Set([c.citation.pageNumber, ...(c.citation.pageNumbers ?? [])].filter(page => page !== null && page !== undefined))];
  const validCitation = c => c && documents[c.citation?.documentId]?.pages && pages(c).length > 0 && pages(c).every(page => documents[c.citation.documentId].pages.includes(page));
  const citedKeys = new Set(cited.filter(validCitation).flatMap(c => pages(c).map(page => `${documents[c.citation.documentId].sourceId}:${page}`)));
  const calls = Array.isArray(response.debug?.toolCalls) ? response.debug.toolCalls : [];
  const searches = calls.filter(c => c.name === 'search' && c.status === 'success');
  const checks = {
    answer: (gold.requiredPatterns ?? []).every(p => new RegExp(p, 'i').test(answer)),
    forbidden: !(gold.forbiddenPatterns ?? []).some(p => new RegExp(p, 'i').test(answer)),
    abstention: !gold.abstain || /cannot determine|can't determine|insufficient|not (?:stated|provided|specified)|ambiguous|conflict|contradict|not available|unavailable|cannot access/i.test(answer),
    citationIdentity: cited.every(validCitation),
    premises: (gold.premises ?? []).every(key => citedKeys.has(key)),
    // A claim must cite its own source/page, not just any valid citation elsewhere.
    claimAttribution: (!gold.requireCitationBindings || Boolean(gold.citationBindings?.length)) && (gold.citationBindings ?? []).every(binding => {
      const matches = [...answer.matchAll(new RegExp(binding.pattern, 'gi'))];
      return matches.length > 0 && matches.every(match => {
        const selected = [...match[0].matchAll(/\[(\d+)\]/g)].map(marker => citations[Number(marker[1]) - 1]);
        if (!selected.length || !selected.every(validCitation)) return false;
        const keys = new Set(selected.flatMap(c => pages(c).map(page => `${documents[c.citation.documentId].sourceId}:${page}`)));
        const locatorMatches = (locator, citation) => documents[citation.citation.documentId].sourceId === locator.sourceId
          && pages(citation).includes(locator.page)
          && (locator.chunkIndex === undefined || citation.citation.chunkIndex === locator.chunkIndex)
          && (locator.headingPath === undefined || JSON.stringify(citation.citation.headingPath) === JSON.stringify(locator.headingPath));
        const locators = binding.locators;
        return binding.sources.every(key => keys.has(key)) && [...keys].every(key => binding.sources.includes(key))
          && (!locators || (locators.every(locator => selected.some(c => locatorMatches(locator, c)))
            && selected.every(c => locators.some(locator => locatorMatches(locator, c)))));
      });
    }),
    toolTrace: !gold.requireToolTrace || Array.isArray(response.debug?.toolCalls),
    actualSearches: searches.length >= (gold.minSearchCalls ?? 1),
    searchLimit: gold.maxSearchCalls === undefined || calls.filter(c => c.name === 'search').length <= gold.maxSearchCalls,
    requiredTools: Object.entries(gold.requiredToolCalls ?? {}).every(([name, minimum]) => calls.filter(c => c.name === name && c.status === 'success').length >= minimum),
    forbiddenTools: !calls.some(c => (gold.forbiddenTools ?? []).includes(c.name)),
    // An adapter failure cannot become a successful answer, even if prose sounds plausible.
    failedToolsBlock: calls.every(c => typeof c?.name === 'string' && c.status === 'success' && !c.errorCode),
    noErrorEnvelope: !response.error,
    bounded: calls.length <= (gold.maxToolCalls ?? 12),
  };
  return { id: gold.id, pass: Object.values(checks).every(Boolean), checks, successfulSearchCalls: searches.length };
}

export function scoreRecords(gold, records, documents) {
  if (!Array.isArray(gold) || !gold.length || !Array.isArray(records)) throw new Error('Nonempty gold array and records array required');
  if (gold.some(g => typeof g.id !== 'string' || !g.id || (g.execution && !['real-model', 'scripted-fault-injection'].includes(g.execution)) || [g.minSearchCalls, g.maxSearchCalls, g.maxToolCalls, ...Object.values(g.requiredToolCalls ?? {})].some(n => n !== undefined && (!Number.isInteger(n) || n < 0)))) throw new Error('Invalid case identity, execution kind or tool-call bound');
  if (gold.some(g => g.citationBindings !== undefined && (!Array.isArray(g.citationBindings) || g.citationBindings.some(b => typeof b.pattern !== 'string' || !b.pattern || !Array.isArray(b.sources) || !b.sources.length || b.sources.some(source => typeof source !== 'string' || !source))))) throw new Error('Invalid claim citation bindings');
  if (gold.some(g => (g.citationBindings ?? []).some(b => b.locators !== undefined && (!Array.isArray(b.locators) || !b.locators.length || b.locators.some(l => !l || typeof l.sourceId !== 'string' || !Number.isInteger(l.page) || l.page < 1 || (l.chunkIndex !== undefined && (!Number.isInteger(l.chunkIndex) || l.chunkIndex < 0)) || (l.headingPath !== undefined && (!Array.isArray(l.headingPath) || l.headingPath.some(h => typeof h !== 'string')))))))) throw new Error('Invalid claim evidence locators');
  if (new Set(gold.map(g => g.id)).size !== gold.length) throw new Error('Duplicate gold case id');
  const ids = new Set(gold.map(g => g.id));
  const unexpectedRecords = records.filter(r => !ids.has(r.id)).map(r => r.id);
  const duplicates = records.filter((r, i) => records.findIndex(other => other.id === r.id) !== i).map(r => r.id);
  const scored = gold.map(g => {
    const record = records.find(r => r.id === g.id);
    const execution = record?.execution ?? 'unclassified';
    const fail = failure => ({ id: g.id, execution, pass: false, failure });
    if (!record || record.error) return fail(record?.error ?? 'Missing case');
    if (g.execution && g.execution !== execution) return fail(`Expected ${g.execution} evidence, received ${execution}`);
    if (record.status !== (g.expectedStatus ?? 200)) return fail(`HTTP ${record.status ?? 'missing'}`);
    try {
      const response = JSON.parse(record.raw);
      if (record.status !== 200) {
        const checks = {
          nativeError: typeof g.expectedErrorCode === 'string' && response.error?.code === g.expectedErrorCode && typeof response.error?.message === 'string' && response.error.message.length > 0,
          noSuccessAnswer: !response.answer && !(response.citations?.length) && response.applied !== true,
        };
        return { id: g.id, execution, pass: Object.values(checks).every(Boolean), checks };
      }
      return { ...scoreCase(g, response, documents), execution };
    } catch (error) { return fail(String(error)); }
  });
  const byExecution = Object.fromEntries([...new Set(scored.map(r => r.execution))].map(kind => {
    const rows = scored.filter(r => r.execution === kind);
    return [kind, { passed: rows.filter(r => r.pass).length, total: rows.length }];
  }));
  return { pass: scored.every(r => r.pass) && !unexpectedRecords.length && !duplicates.length, passed: scored.filter(r => r.pass).length, total: scored.length, byExecution, unexpectedRecords, duplicateRecords: duplicates, cases: scored };
}

// Keep this process separate from the runner: only an independent scorer opens gold.
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const [goldPath, recordsPath, documentsPath, outputPath] = process.argv.slice(2);
  if (!outputPath) throw new Error('Usage: score.mjs gold.json records.json documents.json output.json');
  const read = async path => JSON.parse(await readFile(path, 'utf8'));
  const result = scoreRecords(await read(goldPath), await read(recordsPath), await read(documentsPath));
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.exitCode = result.pass ? 0 : 1;
}
