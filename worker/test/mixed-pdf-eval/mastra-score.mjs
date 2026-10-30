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

export const mathEncodingScorer = createScorer({
  id: 'math-encoding-equivalence-v1',
  description: 'Structural equivalence across supported math encodings; occurrence ownership and visibility require separate evidence.',
}).preprocess(({ run }) => {
  if (!process.env.MIXED_PDF_PYTHON) throw new Error('Set MIXED_PDF_PYTHON for the local math scorer');
  const child = spawnSync(process.env.MIXED_PDF_PYTHON, [fileURLToPath(new URL('./score_math.py', import.meta.url))], {
    input: JSON.stringify({
      reference: run.input.reference,
      candidate: run.output.text,
      referenceEncoding: run.input.referenceEncoding ?? 'auto',
      candidateEncoding: run.output.candidateEncoding ?? 'auto',
    }),
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1_048_576,
  });
  if (child.error || child.status !== 0) throw new Error(`Math scorer failed: ${child.error?.message ?? child.stderr}`);
  return JSON.parse(child.stdout);
}).generateScore(({ results }) => {
  const result = results.preprocessStepResult;
  if (result.score === null) throw new Error(`Unscorable math encoding: ${JSON.stringify(result.pairs.map(pair => pair.issues))}`);
  return result.score;
}).generateReason(({ results }) => JSON.stringify(results.preprocessStepResult));

if (process.argv[2]) {
  const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (request.mode && !['page', 'math'].includes(request.mode)) throw new Error('Unknown scorer mode');
  const scorer = request.mode === 'math' ? mathEncodingScorer : mixedPageScorer;
  const result = await scorer.run({
    input: { reference: request.reference, referenceEncoding: request.referenceEncoding },
    output: { text: request.text, candidateEncoding: request.candidateEncoding },
  });
  console.log(JSON.stringify(result));
}
