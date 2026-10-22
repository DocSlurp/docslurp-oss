import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlDocs, decodeCloudflareEmails, extractDoc, indexDocs, docFilename } from './index-docs.mjs';

test('indexes rendered main content with code and headings, excluding navigation, scripts and search', () => {
  const doc = extractDoc('<title>SDK</title><main><aside>Nav</aside><article><h1>SDK</h1><pre><code>const x = &lt;value&gt;;\nawait x();</code></pre></article><script>private</script><docslurp-docs-search data-client-key="test">Search</docslurp-docs-search></main>');
  assert.match(doc.html, /<h1>SDK<\/h1>/);
  assert.match(doc.html, /await x\(\)/);
  assert.doesNotMatch(doc.html, /Nav|private|client-key/);
  assert.throws(() => extractDoc('<body>Missing main</body>'));
  const guide = extractDoc('<main><h2><span class="n" data-search-exclude>3</span>Usage</h2><section id="x" data-search-exclude><h2>Hand off</h2><p>boilerplate</p></section><p>kept</p></main>');
  assert.match(guide.html, /<h2>Usage<\/h2>/);
  assert.doesNotMatch(guide.html, /Hand off|boilerplate|>3</);
  assert.match(guide.html, /kept/);
});
test('uses canonical page identity, isolated workspace and public ingestion/progress contracts', async () => {
  const corpus = [{ path: '/docs/sdk', canonicalId: 'https://docslurp.io/docs/sdk', filename: docFilename('/docs/sdk'), html: '<h1>SDK</h1>' }];
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers.Authorization, 'Bearer private-index-key');
    if (url.endsWith('/v1/ingest/bulk')) {
      // The name goes to the server, which finds the workspace or creates it on the first build.
      assert.equal(init.body.get('workspace'), 'DocSlurp documentation');
      assert.equal(init.body.get('newWorkspace'), null);
      assert.deepEqual(JSON.parse(init.body.get('canonicalIds')), ['https://docslurp.io/docs/sdk']);
      assert.equal(init.body.getAll('files')[0].name, docFilename('/docs/sdk'));
      assert.deepEqual(JSON.parse(init.body.get('pipeline')), { visionFallback: false, preserveImages: false, summarize: true });
      return Response.json({ run: { id: 'run-id' }, workspace: { id: 'docs-id' } });
    }
    assert.equal(url, 'https://docslurp.io/v1/runs/run-id/progress');
    return Response.json({ run: { id: 'run-id', status: 'completed' } });
  };
  assert.deepEqual(await indexDocs(corpus, { apiUrl: 'https://docslurp.io' }, 'private-index-key', fetchMock), { workspaceId: 'docs-id', runId: 'run-id' });
  assert.equal(calls.length, 2);
});
test('targets a configured workspace ID, slug or name and reports upstream errors without credentials', async () => {
  const sent = [];
  await assert.rejects(indexDocs([], { apiUrl: 'https://docslurp.io', workspace: 'product-manuals' }, 'secret', async (url, init) => {
    sent.push(init.body.get('workspace'));
    return new Response('secret', { status: 401 });
  }), /^Error: DocSlurp \/v1\/ingest\/bulk: HTTP 401$/);
  assert.deepEqual(sent, ['product-manuals']);
});
test('crawls only listed docs routes on the site origin and refuses redirects', async () => {
  const seen = [];
  const fetchMock = async (url, init) => {
    seen.push(url);
    assert.equal(init.redirect, 'manual');
    if (url.endsWith('/docs/moved')) return new Response(null, { status: 301, headers: { location: 'https://evil.example/' } });
    return new Response(`<title>T</title><main><h1>${new URL(url).pathname}</h1></main>`, { status: 200 });
  };
  const corpus = await crawlDocs({ site: 'https://docslurp.io/anything?x=1', routes: ['/docs/sdk', '/docs', '/docs/sdk'] }, fetchMock);
  assert.deepEqual(seen, ['https://docslurp.io/docs', 'https://docslurp.io/docs/sdk']);
  assert.equal(corpus[1].canonicalId, 'https://docslurp.io/docs/sdk');
  assert.match(corpus[1].html, /<h1>\/docs\/sdk<\/h1>/);
  await assert.rejects(crawlDocs({ site: 'https://docslurp.io', routes: ['/docs/moved'] }, fetchMock), /HTTP 301/);
  await assert.rejects(crawlDocs({ site: 'https://docslurp.io', routes: ['https://evil.example/docs'] }, fetchMock), /Invalid docs route/);
});
test('decodes Cloudflare email obfuscation so crawls are deterministic', () => {
  // Same address under two random keys, as two requests would return it.
  const encode = (email, key) => key.toString(16).padStart(2, '0') + [...email].map(c => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  const page = key => `<main><p>Mail <a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${encode('dev@docslurp.io', key)}">[email&#160;protected]</a> or <a href="/cdn-cgi/l/email-protection#${encode('x@y.io', key)}">us</a></p></main>`;
  assert.equal(extractDoc(page(0x2a)).html, extractDoc(page(0x7c)).html);
  assert.match(extractDoc(page(0x2a)).html, /Mail dev@docslurp\.io or <a href="mailto:x@y\.io">us<\/a>/);
  assert.equal(decodeCloudflareEmails('<a data-cfemail="zz">x</a>'), '<a data-cfemail="zz">x</a>');
});
