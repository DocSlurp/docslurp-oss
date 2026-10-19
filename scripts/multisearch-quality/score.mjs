/** Deterministic screening only; semantic correctness still needs independent review. */
export function scoreCase(gold, response, documents) {
  const answer = response.answer ?? '';
  const citations = response.citations ?? [];
  const markers = [...answer.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
  const cited = markers.map(n => citations[n - 1]);
  const pages = c => [...new Set([c.citation.pageNumber, ...(c.citation.pageNumbers ?? [])].filter(page => page !== null && page !== undefined))];
  const validCitation = c => c && documents[c.citation?.documentId]?.pages && pages(c).length > 0 && pages(c).every(page => documents[c.citation.documentId].pages.includes(page));
  const citedKeys = new Set(cited.filter(validCitation).flatMap(c => pages(c).map(page => `${documents[c.citation.documentId].sourceId}:${page}`)));
  const calls = response.debug?.toolCalls ?? [];
  const searches = calls.filter(c => c.name === 'workspace.search' && c.status === 'success');
  const checks = {
    answer: (gold.requiredPatterns ?? []).every(p => new RegExp(p, 'i').test(answer)),
    forbidden: !(gold.forbiddenPatterns ?? []).some(p => new RegExp(p, 'i').test(answer)),
    abstention: !gold.abstain || /cannot determine|can't determine|insufficient|not (?:stated|provided|specified)|ambiguous|conflict|contradict/i.test(answer),
    citationIdentity: cited.every(validCitation),
    premises: (gold.premises ?? []).every(key => citedKeys.has(key)),
    actualSearches: searches.length >= (gold.minSearchCalls ?? 1),
    bounded: calls.length <= 12,
  };
  return { id: gold.id, pass: Object.values(checks).every(Boolean), checks, successfulSearchCalls: searches.length };
}

// Keep this process separate from the runner: only an independent scorer opens gold.
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const [goldPath, recordsPath, documentsPath, outputPath] = process.argv.slice(2);
  if (!outputPath) throw new Error('Usage: score.mjs gold.json records.json documents.json output.json');
  const read = async path => JSON.parse(await readFile(path, 'utf8'));
  const gold = await read(goldPath), records = await read(recordsPath), documents = await read(documentsPath);
  const scored = gold.map(g => {
    const record = records.find(r => r.id === g.id);
    if (!record || record.error || record.status !== 200) return { id: g.id, pass: false, failure: record?.error ?? `HTTP ${record?.status ?? 'missing'}` };
    try { return scoreCase(g, JSON.parse(record.raw), documents); }
    catch (error) { return { id: g.id, pass: false, failure: String(error) }; }
  });
  await writeFile(outputPath, JSON.stringify({ passed: scored.filter(r => r.pass).length, total: scored.length, cases: scored }, null, 2) + '\n', { flag: 'wx' });
}
