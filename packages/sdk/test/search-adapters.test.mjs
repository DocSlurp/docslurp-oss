import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapterQuery, runSearchAdapter, createDocSlurpPagefind, createDocSlurpMeilisearchClient, createDocSlurpTypesenseClient, createDocSlurpAlgoliaClient } from '../dist/search-adapters.js';
const hits = Array.from({length: 32}, (_, i) => ({ text: `<script>unsafe ${i}</script>`, score: 1, citation: { source: 'document', documentId: `doc-${i}`, filename: 'Guide', chunkIndex: i, pageNumbers: [1], headingPath: [], blockIds: [] } }));
const response = { results: hits, sessionId: 'session', availability: null, usage: {inputTokens: 1} };
test('Meilisearch pagination maps ranked passages and keeps bounded counts explicit', async () => {
  let input;
  const r = await runSearchAdapter('meilisearch', 'ws', { q: 'guide', offset: 20, limit: 10 }, async value => { input = value; return response; });
  assert.equal(input.workspace,'ws'); assert.equal(input.limit,100);
  assert.equal(r.hits[0].id,'doc-20:20'); assert.equal(r.estimatedTotalHits,32);
  assert.equal(r.docslurp.countIsExact,false); assert.deepEqual(r.docslurp.usage,response.usage);
});
test('rejects unsupported filters and over-window pagination before calling retrieval', async () => {
  let calls=0;
  for (const [provider, params] of [['meilisearch',{q:'x',filter:'secret=true'}],['meilisearch',{q:'x',offset:90,limit:20}],['typesense',{q:'x',query_by:'title'}],['pagefind',{term:'x',filters:{role:'admin'}}]]) {
    await assert.rejects(runSearchAdapter(provider,'ws',params,async()=>{calls++;return response;}));
  }
  assert.equal(calls,0);
  assert.throws(()=>adapterQuery('typesense','ws',{q:'x',page:1.5}));
  assert.throws(()=>adapterQuery('typesense','ws',{q:'*'}));
  assert.throws(()=>adapterQuery('pagefind',undefined,{term:'x'}));
});
test('empty queries do not trigger usage; Typesense preserves nested documents', async () => {
  const empty = await runSearchAdapter('typesense','ws',{q:''},async()=>{throw Error('must not fetch')});
  assert.equal(empty.found,0);
  const r = await runSearchAdapter('typesense','ws',{q:'x',query_by:'text',page:2,per_page:10},async()=>response);
  assert.equal(r.hits[0].document.id,'doc-10:10'); assert.equal(r.page,2);
});
test('Pagefind data() resolves source metadata and HTML-escaped excerpts', async () => {
  const pagefind = createDocSlurpPagefind({apiUrl:'https://example.test',clientKey:'public',workspace:'ws',resolveUrl:hit=>`/guides/${hit.citation.documentId}`,fetch:async(url,init)=>{
    assert.equal(url,'https://example.test/v1/search');assert.equal(init.headers.Authorization,'Bearer public');return Response.json(response);
  }});
  const r=await pagefind.search('x'); const hit=await r.results[0].data();
  assert.equal(hit.url,'/guides/doc-0');assert.ok(hit.excerpt.startsWith('&lt;script&gt;'));assert.equal(hit.plain_excerpt,hits[0].text);
});
test('Meilisearch and Typesense clients preserve conventional chained calls', async () => {
  const calls=[];const opts={apiUrl:'https://example.test',clientKey:'key',fetch:async(url,init)=>{calls.push([url,JSON.parse(init.body)]);return Response.json({hits:[]})}};
  await createDocSlurpMeilisearchClient(opts).index('ws/a').search('x',{limit:5});
  await createDocSlurpTypesenseClient(opts).collections('ws').documents().search({q:'x',query_by:'text'});
  assert.ok(calls[0][0].includes('ws%2Fa')); assert.deepEqual(calls[0][1],{q:'x',limit:5});assert.ok(calls[1][0].includes('/typesense/collections/ws/'));
  await createDocSlurpTypesenseClient(opts).multiSearch.perform({searches:[{collection:'ws',q:'x'},{collection:'ws',q:'y'}]},{query_by:'text'});
  assert.ok(calls[2][0].endsWith('/typesense/multi_search'));assert.equal(calls[2][1].searches.length,2);
  await assert.rejects(createDocSlurpTypesenseClient(opts).multiSearch.perform({searches:[null]}));
});
test('Algolia accepts v4 InstantSearch arrays and v5 flattened requests', async () => {
  const calls=[];const opts={apiUrl:'https://example.test',clientKey:'key',fetch:async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({results:[]})}};
  const client=createDocSlurpAlgoliaClient(opts);
  await client.search([{indexName:'ws',params:{query:'x',hitsPerPage:5}}]);
  await client.search({requests:[{indexName:'ws',query:'y'}]});
  await client.initIndex('ws').search('z',{hitsPerPage:5});
  assert.deepEqual(calls[0],{requests:[{indexName:'ws',query:'x',hitsPerPage:5}]});assert.equal(calls[1].requests[0].query,'y');assert.equal(calls[2].query,'z');
  assert.deepEqual((await client.initIndex('ws').search('')).hits,[]);assert.equal(calls.length,3);
});
test('required query fields, Unicode and source URL failures remain explicit', async () => {
  assert.throws(() => adapterQuery('typesense', 'ws', {}), /query string is required/);
  assert.throws(() => adapterQuery('pagefind', 'ws', {}), /query string is required/);
  assert.equal(adapterQuery('typesense', 'ws', {q: '  日本語 café  '}).q, '日本語 café');
  await assert.rejects(runSearchAdapter('pagefind', 'ws', {term: 'x'}, async () => response, () => 'javascript:alert(1)'), /public source URL/);
  await assert.rejects(runSearchAdapter('pagefind', 'ws', {term: 'x'}, async () => response, () => undefined), /public source URL/);
});
test('HTTP errors propagate and invalid batch options never send a request', async () => {
  let calls = 0;
  const client = createDocSlurpTypesenseClient({apiUrl: 'https://example.test', clientKey: 'key', fetch: async () => {calls++; return new Response('rate limited', {status: 429});}});
  await assert.rejects(client.collections('ws').documents().search({q:'x'}), /429.*rate limited/);
  for (const body of [{searches:[], union:true}, {searches:Array.from({length:11}, () => ({collection:'ws',q:'x'}))}, {searches:[{collection:'ws',q:'x'}, {collection:'ws',q:'y',filter_by:'private:true'}]}]) {
    await assert.rejects(client.multiSearch.perform(body));
  }
  assert.equal(calls, 1);
});
