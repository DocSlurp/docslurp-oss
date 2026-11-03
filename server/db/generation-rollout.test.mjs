import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertGenerationRollout } from './generation-rollout.mjs';
const attestation = { GENERATION_ROLLOUT_DRAINED: 'all-executions-and-activities-stopped' };
function client(schema = { existing: true, migrated: false }, barrier = { closed: true, migrator_superuser: true, alone: true }, unfinished = false) {
  const answers = [schema, barrier, { unfinished }];
  return { query: async () => ({ rows: [answers.shift()] }) };
}
test('existing installation refuses implicit live migration', async () => {
  await assert.rejects(assertGenerationRollout(client(), {}), /attestation missing/);
});
for (const key of ['closed', 'migrator_superuser', 'alone']) {
  test(`refuses unsafe database barrier: ${key}`, async () => {
    await assert.rejects(assertGenerationRollout(client(undefined, { closed: true, migrator_superuser: true, alone: true, [key]: false }), attestation), /CONNECTION LIMIT 0/);
  });
}
test('refuses queued or otherwise unfinished SQL runs despite attestation', async () => {
  await assert.rejects(assertGenerationRollout(client(undefined, undefined, true), attestation), /unfinished SQL runs/);
});
test('permits drained transition behind database barrier', async () => {
  await assertGenerationRollout(client(), attestation);
});
test('fresh installs and subsequent migrations need no rollout override', async () => {
  await assertGenerationRollout(client({ existing: false, migrated: false }), {});
  await assertGenerationRollout(client({ existing: true, migrated: true }), {});
});
