import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTextExperiment } from './text-model-experiment.mjs';
const plan = () => ({version:1, models:['vendor/model'], budgetUsd:.4, concurrency:2, repeats:2, arms:[{id:'low',reasoningEffort:'low',maxOutputTokens:{'community-summary':384}}]});
test('accepts bounded runtime calibration settings', () => assert.deepEqual(validateTextExperiment(plan()),plan()));
test('rejects spend escalation, prohibited models, duplicate arms and unknown operations',()=>{
 for(const change of [{budgetUsd:4.01},{models:['openai/gpt-pro']},{arms:[{id:'a'},{id:'a'}]},{arms:[{id:'a',maxOutputTokens:{unexpected:128}}]}]) assert.throws(()=>validateTextExperiment({...plan(),...change}));
});
test('rejects unsupported reasoning and unbounded tokens or concurrency',()=>{
 for(const change of [{concurrency:5},{repeats:4},{arms:[{id:'a',reasoningEffort:'unsupported'}]},{arms:[{id:'a',workerProfile:'unknown'}]},{arms:[{id:'a',maxOutputTokens:{'document-summary':8192}}]}]) assert.throws(()=>validateTextExperiment({...plan(),...change}));
});
test('supports explicit thinking disable and bounds per-model overrides to the experiment', () => {
 const input = {...plan(), arms:[{id:'calibrated', reasoningEffort:'none', modelReasoningEfforts:{'vendor/model':'low'}}]};
 assert.deepEqual(validateTextExperiment(input), input);
 for (const modelReasoningEfforts of [{'other/model':'none'}, {'vendor/model':'unsupported'}]) {
  assert.throws(() => validateTextExperiment({...plan(), arms:[{id:'a', modelReasoningEfforts}]}));
 }
});
