import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTextCase, summarizeTextResults } from './text-model-scoring.mjs';
test('labeled correctness counts even without the required envelope', () => {
 const fixture={format:'structured',gold:{quantity:17,absent:null}};
 const score=scoreTextCase(fixture,'Result: {"quantity":17,"absent":null}');
 assert.equal(score.quality,1); assert.equal(score.formatValid,false);
 assert.equal(scoreTextCase(fixture,'quantity: 17\nabsent: null').quality,1);
});
test('an asserted denied graph edge fails quality while an explicit negative does not',()=>{
 const fixture={format:'graph',links:[['A','B']],deniedLink:['A','C']};
 const output=predicate=>JSON.stringify({entities:[],relationships:[{subject:'A',object:'B',predicate:'owns'},{subject:'A',object:'C',predicate}]});
 assert.equal(scoreTextCase(fixture,output('owns')).quality,0);
 assert.equal(scoreTextCase(fixture,output('did not acquire')).quality,1);
 assert.equal(scoreTextCase(fixture,output('did_not_acquire')).quality,1);
});
test('quoted unsafe claims are review candidates, not automatic assertions',()=>{
 const score=scoreTextCase({format:'text',facts:[['6 hours']],banned:[['service is free']]},'The target is 6 hours. The quoted note "service is free" is not a contractual term.');
 assert.equal(score.quality,1); assert.equal(score.criticalPatternMatch,true);
});
test('equivalent unit wording and explicit missing values count as correct labels',()=>{
 assert.equal(scoreTextCase({format:'text',facts:[['17 days']]},'A 17-day schedule').quality,1);
 assert.equal(scoreTextCase({format:'structured',gold:{date:null}},'{"fields":{"date":{"value":"No delivery date specified"}}}').quality,1);
});
test('empty output and errors remain in macro quality and cost of successful tasks',()=>{
 const rows=[{model:'m',arm:'a',operation:'task',latencyMs:10,scores:{quality:1,usable:true},usage:{costCents:1,metadata:{costSource:'provider'}}},
 {model:'m',arm:'a',operation:'task',latencyMs:20,error:'failed'}];
 const summary=summarizeTextResults(rows)[0];
 assert.equal(summary.qualityMacro,.5); assert.equal(summary.errors,1); assert.equal(summary.costPerUsableUsd,null);
});
