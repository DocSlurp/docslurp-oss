import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyKind, assertBrowserSafeApiKey, createDocSlurpClient, UnsafeApiKeyError } from '../dist/index.js';
import { createDocSlurpMeilisearchClient } from '../dist/search-adapters.js';

const pub = 'dslp_pub_' + 'a'.repeat(64);
const priv = 'dslp_priv_' + 'b'.repeat(64);

test('classifies keys by prefix, keeping legacy keys usable', () => {
  assert.equal(apiKeyKind(pub), 'public');
  assert.equal(apiKeyKind(priv), 'private');
  assert.equal(apiKeyKind('dslp_' + 'c'.repeat(64)), 'legacy');
});

test('server keys are allowed on the server', () => {
  assert.doesNotThrow(() => assertBrowserSafeApiKey(priv));
  assert.doesNotThrow(() => createDocSlurpClient({ apiKey: priv }));
});

test('server keys throw before any browser request; public and legacy keys do not', async () => {
  globalThis.window = globalThis; globalThis.document = {};
  try {
    let fetched = false;
    const fetch = async () => { fetched = true; return Response.json({}); };
    assert.throws(() => createDocSlurpClient({ apiKey: priv, fetch }), UnsafeApiKeyError);
    assert.throws(() => createDocSlurpMeilisearchClient({ apiUrl: 'https://example.test', clientKey: priv, fetch }), UnsafeApiKeyError);
    assert.equal(fetched, false);
    assert.doesNotThrow(() => createDocSlurpClient({ apiKey: pub, fetch }));
    assert.doesNotThrow(() => createDocSlurpMeilisearchClient({ apiUrl: 'https://example.test', clientKey: 'dslp_legacy', fetch }));
  } finally {
    delete globalThis.window; delete globalThis.document;
  }
});
