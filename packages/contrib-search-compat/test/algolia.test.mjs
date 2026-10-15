import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Build the dedicated package before this check; SDK's own adapter is tested separately.
test('dedicated Algolia shim preserves v4 and v5 calls',async()=>{
  const source=await readFile(new URL('../src/algolia.ts',import.meta.url),'utf8');
  // Use the workspace TypeScript compiler without installing any third-party client.
  const ts=(await import('typescript')).default;
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const {docslurpAlgoliaClient}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
  const calls=[];const client=docslurpAlgoliaClient({apiUrl:'https://example.test',clientKey:'key',fetch:async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({results:[],hits:[]});}});
  await client.initIndex('ws').search('query',{hitsPerPage:5});
  await client.search([{indexName:'ws',params:{query:'legacy',hitsPerPage:5}}]);
  await client.search({requests:[{indexName:'ws',query:'current'}]});
  assert.equal(calls[0].query,'query');assert.equal(calls[1].requests[0].query,'legacy');assert.equal(calls[2].requests[0].query,'current');
});
