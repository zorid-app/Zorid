import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureFiles,records,exportRecords} from './fixtures.mjs';
import {rootMembership,filteredRecords,sortedRecords,expectedTSV,parseDelimited,assertLargeTSV} from './oracles.mjs';

test('fixed nested membership and multicolumn ordering include independently known ties',()=>{
  assert.deepEqual(records.filter(rootMembership).map(item=>item.id),[1,3,6,7,9,10]);
  assert.deepEqual(filteredRecords().map(item=>item.id),[1,3,6,7,9]);
  assert.deepEqual(sortedRecords([['score','DESC'],['priority','ASC']]).map(item=>item.id),[9,3,6,1,7]);
  assert.deepEqual(sortedRecords([['priority','ASC'],['score','DESC']]).map(item=>item.id),[9,3,1,7,6]);
});
test('independent TSV oracle covers all 1005 rows and quoted multiline/tab fields',()=>{
  const source=expectedTSV();assert.deepEqual(assertLargeTSV(source),{rows:1005,ordinalSum:505515});
  assert.equal(parseDelimited(source)[113][2],exportRecords[112].label);
  assert.throws(()=>assertLargeTSV(source.split('\r\n').slice(0,1000).join('\r\n')));
});
test('independent delimited parser enforces quoted fields, multiline values and rectangularity',()=>{
  assert.deepEqual(parseDelimited('name,value\r\n"a,b","quote ""yes""\nnext"',','),[['name','value'],['a,b','quote "yes"\nnext']]);
  assert.throws(()=>parseDelimited('a\tb\n"unterminated'));
  assert.throws(()=>parseDelimited('a\tb\n1'));
  assert.throws(()=>parseDelimited('"closed"suffix\tb'));
});
test('prelaunch fixtures include both malformed standalone/fenced sources and unknown renderer data',()=>{
  const files=fixtureFiles();assert.equal(files.size,12+1005+6);assert.equal(files.get('Invalid.base'),'views: [\n');
  assert.match(files.get('Recovery host.md'),/```base\nviews: \[/);assert.match(files.get('Unknown.base'),/type: future-grid/);
  for(const file of [...records,...exportRecords])assert.equal(typeof files.get(file.path),'string');
});
