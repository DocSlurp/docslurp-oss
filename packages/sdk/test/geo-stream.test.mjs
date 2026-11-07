import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient } from "../dist/index.js";
test("stream preserves explicitly empty and geo filters in the body",async()=>{
 let seen;
 const client=createDocSlurpClient({apiUrl:"https://api.invalid",apiKey:"key",fetch:async(input,init)=>{seen={url:new URL(input),init};return new Response('event: done\ndata: {}\n\n',{headers:{"content-type":"text/event-stream"}});}});
 const filters={documentIds:[],geo:{field:"site",op:"radius",center:[0,0],radiusMeters:100}};
 for await(const event of client.chatStream({q:"road",filters})){}
 assert.equal(seen.init.method,"POST");
 assert.deepEqual(JSON.parse(seen.init.body).filters,filters);
 assert.equal(seen.url.search,"");
});
test("large stream filters travel in the body instead of failing before fetch",async()=>{
 let body;
 const client=createDocSlurpClient({apiUrl:"https://api.invalid",apiKey:"key",fetch:async(_input,init)=>{body=JSON.parse(init.body);return new Response('event: done\ndata: {}\n\n',{headers:{"content-type":"text/event-stream"}});}});
 for await(const event of client.chatStream({q:"road",filters:{documentIds:["x".repeat(17000)]}})){}
 assert.equal(body.filters.documentIds[0].length,17000);
});
