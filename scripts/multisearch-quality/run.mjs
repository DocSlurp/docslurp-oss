// Gold-free runner. One request per case; no retries and no session reuse.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export async function runCases({ cases, endpoint, token, model, maxCases, execution = 'real-model', fetchImpl = fetch }) {
  if (!Number.isInteger(maxCases) || maxCases < 1 || cases.length > maxCases) throw new Error('Explicit case cap required');
  if (!['real-model', 'scripted-fault-injection'].includes(execution)) throw new Error('Unknown execution kind');
  if (!cases.length || cases.some(item => !item.id || !item.question || /\{\{[^{}]+\}\}/.test(item.question) || (item.execution && item.execution !== execution)) || new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('Unique nonempty cases matching execution kind required');
  const records = [];
  for (const item of cases) {
    const started = Date.now();
    try {
      const result = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ q: item.question, model }), signal: AbortSignal.timeout(125000) });
      const raw = await result.text();
      records.push({ id: item.id, execution, status: result.status, runtimeMs: Date.now() - started, raw });
      if (!result.ok) break;
    } catch (error) {
      records.push({ id: item.id, execution, runtimeMs: Date.now() - started, error: String(error) });
      break;
    }
  }
  return records;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [casesPath, outputPath] = process.argv.slice(2);
  if (!casesPath || !outputPath || !process.env.MULTISEARCH_ENDPOINT || !process.env.MULTISEARCH_TOKEN || !process.env.MULTISEARCH_MODEL) throw new Error('Supply cases/output and MULTISEARCH_ENDPOINT/TOKEN/MODEL/MAX_CASES');
  const cases = JSON.parse(await readFile(casesPath, 'utf8'));
  const records = await runCases({ cases, endpoint: process.env.MULTISEARCH_ENDPOINT, token: process.env.MULTISEARCH_TOKEN, model: process.env.MULTISEARCH_MODEL, maxCases: Number(process.env.MULTISEARCH_MAX_CASES), execution: process.env.MULTISEARCH_EXECUTION ?? 'real-model' });
  await writeFile(outputPath, JSON.stringify(records, null, 2) + '\n', { flag: 'wx' });
  process.exitCode = records.length === cases.length && records.every(record => !record.error && record.status === 200) ? 0 : 1;
}
