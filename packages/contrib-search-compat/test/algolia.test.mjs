import { test } from 'node:test';
import assert from 'node:assert/strict';
// `pnpm test` builds the package first; SDK's own adapter is tested separately.
const {docslurpAlgoliaClient,SearchCompatibilityError}=await import('../dist/algolia.js');
test('dedicated Algolia shim preserves v4 and v5 calls',async()=>{
  const calls=[];const client=docslurpAlgoliaClient({apiUrl:'https://example.test',clientKey:'key',fetch:async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({results:[],hits:[]});}});
  await client.initIndex('ws').search('query',{hitsPerPage:5});
  await client.search([{indexName:'ws',params:{query:'legacy',hitsPerPage:5}}]);
  await client.search({requests:[{indexName:'ws',query:'current'}]});
  assert.equal(calls[0].query,'query');assert.equal(calls[1].requests[0].query,'legacy');assert.equal(calls[2].requests[0].query,'current');
});
test('unsupported filters surface as SearchCompatibilityError, other failures stay plain errors',async()=>{
  const rejected={code:'UNSUPPORTED_SEARCH_OPTION',error:'Unsupported filter attribute "owner" in "owner:u1".',message:'Unsupported filter attribute "owner" in "owner:u1".',status:400};
  const client=docslurpAlgoliaClient({apiUrl:'https://example.test',clientKey:'key',fetch:async()=>Response.json(rejected,{status:400})});
  for(const call of [()=>client.initIndex('ws').search('q',{facetFilters:['owner:u1']}),()=>client.search({requests:[{indexName:'ws',query:'q',filters:'owner:u1'}]})]){
    await assert.rejects(call(),error=>error instanceof SearchCompatibilityError&&error.code==='UNSUPPORTED_SEARCH_OPTION'&&/owner/.test(error.message));
  }
  const failing=docslurpAlgoliaClient({apiUrl:'https://example.test',clientKey:'key',fetch:async()=>Response.json({message:'query is required'},{status:400})});
  await assert.rejects(failing.initIndex('ws').search(''),error=>!(error instanceof SearchCompatibilityError)&&/400/.test(error.message));
});
test('legacy params strings and non-plain objects throw instead of being spread',async()=>{
  let calls=0;const client=docslurpAlgoliaClient({apiUrl:'https://example.test',clientKey:'key',fetch:async()=>{calls++;return Response.json({results:[]});}});
  for(const params of ['query=q&filters=tags%3Aa',new URLSearchParams('filters=tags:a'),['tags:a'],null]){
    await assert.rejects(client.search([{indexName:'ws',params}]),SearchCompatibilityError);
  }
  assert.equal(calls,0);
});
