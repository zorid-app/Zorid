import test from 'node:test';
import assert from 'node:assert/strict';
import {planCases} from './order.mjs';
const options={sizes:[8192,524288],modes:['normal-reopen','first-folder-selection'],repetitions:3,seed:23};
test('seeded order is reproducible, changes across seeds, and covers each fresh-process case once',()=>{
 const first=planCases(options),again=planCases(options),other=planCases({...options,seed:91});
 assert.deepEqual(first,again);assert.notDeepEqual(first,other);assert.equal(first.length,12);
 assert.equal(new Set(first.map(item=>item.caseId)).size,12);
 for(const bytes of options.sizes)for(const mode of options.modes)assert.deepEqual(first.filter(item=>item.bytes===bytes&&item.mode===mode).map(item=>item.repetition).sort(),[1,2,3]);
 assert.deepEqual(options.sizes,[8192,524288]);assert.deepEqual(options.modes,['normal-reopen','first-folder-selection']);
});
test('case planning rejects unbounded repetitions, invalid seeds and duplicate matrix cells',()=>{
 for(const change of [{repetitions:0},{repetitions:6},{repetitions:1.5},{seed:-1},{seed:4294967296},{seed:NaN},{sizes:[8192,8192]},{modes:['normal-reopen','normal-reopen']}])assert.throws(()=>planCases({...options,...change}));
});
