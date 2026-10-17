import test from "node:test";
import assert from "node:assert/strict";
const {mmrSelect} = await import(process.env.MMR_MODULE ?? "../../../server/src/search/mmr.ts");
const rows=[1,.9,.8,.7].map((score,i)=>({id:String(i),text:`passage ${i}`,score}));
test("lambda=1 preserves pure relevance without vectors",()=>{assert.deepEqual(mmrSelect(rows,2,1).map(x=>x.id),["0","1"]);});
test("missing vector diversity cannot demote relevance",()=>{assert.deepEqual(mmrSelect(rows,2,.25).map(x=>x.id),["0","1"]);});
test("genuine vectors allow diversity to avoid duplicate",()=>{const vectorRows=rows.slice(0,3).map((x,i)=>({...x,vector:i===2?[0,1]:[1,0]}));assert.deepEqual(mmrSelect(vectorRows,2,0).map(x=>x.id),["0","2"]);});
