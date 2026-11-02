import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient } from "../dist/index.js";
test("stream preserves explicitly empty and geo filters",async()=>{
 let url;
 const client=createDocSlurpClient({apiUrl:"https://api.invalid",apiKey:"key",fetch:async input=>{url=new URL(input);return new Response('event: done\ndata: {}\n\n',{headers:{"content-type":"text/event-stream"}});}});
 const filters={documentIds:[],geo:{field:"site",op:"radius",center:[0,0],radiusMeters:100}};
 for await(const event of client.chatStream({q:"road",filters})){}
 assert.deepEqual(JSON.parse(url.searchParams.get("filters")),filters);
});
test("oversized stream filters fail before fetch",async()=>{
 let calls=0;
 const client=createDocSlurpClient({apiUrl:"https://api.invalid",apiKey:"key",fetch:async()=>{calls++;throw Error("unexpected fetch");}});
 await assert.rejects(async()=>{for await(const event of client.chatStream({q:"road",filters:{documentIds:["x".repeat(17000)]}})){}},/use chat\(\)/);
 assert.equal(calls,0);
});
