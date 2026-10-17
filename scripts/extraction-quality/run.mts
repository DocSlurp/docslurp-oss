/** Synthetic quality screening of the actual worker generation paths, not ingestion throughput. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { judgeIntegrity } from '../evaluation-integrity-judge.mjs';
import { defaultGraphConfig, resolveOpenRouterUsage, type TextGenerationConfig } from '../../packages/shared/src/index.ts';
import { extractDocumentGraph } from '../../worker/src/graph/extract.ts';
import { DocumentSummaryStage } from '../../worker/src/stages/document-summary.ts';
import { PropositionIndexStage } from '../../worker/src/stages/proposition-index.ts';
import { fromEnv } from '../../worker/src/config.ts';
import { PipelineUsageEventLedger } from '../../worker/src/pipeline/usage-ledger.ts';
import { persistScopedUsageEvents } from '../../worker/src/db/usage-event-store.ts';
import { assertCanSpend } from '../../server/src/services/billing/spend-guard.ts';
import { attributedUsage } from '../../server/src/services/usage-attribution.ts';
import { sql } from '../../server/src/db.ts';

const arg = (key: string, fallback = '') => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1] ?? ''; };
const required = (key: string) => { const value = arg(key); if (!value) throw Error(`Missing ${key}`); return value; };
const dataset = resolve(required('--dataset'));
const destination = resolve(required('--out'));
const model = required('--model');
const arm = required('--arm');
const scope = { orgId: required('--org'), workspaceId: required('--workspace') };
const userId = required('--user');
const experiment = 'extraction-quality-20261017';
const budgetCents = Number(arg('--budget-cents', '986'));
const limit = Number(arg('--limit', '100'));
const repeat = Number(arg('--repeat', '1'));
const operations = arg('--operations', 'graph,points,summary').split(',');
const generation = JSON.parse(arg('--generation', '{}')) as TextGenerationConfig;
const config = fromEnv();
const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
if (!apiKey || !Number.isFinite(budgetCents) || budgetCents <= 0 || budgetCents > 986) throw Error('Missing key or invalid bounded budget');
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 2 || !Number.isInteger(limit) || limit < 1) throw Error('Invalid sample bounds');
if (operations.some(op => !['graph', 'points', 'summary'].includes(op))) throw Error('Unknown operation');
if (/(^|[-/])(pro|ultra)([-/]|$)/i.test(model)) throw Error('Pro/Ultra models prohibited');
config.openRouterApiKey = apiKey;

// Read source text only. Labels are handled by the independent integrity/scoring tools.
await mkdir(destination, { recursive: false });
const integrity = judgeIntegrity({ dataset, repo: process.cwd(), base: 'HEAD' });
await writeFile(resolve(destination, 'integrity.json'), JSON.stringify(integrity, null, 2));
if (!integrity.passed) throw Error('Integrity screening failed; inspect separately before any provider call');
const manifest = JSON.parse(await readFile(resolve(dataset, 'integrity-manifest.json'), 'utf8'));
const catalogResponse = await fetch('https://openrouter.ai/api/v1/models');
if (!catalogResponse.ok) throw Error('Cannot verify live model pricing');
const catalog = await catalogResponse.json() as any;
const selected = catalog.data?.find((m: any) => m.id === model);
const inputPrice = Number(selected?.pricing?.prompt);
const outputPrice = Number(selected?.pricing?.completion);
if (!selected || !Number.isFinite(inputPrice) || !Number.isFinite(outputPrice) || outputPrice * 1e6 >= 50) throw Error('Model missing verified affordable pricing');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['diff', '--', 'worker/src', 'packages/shared/src'], { encoding: 'utf8' });
if (dirty.trim()) throw Error('Commit candidate production changes before measurement');
await writeFile(resolve(destination, 'run.json'), JSON.stringify({ at: new Date().toISOString(), experiment, arm, source, model, generation, operations, repeat, datasetHash: integrity.datasetHash, productionHash: integrity.productionHash, runtime: process.version, pricing: { inputPerMillion: inputPrice * 1e6, outputPerMillion: outputPrice * 1e6 }, scope, budgetCents, boundary: 'worker generation only; excludes ingestion, embeddings and storage' }, null, 2));

// Retain provider responses for synthetic inputs only. Never capture request headers or credentials.
const originalFetch = globalThis.fetch;
let receipts: any[] = [];
globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.startsWith('https://openrouter.ai/api/v1/') && /\/(chat\/completions|responses)$/.test(url) && response.ok) {
    try { receipts.push(await response.clone().json()); } catch { throw Error('Provider receipt capture failed'); }
  }
  return response;
};

const outputs: any[] = [];
// These private methods are called reflectively only in this eval harness. No fake product prompt is substituted.
const summaryStage = new DocumentSummaryStage(undefined as never, undefined as never, config);
const pointStage = new PropositionIndexStage(undefined as never, undefined as never, config);
const summaryMethod = Reflect.get(summaryStage, 'generateSummary');
const pointMethod = Reflect.get(pointStage, 'atomizeParagraphs');
if (typeof summaryMethod !== 'function' || typeof pointMethod !== 'function') throw Error('Worker generation seam changed; repair harness and rebaseline');

try {
  for (let repetition = 0; repetition < repeat; repetition++) for (const entry of manifest.cases.slice(0, limit)) {
    const text = await readFile(resolve(dataset, entry.source.path), 'utf8');
    if (createHash('sha256').update(text).digest('hex') !== entry.source.sha256) throw Error('Source changed after integrity check');
    const item: any = { id: entry.id, repetition, graph: null, keyPoints: [], summary: '', stages: {} };
    for (const operation of operations) {
      const [spend] = await sql`select coalesce(sum(cost_cents),0)::double precision as cents from ${attributedUsage(null, sql)} au where org_id=${scope.orgId} and metadata->>'experiment'=${experiment}`;
      // Conservative reservation for up to four windows and reasoning/output allowance.
      const possiblePointBatches = operation === 'points' ? Math.max(1, text.split(/\n\n+/).filter((p: string) => p.trim().length >= 100).length) : 1;
      const reservationCents = ((text.length + 10_000 * possiblePointBatches) * inputPrice + Math.max(32_768, possiblePointBatches * 4096) * outputPrice) * 100 * 2;
      if (spend.cents + reservationCents >= budgetCents) throw Error('Experiment budget reservation exceeded');
      await assertCanSpend(scope.orgId, scope.workspaceId, { hold: false });
      receipts = [];
      const ledger = new PipelineUsageEventLedger();
      const started = performance.now();
      let failure: string | undefined;
      try {
        if (operation === 'graph') {
          const graph = await extractDocumentGraph({ filename: 'document.txt', chunks: text.split('\f').map((chunk: string, i: number) => ({ id: `source-${i}`, text: chunk, pageNumber: i + 1 })), context: { config: { ...defaultGraphConfig, depth: 'standard' }, scope: 'Workspace documents', model, apiKey, useLlm: true, privacyMode: 'standard', textGeneration: generation, deploymentProfile: config.textGenerationProfile, onUsage: () => {} } });
          const names = new Map(graph.nodes.map(n => [n.key, n.canonicalName]));
          item.graph = { entities: graph.nodes.map(n => ({ id: n.key, name: n.canonicalName, aliases: n.aliases })), relationships: graph.edges.filter(e => e.normalizedPredicate !== 'comentions').map(e => ({ source: names.get(e.sourceKey), predicate: e.predicate, target: names.get(e.targetKey) })), source: graph.source, windows: graph.windows };
        } else if (operation === 'summary') {
          const result = await summaryMethod.call(summaryStage, text, model, 'standard', undefined, generation);
          item.summary = result.text;
        } else {
          // Match the production stage's paragraph filtering and batch limits.
          const paragraphs = text.split(/\n\n+/).map((p: string) => p.trim()).filter((p: string) => p.length >= 100);
          const batches: string[][] = []; let batch: string[] = []; let length = 0;
          for (const paragraph of paragraphs) { if (batch.length && length + paragraph.length > 3000) { batches.push(batch); batch = []; length = 0; } batch.push(paragraph); length += paragraph.length; }
          if (batch.length) batches.push(batch);
          item.pointSources = [];
          for (const group of batches) { const result = await pointMethod.call(pointStage, group, model, 'standard', undefined, generation); result.groups.forEach((points: string[], i: number) => { item.keyPoints.push(...points); item.pointSources.push(...points.map((point: string) => ({ point, sourceParagraph: group[i] }))); }); }
          item.filteredParagraphs = text.split(/\n\n+/).filter((p: string) => p.trim() && p.trim().length < 100).length;
        }
      } catch (error) { failure = error instanceof Error ? error.name : 'UnknownError'; }
      finally {
        // Save raw evidence before accounting so an accounting outage cannot erase receipts.
        await writeFile(resolve(destination, `${entry.id}-${repetition}-${operation}-raw.json`), JSON.stringify(receipts, null, 2));
        for (const receipt of receipts) {
          if (!receipt.usage) throw Error('Successful generation has no usage receipt; stop before next call');
          const inputTokens = receipt.usage.prompt_tokens ?? receipt.usage.input_tokens;
          const outputTokens = receipt.usage.completion_tokens ?? receipt.usage.output_tokens;
          if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) throw Error('Missing actual token counts in retained receipt');
          const usage = await resolveOpenRouterUsage({ apiKey, model, providerName: receipt.provider, generationId: receipt.id, usage: { inputTokens, outputTokens, raw: receipt.usage } });
          if (usage.costCents === undefined) throw Error('Missing usage cost; retained receipt requires reconciliation');
          ledger.record({ provider: 'openrouter', model, metric: `quality-${operation}`, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costCents: usage.costCents, metadata: { ...usage.metadata, experiment, arm, operation, caseId: entry.id, repetition, source } });
        }
        const checkpoint = ledger.checkpoint();
        await persistScopedUsageEvents({ client: sql, userId, scope, usageEvents: checkpoint.events, debitMetadata: { experiment, arm } });
        checkpoint.commit();
        item.stages[operation] = { ms: performance.now() - started, error: failure, usage: ledger.totals(), calls: receipts.length, finishReasons: receipts.map(r => r.choices?.[0]?.finish_reason) };
      }
      if (failure) item.errors = [...(item.errors ?? []), operation];
    }
    outputs.push(item);
    await writeFile(resolve(destination, 'outputs.json'), JSON.stringify(outputs, null, 2));
    console.log(JSON.stringify({ arm, caseId: entry.id, repetition, stages: item.stages, graphSource: item.graph?.source, points: item.keyPoints.length, summaryChars: item.summary.length }));
  }
} finally { globalThis.fetch = originalFetch; await sql.end({ timeout: 2 }); }
