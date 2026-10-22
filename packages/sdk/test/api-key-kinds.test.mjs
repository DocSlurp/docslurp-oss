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

test('server keys throw before any browser request; only public keys are allowed', async () => {
  globalThis.window = globalThis; globalThis.document = {};
  try {
    let fetched = false;
    const fetch = async () => { fetched = true; return Response.json({}); };
    assert.throws(() => createDocSlurpClient({ apiKey: priv, fetch }), UnsafeApiKeyError);
    assert.throws(() => createDocSlurpMeilisearchClient({ apiUrl: 'https://example.test', clientKey: priv, fetch }), UnsafeApiKeyError);
    assert.equal(fetched, false);
    assert.doesNotThrow(() => createDocSlurpClient({ apiKey: pub, fetch }));
    assert.throws(() => createDocSlurpMeilisearchClient({ apiUrl: 'https://example.test', clientKey: 'dslp_legacy', fetch }), UnsafeApiKeyError);
  } finally {
    delete globalThis.window; delete globalThis.document;
  }
});

test('rejects insecure remote API origins before sending credentials', () => {
  for (const apiUrl of ['http://example.test', 'http://10.0.0.1', 'ftp://example.test']) {
    assert.throws(() => createDocSlurpClient({ apiUrl, apiKey: priv }), /HTTPS/);
  }
  assert.doesNotThrow(() => createDocSlurpClient({ apiUrl: 'http://127.0.0.1:8787', apiKey: priv }));
  assert.throws(() => assertBrowserSafeApiKey(priv, true), UnsafeApiKeyError);
  assert.throws(() => assertBrowserSafeApiKey('dslp_legacy', true), UnsafeApiKeyError);
});
