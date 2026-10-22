import test from 'node:test';
import assert from 'node:assert/strict';
import {q3Files,q3Groups} from '../fixtures/bases-q3-semantics.mjs';
import {files,q3LegacyDiagnostics} from './fixtures.mjs';
import {assertQ3Result,q3CommandCount} from './q3-oracles.mjs';

// Authored transport DTOs test the assertion layer only. No product evaluator,
// recorded query, or resolved query target supplies an expected value here.
function fixture(){
  const group=q3Groups.find(group=>group.baseId==='q3-provenance');
  const states=new Map([...files,...q3Files].map(file=>[file.id,{id:file.id,path:file.path,revision:'authored-'+file.id}]));
  const byPath=new Map(q3Files.map(file=>[file.path,file]));
  const typed=value=>{
    if(Array.isArray(value))return value.map(typed);
    if(value&&typeof value==='object'){
      if(value.$fixtureWitness){const file=byPath.get(value.$fixtureWitness);return{entryId:file.id,revision:states.get(file.id).revision};}
      return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typed(item)]));
    }
    return value;
  };
  const result={view:{name:group.view},counts:{returned:2},rows:group.rows.map(row=>({path:row.path,entryId:byPath.get(row.path).id,revision:states.get(byPath.get(row.path).id).revision,values:typed(row.values)})),
    summaries:typed(group.summaries),groups:group.groups.map((item,index)=>({keyId:'authored-opaque-'+index,key:typed(item.key),entryIds:item.paths.map(path=>byPath.get(path).id),summaries:typed(item.summaries)})),diagnostics:q3LegacyDiagnostics.map(issue=>({...issue}))};
  return{group,states,result};
}
test('ordinary Link raw spelling is distinct from canonical target identity and File lookup',()=>{
  const{group,states,result}=fixture();assertQ3Result(result,group,states);
  const link=group.rows[0].values['note.pointer'].value[0][1];
  assert.equal(link.path,'/Q3/Source');assert.deepEqual(link.target,{$fixtureWitness:'Q3/Source.md'});
  assert.equal(group.rows[0].values['formula.pointerFile'].value,'Q3/Source.md');
  assert.equal(q3CommandCount,40);assert.equal(q3Groups.reduce((sum,g)=>sum+g.rows.reduce((n,row)=>n+Object.keys(row.values).length,0),0),162);
});
test('canonicalized public paths, changed target witnesses and wrong raw/canonical outputs fail',()=>{
  for(const mutate of [
    row=>{row.values['note.pointer'].value[0][1].path='Q3/Source.md';},
    row=>{row.values['note.pointer'].value[0][1].target.entryId='wrong-target';},
    row=>{row.values['note.pointer'].value[0][1].target.revision='wrong-revision';},
    row=>{row.values['formula.pointerString'].value='[[Q3/Source.md]]';},
    row=>{row.values['formula.pointerRawPrefix'].value=false;},
    row=>{row.values['formula.pointerFile'].value='/Q3/Source';},
  ]){const{group,states,result}=fixture();mutate(result.rows[0]);assert.throws(()=>assertQ3Result(result,group,states));}
});
test('strict Object child provenance still requires two groups and a unique count of two',()=>{
  for(const mutate of [
    result=>{result.groups.pop();},
    result=>{result.groups[1].keyId=result.groups[0].keyId;},
    result=>{result.summaries['note.pointer'].value=1;},
    result=>{result.groups[1].entryIds=['q3-source'];},
  ]){const{group,states,result}=fixture();mutate(result);assert.throws(()=>assertQ3Result(result,group,states));}
});
