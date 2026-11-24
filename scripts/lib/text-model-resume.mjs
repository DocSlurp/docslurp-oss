import assert from 'node:assert/strict';

export const textCallKey = row => JSON.stringify([row.model, row.arm, row.repeat, row.caseId]);

/** Reuse every attempted call, including failures, only under the same contract. */
export function textResumeResults(provenance, summary, expected) {
 assert.equal(provenance.datasetSha256, expected.datasetSha256, 'Resume dataset changed');
 assert.deepEqual(provenance.experiment, expected.experiment, 'Resume experiment changed');
 const results = summary.results.filter(row => !row.skipped);
 const keys = results.map(textCallKey);
 assert.equal(new Set(keys).size, keys.length, 'Duplicate attempted calls in resume evidence');
 return results;
}
