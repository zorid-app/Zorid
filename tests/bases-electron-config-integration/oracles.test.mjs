import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDocument} from 'yaml';
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

// The third-party YAML reader deliberately bypasses every production metadata
// parser. Check the actual emitted bytes, rather than the objects used to write
// them: a broken fixture must fail offline before it can mimic an indexing bug.
function yaml(source,label){
  const document=parseDocument(source);assert.deepEqual(document.errors,[],label);return document.toJS();
}
function frontmatter(source,label){
  assert.equal(Buffer.from(source).subarray(0,4).toString('hex'),'2d2d2d0a',label+' starts with an actual LF');
  const match=/^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);assert.ok(match,label+' has closed frontmatter');
  return {data:yaml(match[1],label),body:match[2]};
}
test('all 1017 emitted note fixtures have valid exact frontmatter and preserved bodies',()=>{
  const files=fixtureFiles();let checked=0;
  const scores=[2,2,4,1,3,4,2,5,5,3,1,2];
  for(let id=1;id<=12;id++){
    const name=`Item ${String(id).padStart(2,'0')}`,file=`Records/${name}.md`;
    const {data,body}=frontmatter(files.get(file),file);
    assert.deepEqual(data,{kind:'config',status:['Todo','Doing','Done'][(id-1)%3],score:scores[id-1],enabled:id%4!==0,priority:id%2?'High':'Low'});
    assert.equal(body,`# ${name}\n\nOriginal body ${id} stays exact.\n`);checked++;
  }
  for(let ordinal=1;ordinal<=1005;ordinal++){
    const file=`Export/Export ${String(ordinal).padStart(4,'0')}.md`;
    const {data,body}=frontmatter(files.get(file),file);
    const label=ordinal%113===0?`Quoted "${ordinal}"\tpipe | slash \\ and\nnext line`:`Label ${ordinal}`;
    assert.deepEqual(data,{kind:'export',ordinal,label});assert.equal(body,`Export body ${ordinal}.\n`);checked++;
  }
  assert.equal(checked,1017);
  assert.equal([...files.keys()].filter(file=>file.endsWith('.md')).length,checked+1,'Only the explicitly malformed fenced host is excluded');
});
test('all structured fixtures parse independently except the two labeled negative sources',()=>{
  const files=fixtureFiles();const validBases=['Configuration.base','Unknown.base','Large export.base'];
  for(const file of validBases){const data=yaml(files.get(file),file);assert.ok(Array.isArray(data.views));assert.equal(typeof data.filters==='string'||typeof data.filters==='object',true);}
  const registry=yaml(files.get('Properties.yaml'),'Properties.yaml');
  assert.deepEqual(Object.keys(registry.properties).sort(),['enabled','kind','ordinal','priority','score','status']);
  assert.equal(registry.properties.score.type,'number');assert.equal(registry.properties.enabled.type,'checkbox');
  const unknown=yaml(files.get('Unknown.base'),'Unknown.base');assert.equal(unknown.views[0].type,'future-grid');assert.deepEqual(unknown.views[0].pluginView,{future:true,amount:17});
  const invalid=files.get('Invalid.base');assert.ok(parseDocument(invalid).errors.length);
  const fence=/```base\n([\s\S]*?)\n```/.exec(files.get('Recovery host.md'));assert.ok(fence);assert.equal(fence[1]+'\n',invalid);assert.ok(parseDocument(fence[1]).errors.length);
  assert.equal(files.size,1017+validBases.length+1+2,'Every fixture is accounted for');
});
test('raw emitted export notes independently produce every expected TSV row and exact special fields',()=>{
  const files=fixtureFiles(),rows=[['file name','Ordinal','Label']];
  for(let ordinal=1;ordinal<=1005;ordinal++){
    const name=`Export ${String(ordinal).padStart(4,'0')}`,file=`Export/${name}.md`;
    const {data}=frontmatter(files.get(file),file);rows.push([name,String(data.ordinal),data.label]);
  }
  assert.deepEqual(parseDelimited(expectedTSV()),rows);
  assert.equal(rows.slice(1).reduce((sum,row)=>sum+Number(row[1]),0),505515);
  assert.equal(rows.filter(row=>row[2].includes('\n')).length,8,'All eight quoted multiline labels survive YAML and TSV');
});
