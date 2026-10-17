#!/usr/bin/env node
// Derive accepted expectations only from reviewed fixture data, never execution.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const approvedChanges=new Set(['nonfinite','unicode-length','unicode-reverse','regex-repeat']);
const baseline=JSON.parse(await readFile(resolve(here,'expressions.json'),'utf8'));
const seen=new Set();
function scalarStrings(value,path='corpus') {
  if(typeof value==='string') {
    for(let i=0;i<value.length;i++) {
      const unit=value.charCodeAt(i);
      if(unit>=0xd800 && unit<=0xdbff) {const next=value.charCodeAt(++i);assert.ok(next>=0xdc00 && next<=0xdfff,`${path}: unpaired leading surrogate`);}
      else assert.ok(unit<0xdc00 || unit>0xdfff,`${path}: unpaired trailing surrogate`);
    }
  } else if(Array.isArray(value)) value.forEach((item,index)=>scalarStrings(item,`${path}[${index}]`));
  else if(value && typeof value==='object') for(const[key,item]of Object.entries(value)) {scalarStrings(key,`${path}.key`);scalarStrings(item,`${path}.${key}`);}
}
const cases=baseline.cases.map(item=>{
  assert.ok(!seen.has(item.id),`Duplicate case ${item.id}`);seen.add(item.id);
  let expectation;
  if(item.decision==='retain') {assert.ok(!Object.hasOwn(item,'proposed'),`${item.id}: retain cannot silently carry proposed output`);expectation='current';}
  else {assert.equal(item.decision,'proposed-change',`${item.id}: unknown decision`);assert.ok(approvedChanges.has(item.id),`${item.id}: proposed change needs explicit coordinator approval in generator`);assert.ok(Object.hasOwn(item,'proposed'),`${item.id}: approved change lacks machine-readable expectation`);expectation='proposed';}
  const context=item.context ?? {};
  const request={expression:item.expression,record:{path:'a.md',properties:Object.entries(context.note ?? {})},options:{clockMs:Date.parse(context.now ?? '2024-01-15T10:20:30Z'),timezone:'UTC',maxSteps:context.maxSteps ?? 100000,formulas:Object.entries(context.formulas ?? {})}};
  const result={id:item.id,request,...(item.repeat ? {repeat:item.repeat}:{}),expected:item[expectation],expectationSource:expectation,evidence:item.evidence};
  scalarStrings(result,item.id);return result;
});
for(const id of approvedChanges) assert.ok(seen.has(id),`Approved change missing baseline case ${id}`);
const projected={schemaVersion:1,baselineRevision:baseline.baselineRevision,baselineTimezone:baseline.baselineTimezone,source:'expressions.json',approvedChangeIds:[...approvedChanges],approval:'Shared-core coordinator accepted these corrections on 2026-10-17; all other cases retain baseline behavior.',cases};
const contents=JSON.stringify(projected,null,2)+'\n';
async function publish(name,value) {
  const contents=JSON.stringify(value,null,2)+'\n';const target=resolve(here,name);
  if(process.argv.includes('--write')) await writeFile(target,contents);
  else assert.equal(await readFile(target,'utf8'),contents,`${name} is stale; review source changes and approval list before regenerating`);
}
await publish('accepted-expressions.json',projected);
const queryBaseline=JSON.parse(await readFile(resolve(here,'queries.json'),'utf8'));
const approvedQueryChanges=new Map([['default-natural-order','current'],['typed-group-keys','proposed'],['empty-or-composed','proposed'],['unsupported-link-metadata','proposed']]);
// Reviewed literal Rust canonical-key oracles, not a second canonicalizer.
// Number payloads use serde_json's f64 spelling; consumers treat every token opaque.
const acceptedGroupIds=new Map([
  ['typed-group-keys',{groups:[
    'base-key-v1:{"type":"list","value":[{"type":"number","value":1.0},{"type":"number","value":2.0}]}',
    'base-key-v1:{"type":"string","value":"2"}',
    'base-key-v1:{"type":"number","value":2.0}',
    'base-key-v1:{"type":"null"}',
  ]}],
  ['group-search-limit-pipeline',{groupOptions:[
    'base-key-v1:{"type":"string","value":"todo"}',
    'base-key-v1:{"type":"string","value":"done"}',
    'base-key-v1:{"type":"string","value":"empty"}',
    'base-key-v1:{"type":"string","value":"unlisted"}',
  ]}],
]);
const snapshotId={localStoreId:'fixture-store',generationEpoch:'fixture-epoch',generation:'1',versions:{schema:1,extraction:'zorid-markdown-1:metadata-1',resolver:'link-nfc-lower-segment-utf16-v1',query:'literal-lines-exact-v1'}};
const queryCases=queryBaseline.cases.map(item=>{
  let expectation='current';
  if(item.decision==='proposed-change'){assert.ok(approvedQueryChanges.has(item.id),`${item.id}: unapproved query proposal`);expectation=approvedQueryChanges.get(item.id);}
  else {assert.equal(item.decision,'retain');assert.ok(!Object.hasOwn(item,'proposed'),`${item.id}: retain cannot silently carry proposed output`);}
  assert.ok(Object.hasOwn(item,expectation),`${item.id}: missing accepted expectation`);
  const records=item.snapshot.files.map((file,index)=>({witness:{entryId:`fixture-${index}`,revision:'r1'},path:file.path,properties:Object.entries(file.properties ?? {}),tags:file.tags ?? [],size:file.size ?? null,ctimeMs:file.ctime ?? null,mtimeMs:file.mtime ?? null}));
  const ids=new Map(records.map(record=>[record.path,record.witness.entryId]));
  const expected=structuredClone(item[expectation]);
  if(expected.groups){const tokens=acceptedGroupIds.get(item.id)?.groups;assert.equal(tokens?.length,expected.groups.length,`${item.id}: reviewed group identity literals required`);expected.groups=expected.groups.map((group,index)=>({key:group.key,keyId:tokens[index],entryIds:group.paths.map(path=>{assert.ok(ids.has(path),`${item.id}: expected group path absent`);return ids.get(path);})}));}
  if(expected.groupOptions){const tokens=acceptedGroupIds.get(item.id)?.groupOptions;assert.equal(tokens?.length,expected.groupOptions.length,`${item.id}: reviewed option identity literals required`);expected.groupOptions=expected.groupOptions.map((option,index)=>({...option,keyId:tokens[index]}));}
  const options={searchTerms:item.options.searchTerms ?? [],evaluation:{clockMs:Date.parse('2024-01-15T10:20:30Z'),timezone:'UTC',currentRecord:records.find(record=>record.path===item.options.currentFilePath) ?? null}};
  const result={id:item.id,request:{configuration:item.document,snapshot:{snapshotId,records},options},expected,expectationSource:expectation,evidence:item.evidence};scalarStrings(result,item.id);return result;
});
await publish('accepted-queries.json',{schemaVersion:1,baselineRevision:queryBaseline.baselineRevision,source:'queries.json',approvedChangeSources:Object.fromEntries(approvedQueryChanges),cases:queryCases});
console.log(JSON.stringify({scope:'accepted-fixture-projection',expressions:cases.length,queries:queryCases.length,approvedExpressionChanges:approvedChanges.size,approvedQueryChanges:approvedQueryChanges.size,mode:process.argv.includes('--write')?'write':'check'}));
