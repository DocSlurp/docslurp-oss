// Local deterministic scorer: no model, network, hosted storage, or hidden reference in candidate input.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const { createScorer } = await import(pathToFileURL(require.resolve('@mastra/core/evals')).href);
export const mixedPageScorer = createScorer({
  id: 'mixed-page-text-preservation-v4',
  description: 'Textual preservation diagnostics; formula ownership requires separate region-grounded evidence before routing-policy promotion.',
}).preprocess(({ run }) => {
  const child = spawnSync(process.env.MIXED_PDF_PYTHON, [fileURLToPath(new URL('./score_one.py', import.meta.url)), '--scorers', process.env.MIXED_PDF_SCORERS], {
    input: JSON.stringify({ reference: run.input.reference, text: run.output.text }), encoding: 'utf8', timeout: 30_000,
  });
  if (child.status !== 0) throw new Error(`Mixed scorer failed: ${child.stderr}`);
  return JSON.parse(child.stdout);
}).generateScore(({ results }) => results.preprocessStepResult.quality)
  .generateReason(({ results }) => JSON.stringify(results.preprocessStepResult));

if (process.argv[2]) {
  const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const result = await mixedPageScorer.run({ input: { reference: request.reference }, output: { text: request.text } });
  console.log(JSON.stringify(result));
}
