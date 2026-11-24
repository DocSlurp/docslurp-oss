import assert from 'node:assert/strict';

const operations = new Set(['document-summary', 'proposition-extraction', 'structured-extraction', 'graph-extraction', 'community-summary', 'contextual-chunk-preamble']);
const efforts = ['none', 'low', 'medium', 'high', 'max'];
export function validateTextExperiment(input) {
 assert(input && input.version === 1, 'Expected experiment version 1');
 assert(Array.isArray(input.models) && input.models.length && new Set(input.models).size === input.models.length);
 assert(input.models.every(id => typeof id === 'string' && /^[\w.-]+\/[\w.:-]+$/.test(id) && !/(?:^|[-_/])(?:pro|ultra)(?:$|[-_/])/i.test(id)), 'Invalid/prohibited model ID');
 assert(Number.isFinite(input.budgetUsd) && input.budgetUsd > 0 && input.budgetUsd <= 4, 'Budget must be between zero and $4');
 assert(Number.isInteger(input.concurrency) && input.concurrency >= 1 && input.concurrency <= 4);
 assert(Number.isInteger(input.repeats) && input.repeats >= 1 && input.repeats <= 3);
 assert(Array.isArray(input.arms) && input.arms.length && new Set(input.arms.map(a => a.id)).size === input.arms.length);
 for (const arm of input.arms) {
  assert(typeof arm.id === 'string' && /^[\w-]+$/.test(arm.id));
  assert(arm.reasoningEffort === undefined || efforts.includes(arm.reasoningEffort));
  for (const [model, effort] of Object.entries(arm.modelReasoningEfforts ?? {})) {
   assert(input.models.includes(model) && efforts.includes(effort), 'Invalid model reasoning override');
  }
  assert(arm.workerProfile === undefined || ['provider-default', 'grounded-low'].includes(arm.workerProfile), 'Unknown worker profile');
  assert(arm.systemSuffix === undefined || (typeof arm.systemSuffix === 'string' && arm.systemSuffix.length <= 4000));
  for (const [operation, suffix] of Object.entries(arm.systemSuffixes ?? {})) {
   assert(operations.has(operation) && typeof suffix === 'string' && suffix.length <= 4000, 'Invalid task instruction');
  }
  for (const [operation, cap] of Object.entries(arm.maxOutputTokens ?? {})) {
   assert(operations.has(operation), 'Unknown pipeline operation');
   assert(Number.isInteger(cap) && cap >= 1 && cap <= 4096, 'Invalid output token limit');
  }
 }
 return input;
}
