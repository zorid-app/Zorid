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
  const result={id:item.id,expression:item.expression,...(item.context ? {context:item.context}:{}),...(item.repeat ? {repeat:item.repeat}:{}),expected:item[expectation],expectationSource:expectation,evidence:item.evidence};
  scalarStrings(result,item.id);return result;
});
for(const id of approvedChanges) assert.ok(seen.has(id),`Approved change missing baseline case ${id}`);
const projected={schemaVersion:1,baselineRevision:baseline.baselineRevision,baselineTimezone:baseline.baselineTimezone,source:'expressions.json',approvedChangeIds:[...approvedChanges],approval:'Shared-core coordinator accepted these corrections on 2026-10-17; all other cases retain baseline behavior.',cases};
const contents=JSON.stringify(projected,null,2)+'\n';
const target=resolve(here,'accepted-expressions.json');
if(process.argv.includes('--write')) await writeFile(target,contents);
else assert.equal(await readFile(target,'utf8'),contents,'Accepted corpus is stale; review source changes and approval list before regenerating');
console.log(JSON.stringify({scope:'accepted-fixture-projection',cases:cases.length,approvedChanges:approvedChanges.size,mode:process.argv.includes('--write')?'write':'check'}));
