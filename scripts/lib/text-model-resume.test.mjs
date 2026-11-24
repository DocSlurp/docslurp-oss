import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textCallKey, textResumeResults } from './text-model-resume.mjs';

const experiment = { models:['vendor/model'], repeats:2, arms:[{id:'low'}] };
const provenance = { datasetSha256:'source-hash', experiment };
const expected = { ...provenance };
const row = { model:'vendor/model', arm:'low', repeat:0, caseId:'case', error:'failed' };
test('resumes unfinished calls while preserving attempted failures and repetition identity', () => {
 assert.deepEqual(textResumeResults(provenance, {results:[row,{...row,repeat:1,skipped:'budget-reservation'}]}, expected), [row]);
 assert.notEqual(textCallKey(row), textCallKey({...row, repeat:1}));
});
test('rejects changed inputs, settings and duplicate attempts rather than rerunning a comparison', () => {
 for (const changed of [{...expected,datasetSha256:'changed'}, {...expected,experiment:{...experiment,repeats:1}}]) {
  assert.throws(() => textResumeResults(provenance, {results:[row]}, changed));
 }
 assert.throws(() => textResumeResults(provenance, {results:[row,row]}, expected));
});
